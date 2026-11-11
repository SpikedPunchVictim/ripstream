import { MalformedDocumentError, type OutputBudget } from "@spikedpunch/ripstream-core";
import { OutputWindow } from "./output-window.ts";

/*
 * Deflate64 ("enhanced deflate", PKWARE appnote 4.4.5 and the ZIP method 9): RFC 1951 with three changes. The window
 * is 64 KiB, length code 285 is 3 + 16 extra bits (3..65538) instead of the fixed 258, and distance codes 30 and 31
 * exist (14 extra bits, bases 32769 and 49153). Block framing, stored blocks and the dynamic-table layout are
 * unchanged. This is the public format; Tika reaches it only through commons-compress, which is not read here.
 *
 * The decoder follows zlib's puff.c: canonical Huffman codes read a bit at a time, which is slow but small and has no
 * table whose size a hostile stream could choose.
 */

const MAX_BITS = 15;
const MAX_LITERAL_CODES = 286;
const MAX_DISTANCE_CODES = 32;
const END_OF_BLOCK = 256;
const LONG_LENGTH_SYMBOL = 285;

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227,
] as const;
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5,
] as const;
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577, 32769, 49153,
] as const;
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14,
] as const;
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15] as const;

const truncated = (): MalformedDocumentError => new MalformedDocumentError("Deflate64 stream is truncated");

/** Reads bits least significant first; never holds more than the bits of one partly used byte. */
class BitReader {
  readonly #data: Uint8Array;
  #position = 0;
  #buffer = 0;
  #count = 0;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  /** Up to 16 bits. */
  bits(wanted: number): number {
    while (this.#count < wanted) {
      if (this.#position >= this.#data.byteLength) throw truncated();
      this.#buffer |= this.#data[this.#position++]! << this.#count;
      this.#count += 8;
    }
    const value = this.#buffer & ((1 << wanted) - 1);
    this.#buffer >>>= wanted;
    this.#count -= wanted;
    return value;
  }

  /** Drops the rest of the current byte. `bits` stops reading as soon as it has enough, so fewer than 8 are held. */
  alignToByte(): void {
    this.#buffer = 0;
    this.#count = 0;
  }

  /** Whole bytes, after `alignToByte`. */
  takeBytes(length: number): Uint8Array {
    if (length > this.#data.byteLength - this.#position) throw truncated();
    const bytes = this.#data.subarray(this.#position, this.#position + length);
    this.#position += length;
    return bytes;
  }
}

/** A canonical Huffman code: how many symbols have each length, and the symbols in code order. */
interface HuffmanCode {
  readonly counts: Uint16Array;
  readonly symbols: Uint16Array;
}

/**
 * Builds the code for a list of code lengths. An over-subscribed code is refused. An incomplete one is refused too,
 * except what zlib also allows: no codes at all (it fails only if a symbol is read), or, when `allowIncomplete`, a
 * single code of length 1 (a block with one distance code).
 */
function buildCode(lengths: Uint8Array, allowIncomplete: boolean): HuffmanCode {
  const counts = new Uint16Array(MAX_BITS + 1);
  for (const length of lengths) counts[length] = counts[length]! + 1;

  let left = 1;
  for (let length = 1; length <= MAX_BITS; length++) {
    left = left * 2 - counts[length]!;
    if (left < 0) throw new MalformedDocumentError("Deflate64 Huffman code is over-subscribed");
  }
  const used = lengths.length - counts[0]!;
  const singleCode = allowIncomplete && used === 1 && counts[1] === 1;
  if (left > 0 && used > 0 && !singleCode) throw new MalformedDocumentError("Deflate64 Huffman code is incomplete");

  const offsets = new Uint16Array(MAX_BITS + 2);
  for (let length = 1; length <= MAX_BITS; length++) offsets[length + 1] = offsets[length]! + counts[length]!;
  const symbols = new Uint16Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!;
    if (length === 0) continue;
    symbols[offsets[length]!] = symbol;
    offsets[length] = offsets[length]! + 1;
  }
  return { counts, symbols };
}

function decodeSymbol(reader: BitReader, code: HuffmanCode): number {
  let first = 0;
  let index = 0;
  let value = 0;
  for (let length = 1; length <= MAX_BITS; length++) {
    value |= reader.bits(1);
    const count = code.counts[length]!;
    if (value - count < first) return code.symbols[index + (value - first)]!;
    index += count;
    first += count;
    first <<= 1;
    value <<= 1;
  }
  throw new MalformedDocumentError("Deflate64 stream holds a bit pattern that is not a Huffman code");
}

function fixedLiteralLengths(): Uint8Array {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  return lengths;
}

const FIXED_LITERALS = buildCode(fixedLiteralLengths(), false);
// Deflate64 has all 32 distance codes, where deflate's fixed table stops at 30.
const FIXED_DISTANCES = buildCode(new Uint8Array(MAX_DISTANCE_CODES).fill(5), false);

interface BlockCodes {
  readonly literals: HuffmanCode;
  readonly distances: HuffmanCode;
}

function readDynamicCodes(reader: BitReader): BlockCodes {
  const literalCount = reader.bits(5) + 257;
  const distanceCount = reader.bits(5) + 1;
  const codeLengthCount = reader.bits(4) + 4;
  if (literalCount > MAX_LITERAL_CODES) throw new MalformedDocumentError("Deflate64 block declares too many literal codes");

  const codeLengthLengths = new Uint8Array(19);
  for (let index = 0; index < codeLengthCount; index++) codeLengthLengths[CODE_LENGTH_ORDER[index]!] = reader.bits(3);
  const codeLengthCode = buildCode(codeLengthLengths, false);

  const lengths = new Uint8Array(literalCount + distanceCount);
  let index = 0;
  while (index < lengths.length) {
    const symbol = decodeSymbol(reader, codeLengthCode);
    if (symbol < 16) {
      lengths[index++] = symbol;
      continue;
    }
    let repeated = 0;
    let repeat: number;
    if (symbol === 16) {
      if (index === 0) throw new MalformedDocumentError("Deflate64 code lengths repeat a length that is not there");
      repeated = lengths[index - 1]!;
      repeat = 3 + reader.bits(2);
    } else if (symbol === 17) {
      repeat = 3 + reader.bits(3);
    } else {
      repeat = 11 + reader.bits(7);
    }
    if (index + repeat > lengths.length) throw new MalformedDocumentError("Deflate64 code lengths overrun the table");
    lengths.fill(repeated, index, index + repeat);
    index += repeat;
  }
  if (lengths[END_OF_BLOCK] === 0) throw new MalformedDocumentError("Deflate64 block has no end-of-block code");

  return {
    literals: buildCode(lengths.subarray(0, literalCount), true),
    distances: buildCode(lengths.subarray(literalCount), true),
  };
}

function copyStoredBlock(reader: BitReader, out: OutputWindow): void {
  reader.alignToByte();
  const length = reader.bits(16);
  const complement = reader.bits(16);
  if ((length ^ complement) !== 0xffff) throw new MalformedDocumentError("Deflate64 stored block length is corrupt");
  out.write(reader.takeBytes(length));
}

function inflateBlock(reader: BitReader, out: OutputWindow, codes: BlockCodes): void {
  for (;;) {
    const symbol = decodeSymbol(reader, codes.literals);
    if (symbol < END_OF_BLOCK) {
      out.put(symbol);
      continue;
    }
    if (symbol === END_OF_BLOCK) return;
    if (symbol > LONG_LENGTH_SYMBOL) throw new MalformedDocumentError("Deflate64 stream uses a length code that does not exist");
    const length =
      symbol === LONG_LENGTH_SYMBOL
        ? 3 + reader.bits(16)
        : LENGTH_BASE[symbol - 257]! + reader.bits(LENGTH_EXTRA[symbol - 257]!);
    const slot = decodeSymbol(reader, codes.distances);
    const distance = DISTANCE_BASE[slot]! + reader.bits(DISTANCE_EXTRA[slot]!);
    out.copy(distance - 1, length);
  }
}

/**
 * Decodes a raw Deflate64 stream (no header, no checksum). Every byte written is counted against `budget` before it
 * is stored, so a stream that expands past the cap fails with LimitExceededError. A stream that stops early, uses a
 * code that does not exist or points before its first byte fails with MalformedDocumentError. Bytes after the final
 * block are ignored, as a ZIP entry's compressed data is cut to its declared size before it gets here.
 */
export function decodeDeflate64(data: Uint8Array, budget: OutputBudget): Uint8Array {
  const reader = new BitReader(data);
  const out = new OutputWindow(budget);
  let final = false;
  while (!final) {
    final = reader.bits(1) === 1;
    const type = reader.bits(2);
    if (type === 0) copyStoredBlock(reader, out);
    else if (type === 1) inflateBlock(reader, out, { literals: FIXED_LITERALS, distances: FIXED_DISTANCES });
    else if (type === 2) inflateBlock(reader, out, readDynamicCodes(reader));
    else throw new MalformedDocumentError("Deflate64 block type 3 is reserved");
  }
  return out.result();
}
