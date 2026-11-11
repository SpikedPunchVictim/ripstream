import { LimitExceededError, MalformedDocumentError, type OutputBudget } from "@spikedpunch/ripstream-core";
import { OutputWindow } from "./output-window.ts";

/**
 * Decoder for the LZMA-alone (`.lzma`) format: a 13-byte header (properties byte, 32-bit dictionary size, 64-bit
 * uncompressed size) and one range-coded stream.
 *
 * Tika hands `application/x-lzma` to commons-compress's LZMACompressorInputStream, which wraps xz-java's
 * LZMAInputStream. Neither is in the Tika tree; this follows the published LZMA format (the LZMA SDK's LzmaSpec) and
 * what Tika's own tests show (CompressParserTest.testLZMAOOM).
 */

/** CompressorParser.Config.memoryLimitInKb: Tika's default, handed to commons-compress as the LZMA memory limit. */
export const LZMA_MEMORY_LIMIT_KIB = 100_000;

const HEADER_BYTES = 13;
const UNKNOWN_SIZE_HIGH = 0xffffffff;
/** xz-java refuses dictionaries above this (Integer.MAX_VALUE rounded down to a multiple of 16). */
const MAX_DICTIONARY_BYTES = 0x7ffffff0;

const PROB_INIT = 1024;
const STATES = 12;
const POS_STATES_MAX = 16;
const LEN_TO_POS_STATES = 4;
const END_POS_MODEL_INDEX = 14;
const FULL_DISTANCES = 128;
const ALIGN_BITS = 4;
const MATCH_MIN_LEN = 2;
const END_MARKER_DISTANCE = 0xffffffff;

// Length coder layout inside one Uint16Array: choice, choice2, low[16][8], mid[16][8], high[256].
const LEN_CHOICE = 0;
const LEN_CHOICE2 = 1;
const LEN_LOW = 2;
const LEN_MID = LEN_LOW + POS_STATES_MAX * 8;
const LEN_HIGH = LEN_MID + POS_STATES_MAX * 8;
const LEN_CODER_SIZE = LEN_HIGH + 256;

interface Properties {
  readonly lc: number;
  readonly lp: number;
  readonly pb: number;
  readonly dictionaryBytes: number;
  /** Null when the header says "unknown" and an end marker closes the stream. */
  readonly declaredSize: number | null;
}

export function decodeLzma(data: Uint8Array, budget: OutputBudget): Uint8Array {
  const properties = readHeader(data, budget);
  const decoder = new LzmaDecoder(data.subarray(HEADER_BYTES), properties, budget);
  return decoder.decode();
}

function readHeader(data: Uint8Array, budget: OutputBudget): Properties {
  if (data.byteLength < HEADER_BYTES) throw new MalformedDocumentError("Truncated LZMA header");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const propsByte = data[0]!;
  const dictionaryBytes = view.getUint32(1, true);
  if (dictionaryBytes > MAX_DICTIONARY_BYTES) {
    throw new MalformedDocumentError("LZMA dictionary is too big");
  }
  if (propsByte > (4 * 5 + 4) * 9 + 8) throw new MalformedDocumentError("Invalid LZMA properties byte");
  const lp = Math.floor((propsByte % 45) / 9);
  const lc = (propsByte % 45) - lp * 9;
  const pb = Math.floor(propsByte / 45);
  checkMemory(dictionaryBytes, lc, lp);

  const sizeLow = view.getUint32(5, true);
  const sizeHigh = view.getUint32(9, true);
  if (sizeLow === 0xffffffff && sizeHigh === UNKNOWN_SIZE_HIGH) {
    return { lc, lp, pb, dictionaryBytes, declaredSize: null };
  }
  // Signed 64-bit in xz-java: anything with the top bit set (other than all ones) is "too big".
  if (sizeHigh >= 0x80000000) throw new MalformedDocumentError("LZMA uncompressed size is too big");
  const declaredSize = sizeHigh * 2 ** 32 + sizeLow;
  if (declaredSize > budget.limit) {
    throw new LimitExceededError(`LZMA output exceeds ${budget.limit} bytes (declared ${declaredSize})`);
  }
  return { lc, lp, pb, dictionaryBytes, declaredSize };
}

/** xz-java's LZMAInputStream.getDictSize: the dictionary the header names, at least 4 KiB and a multiple of 16 bytes. */
function effectiveDictionary(dictionaryBytes: number): number {
  return Math.ceil(Math.max(dictionaryBytes, 4096) / 16) * 16;
}

/**
 * xz-java's LZMAInputStream.getMemoryUsage, which commons-compress checks against Tika's limit before decoding:
 * the dictionary (at least 4 KiB, a multiple of 16 bytes) plus the literal probabilities, in KiB. The formula is
 * reproduced from xz-java's public source as remembered, not from a file in the Tika tree.
 */
function checkMemory(dictionaryBytes: number, lc: number, lp: number): void {
  const kib = 10 + Math.floor(effectiveDictionary(dictionaryBytes) / 1024) + Math.floor((2 * 0x300 * 2 ** (lc + lp)) / 1024);
  if (kib > LZMA_MEMORY_LIMIT_KIB) {
    throw new LimitExceededError(
      `LZMA dictionary needs ${kib} KiB of memory, over the ${LZMA_MEMORY_LIMIT_KIB} KiB limit`,
    );
  }
}

class LzmaDecoder {
  readonly #input: Uint8Array;
  readonly #lc: number;
  readonly #lp: number;
  readonly #posMask: number;
  readonly #dictionaryBytes: number;
  readonly #declaredSize: number | null;

  // Range decoder.
  #inputPosition = 0;
  #range = 0xffffffff;
  #code = 0;

  // The output is also the dictionary: a distance may reach back as far as the dictionary size or the start.
  readonly #out: OutputWindow;

  readonly #isMatch = newProbs(STATES * POS_STATES_MAX);
  readonly #isRep = newProbs(STATES);
  readonly #isRepG0 = newProbs(STATES);
  readonly #isRepG1 = newProbs(STATES);
  readonly #isRepG2 = newProbs(STATES);
  readonly #isRep0Long = newProbs(STATES * POS_STATES_MAX);
  readonly #posSlot = newProbs(LEN_TO_POS_STATES * 64);
  readonly #posSpecial = newProbs(1 + FULL_DISTANCES - END_POS_MODEL_INDEX);
  readonly #align = newProbs(1 << ALIGN_BITS);
  readonly #matchLength = newProbs(LEN_CODER_SIZE);
  readonly #repLength = newProbs(LEN_CODER_SIZE);
  readonly #literal: Uint16Array;

  constructor(input: Uint8Array, properties: Properties, budget: OutputBudget) {
    this.#input = input;
    this.#lc = properties.lc;
    this.#lp = properties.lp;
    this.#posMask = (1 << properties.pb) - 1;
    this.#dictionaryBytes = effectiveDictionary(properties.dictionaryBytes);
    this.#declaredSize = properties.declaredSize;
    this.#out = new OutputWindow(budget);
    this.#literal = newProbs(0x300 << (properties.lc + properties.lp));
    this.#initRangeDecoder();
  }

  decode(): Uint8Array {
    let state = 0;
    let rep0 = 0;
    let rep1 = 0;
    let rep2 = 0;
    let rep3 = 0;

    for (;;) {
      if (this.#declaredSize !== null && this.#out.length >= this.#declaredSize) break;
      const posState = this.#out.length & this.#posMask;

      if (this.#bit(this.#isMatch, (state << 4) + posState) === 0) {
        this.#putByte(this.#decodeLiteral(state, rep0));
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }

      let length: number;
      if (this.#bit(this.#isRep, state) === 1) {
        if (this.#out.length === 0) throw new MalformedDocumentError("LZMA repeat match with no data before it");
        if (this.#bit(this.#isRepG0, state) === 0) {
          if (this.#bit(this.#isRep0Long, (state << 4) + posState) === 0) {
            // A "short rep": one byte from the last distance.
            state = state < 7 ? 9 : 11;
            this.#copyMatch(rep0, 1);
            continue;
          }
        } else {
          let distance: number;
          if (this.#bit(this.#isRepG1, state) === 0) {
            distance = rep1;
          } else {
            if (this.#bit(this.#isRepG2, state) === 0) {
              distance = rep2;
            } else {
              distance = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = distance;
        }
        length = this.#decodeLength(this.#repLength, posState);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        length = this.#decodeLength(this.#matchLength, posState);
        state = state < 7 ? 7 : 10;
        rep0 = this.#decodeDistance(length);
        if (rep0 === END_MARKER_DISTANCE) {
          // The marker closes a stream of unknown size; with a declared size it may not come early.
          if (this.#declaredSize !== null) throw new MalformedDocumentError("LZMA end marker before the declared size");
          break;
        }
      }
      this.#copyMatch(rep0, length + MATCH_MIN_LEN);
    }
    return this.#out.result();
  }

  #initRangeDecoder(): void {
    if (this.#input.byteLength < 5 || this.#input[0] !== 0) {
      throw new MalformedDocumentError("Invalid LZMA range coder start");
    }
    this.#inputPosition = 1;
    for (let index = 0; index < 4; index++) this.#code = ((this.#code << 8) | this.#nextByte()) >>> 0;
  }

  #nextByte(): number {
    if (this.#inputPosition >= this.#input.byteLength) throw new MalformedDocumentError("Truncated LZMA stream");
    return this.#input[this.#inputPosition++]!;
  }

  #normalize(): void {
    if (this.#range < 0x1000000) {
      this.#range = (this.#range << 8) >>> 0;
      this.#code = ((this.#code << 8) | this.#nextByte()) >>> 0;
    }
  }

  #bit(probs: Uint16Array, index: number): number {
    const probability = probs[index]!;
    const bound = (this.#range >>> 11) * probability;
    let result: number;
    if (this.#code < bound) {
      this.#range = bound;
      probs[index] = probability + ((2048 - probability) >> 5);
      result = 0;
    } else {
      this.#range -= bound;
      this.#code -= bound;
      probs[index] = probability - (probability >> 5);
      result = 1;
    }
    this.#normalize();
    return result;
  }

  #directBits(count: number): number {
    let result = 0;
    for (let index = 0; index < count; index++) {
      this.#range >>>= 1;
      this.#code = (this.#code - this.#range) >>> 0;
      // A set top bit means the subtraction wrapped: the bit is 0 and the code is put back.
      const wrapped = this.#code >>> 31;
      if (wrapped === 1) this.#code = (this.#code + this.#range) >>> 0;
      this.#normalize();
      result = ((result << 1) | (1 - wrapped)) >>> 0;
    }
    return result;
  }

  #bitTree(probs: Uint16Array, base: number, bits: number): number {
    let node = 1;
    for (let index = 0; index < bits; index++) node = (node << 1) | this.#bit(probs, base + node);
    return node - (1 << bits);
  }

  #reverseBitTree(probs: Uint16Array, base: number, bits: number): number {
    let node = 1;
    let result = 0;
    for (let index = 0; index < bits; index++) {
      const bit = this.#bit(probs, base + node);
      node = (node << 1) | bit;
      result |= bit << index;
    }
    return result;
  }

  #decodeLength(probs: Uint16Array, posState: number): number {
    if (this.#bit(probs, LEN_CHOICE) === 0) return this.#bitTree(probs, LEN_LOW + (posState << 3), 3);
    if (this.#bit(probs, LEN_CHOICE2) === 0) return 8 + this.#bitTree(probs, LEN_MID + (posState << 3), 3);
    return 16 + this.#bitTree(probs, LEN_HIGH, 8);
  }

  #decodeDistance(length: number): number {
    const lengthState = Math.min(length, LEN_TO_POS_STATES - 1);
    const slot = this.#bitTree(this.#posSlot, lengthState << 6, 6);
    if (slot < 4) return slot;
    const directBits = (slot >> 1) - 1;
    let distance = ((2 | (slot & 1)) << directBits) >>> 0;
    if (slot < END_POS_MODEL_INDEX) {
      return (distance + this.#reverseBitTree(this.#posSpecial, distance - slot, directBits)) >>> 0;
    }
    distance = (distance + this.#directBits(directBits - ALIGN_BITS) * (1 << ALIGN_BITS)) >>> 0;
    return (distance + this.#reverseBitTree(this.#align, 0, ALIGN_BITS)) >>> 0;
  }

  #decodeLiteral(state: number, rep0: number): number {
    const previous = this.#out.length === 0 ? 0 : this.#out.byteBack(0);
    const context = ((this.#out.length & ((1 << this.#lp) - 1)) << this.#lc) + (previous >> (8 - this.#lc));
    const base = 0x300 * context;
    let symbol = 1;
    if (state >= 7) {
      // After a match the literal is coded against the byte the last distance points at, until they differ.
      let matchByte = this.#out.byteBack(rep0);
      while (symbol < 0x100) {
        const matchBit = (matchByte >> 7) & 1;
        matchByte <<= 1;
        const bit = this.#bit(this.#literal, base + ((1 + matchBit) << 8) + symbol);
        symbol = (symbol << 1) | bit;
        if (matchBit !== bit) break;
      }
    }
    while (symbol < 0x100) symbol = (symbol << 1) | this.#bit(this.#literal, base + symbol);
    return symbol & 0xff;
  }

  #putByte(value: number): void {
    this.#out.put(value);
  }

  #copyMatch(distance: number, length: number): void {
    // The distance counts back from the last byte; it may not pass the start of the output or the dictionary size.
    if (distance >= this.#dictionaryBytes || distance >= this.#out.length) {
      throw new MalformedDocumentError("LZMA match distance is beyond the data");
    }
    if (this.#declaredSize !== null && this.#out.length + length > this.#declaredSize) {
      throw new MalformedDocumentError("LZMA match runs past the declared size");
    }
    this.#out.copy(distance, length);
  }
}

function newProbs(size: number): Uint16Array {
  return new Uint16Array(size).fill(PROB_INIT);
}
