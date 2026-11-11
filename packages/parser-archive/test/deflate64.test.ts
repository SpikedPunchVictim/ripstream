import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";
import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { Deflate64Parser } from "../src/index.ts";
import { boundedContext, runParser, type Captured } from "./stream-helpers.ts";

// Deflate64 is Deflate with a 64 KiB window: length code 285 is 3 + 16 extra bits (3..65538) instead of 258, and
// distance codes 30 and 31 (14 extra bits, bases 32769 and 49153) exist. No Deflate64 encoder is available here, so
// the 64K-specific streams are written by the small fixed-Huffman encoder below, from the PKWARE appnote's tables;
// standard deflate output from node:zlib covers stored and dynamic blocks, which both formats share.

class BitWriter {
  readonly #bytes: number[] = [];
  #current = 0;
  #count = 0;

  /** LSB first, as deflate packs everything except Huffman codes. */
  bits(value: number, count: number): void {
    for (let index = 0; index < count; index++) this.#bit((value >> index) & 1);
  }

  /** Huffman codes are packed MSB first. */
  code(value: number, length: number): void {
    for (let index = length - 1; index >= 0; index--) this.#bit((value >> index) & 1);
  }

  #bit(bit: number): void {
    this.#current |= bit << this.#count;
    if (++this.#count === 8) {
      this.#bytes.push(this.#current);
      this.#current = 0;
      this.#count = 0;
    }
  }

  finish(): Uint8Array {
    if (this.#count > 0) this.#bytes.push(this.#current);
    return Uint8Array.from(this.#bytes);
  }
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 32769, 49153];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14];

/** One fixed-Huffman block (BTYPE 01) built from literals and matches. */
class FixedBlock {
  readonly #writer = new BitWriter();

  constructor(final = true) {
    this.#writer.bits(final ? 1 : 0, 1);
    this.#writer.bits(1, 2);
  }

  #symbol(symbol: number): void {
    if (symbol < 144) this.#writer.code(0x30 + symbol, 8);
    else if (symbol < 256) this.#writer.code(0x190 + symbol - 144, 9);
    else if (symbol < 280) this.#writer.code(symbol - 256, 7);
    else this.#writer.code(0xc0 + symbol - 280, 8);
  }

  literal(value: number): this {
    this.#symbol(value);
    return this;
  }

  /** Any symbol of the fixed table, including 286 and 287, which name no length. */
  symbol(value: number): this {
    this.#symbol(value);
    return this;
  }

  match(length: number, distance: number): this {
    if (length <= 258) {
      let index = LENGTH_BASE.length - 1;
      while (LENGTH_BASE[index]! > length) index--;
      this.#symbol(257 + index);
      this.#writer.bits(length - LENGTH_BASE[index]!, LENGTH_EXTRA[index]!);
    } else {
      this.#symbol(285);
      this.#writer.bits(length - 3, 16);
    }
    let slot = DISTANCE_BASE.length - 1;
    while (DISTANCE_BASE[slot]! > distance) slot--;
    this.#writer.code(slot, 5);
    this.#writer.bits(distance - DISTANCE_BASE[slot]!, DISTANCE_EXTRA[slot]!);
    return this;
  }

  end(): Uint8Array {
    this.#symbol(256);
    return this.#writer.finish();
  }
}

function pseudoRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let seed = 12345;
  for (let index = 0; index < length; index++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    bytes[index] = seed >>> 24;
  }
  return bytes;
}

/** The decoded bytes the parser hands on; the 100,000-byte output cap applies and the ratio check is off. */
async function decode(bytes: Uint8Array): Promise<Uint8Array> {
  const captured: Captured[] = [];
  await runParser(new Deflate64Parser(), bytes, boundedContext(captured));
  assert.equal(captured.length, 1);
  // The capturing parser hands over a Buffer; deepStrictEqual compares prototypes.
  return new Uint8Array(captured[0]!.bytes);
}

test("Deflate64Parser claims application/deflate64, the type Tika's CompressorParser claims", () => {
  const types = [...new Deflate64Parser().getSupportedTypes()].map((type) => type.toString());
  assert.deepEqual(types, ["application/deflate64"]);
});

test("decodes literals and a short match", async () => {
  const stream = new FixedBlock().literal(0x61).literal(0x62).match(6, 2).end();
  assert.equal(new TextDecoder().decode(await decode(stream)), "abababab");
});

test("length code 285 carries 16 extra bits: a 40000-byte match", async () => {
  const stream = new FixedBlock().literal(0x61).match(40_000, 1).end();
  const out = await decode(stream);
  assert.equal(out.byteLength, 40_001);
  assert.ok(out.every((byte) => byte === 0x61));
});

test("length 258 is code 284 with extra bits 31, not code 285", async () => {
  const stream = new FixedBlock().literal(0x78).match(258, 1).end();
  assert.equal((await decode(stream)).byteLength, 259);
});

test("distance code 30 reaches back past 32 KiB", async () => {
  const data = pseudoRandom(40_000);
  const block = new FixedBlock();
  for (const byte of data) block.literal(byte);
  const out = await decode(block.match(100, 40_000).end());
  assert.deepEqual(out.subarray(0, 40_000), data);
  assert.deepEqual(out.subarray(40_000), data.subarray(0, 100));
});

test("distance code 31 reaches back to the whole 64 KiB window", async () => {
  const data = pseudoRandom(65_536);
  const block = new FixedBlock();
  for (const byte of data) block.literal(byte);
  const out = await decode(block.match(50, 65_536).end());
  assert.deepEqual(out.subarray(65_536), data.subarray(0, 50));
});

test("stored and dynamic blocks decode as in plain deflate", async () => {
  const text = new TextEncoder().encode(
    Array.from({ length: 400 }, (_, index) => `word${(index * 7919) % 613} line ${index}`).join("\n"),
  );
  assert.deepEqual(await decode(deflateRawSync(text, { level: 6 })), text);
  assert.deepEqual(await decode(deflateRawSync(text, { level: 0 })), text);
});

test("a match before the start of the output is refused as malformed", async () => {
  await assert.rejects(decode(new FixedBlock().literal(0x61).match(3, 2).end()), MalformedDocumentError);
});

test("a distance from code 31 that reaches before the first byte is refused as malformed", async () => {
  await assert.rejects(decode(new FixedBlock().literal(0x61).match(3, 60_000).end()), MalformedDocumentError);
});

test("block type 3 is refused as malformed", async () => {
  await assert.rejects(decode(Uint8Array.from([0x07])), MalformedDocumentError);
});

test("a stored block whose length does not match its complement is refused as malformed", async () => {
  await assert.rejects(decode(Uint8Array.from([0x01, 0x05, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5])), MalformedDocumentError);
});

test("every strict prefix of a stream parses or is refused as malformed", { timeout: 60_000 }, async () => {
  const valid = new FixedBlock().literal(0x61).literal(0x62).match(300, 2).match(100, 40).end();
  for (let length = 0; length < valid.byteLength; length++) {
    try {
      await decode(valid.subarray(0, length));
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix of ${length} bytes: ${String(error)}`);
    }
  }
});

/** Why the decoder refused `bytes`: the parser wraps the decoder's error as the cause of its MalformedDocumentError. */
async function refusalReason(bytes: Uint8Array): Promise<string> {
  try {
    await decode(bytes);
  } catch (error) {
    assert.ok(error instanceof MalformedDocumentError);
    return (error.cause as Error).message;
  }
  return "was not refused";
}

/** A final dynamic block whose header gives the four first code-length codes (symbols 16, 17, 18, 0) these lengths. */
function dynamicHeader(lengthsFor16_17_18_0: readonly number[]): Uint8Array {
  const writer = new BitWriter();
  writer.bits(1, 1);
  writer.bits(2, 2);
  writer.bits(0, 5);
  writer.bits(0, 5);
  writer.bits(0, 4);
  for (const length of lengthsFor16_17_18_0) writer.bits(length, 3);
  // Padding so that running out of input is not what stops the decoder.
  writer.bits(0, 16);
  return writer.finish();
}

/**
 * A final dynamic block with `literalCodes` literal codes and one distance code, whose code-length code has only
 * symbols 0 and `other` (16 or 18), each of one bit: 0 is the code `0` and `other` the code `1`. `body` writes the
 * code-length symbols that follow, as a list of [code, extraBits, extraValue].
 */
function dynamicBlock(literalCodes: number, other: 16 | 18, body: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
  const writer = new BitWriter();
  writer.bits(1, 1);
  writer.bits(2, 2);
  writer.bits(literalCodes - 257, 5);
  writer.bits(0, 5);
  writer.bits(0, 4);
  // The first four of the transmitted order are symbols 16, 17, 18 and 0.
  for (const length of [other === 16 ? 1 : 0, 0, other === 18 ? 1 : 0, 1]) writer.bits(length, 3);
  for (const [code, extraBits, extraValue] of body) {
    writer.code(code, 1);
    writer.bits(extraValue, extraBits);
  }
  writer.bits(0, 16);
  return writer.finish();
}

test("a block that declares more than 286 literal codes is refused, and one of 286 is not refused for that", async () => {
  assert.match(await refusalReason(dynamicBlock(287, 18, [])), /too many literal codes/);
  assert.doesNotMatch(await refusalReason(dynamicBlock(286, 18, [])), /too many literal codes/);
});

test("a repeat of the previous length with no previous length is refused as malformed", async () => {
  // Code-length symbol 16 (code 1) as the very first symbol: repeat 3 + 0 times.
  assert.match(await refusalReason(dynamicBlock(257, 16, [[1, 2, 0]])), /repeat a length that is not there/);
});

test("code lengths that run one past the table are refused, and ones that fill it are not", async () => {
  // 257 literal codes + 1 distance code = 258 lengths. Symbol 18 repeats 11 + 7 bits zeros: 138 then 120 fill it.
  assert.match(await refusalReason(dynamicBlock(257, 18, [[1, 7, 127], [1, 7, 110]])), /overrun the table/);
  assert.doesNotMatch(await refusalReason(dynamicBlock(257, 18, [[1, 7, 127], [1, 7, 109]])), /overrun the table/);
});

test("a dynamic block with no end-of-block code is refused as malformed", async () => {
  // 258 zero lengths: no literal, no end-of-block, no distance.
  assert.match(await refusalReason(dynamicBlock(257, 18, [[1, 7, 127], [1, 7, 109]])), /no end-of-block code/);
});

test("fixed-table symbols 286 and 287 name no length and are refused as malformed", async () => {
  for (const symbol of [286, 287]) {
    const reason = await refusalReason(new FixedBlock().literal(0x61).symbol(symbol).end());
    assert.match(reason, /length code that does not exist/, String(symbol));
  }
});

test("a code-length code with more codes than its lengths allow is refused as over-subscribed", async () => {
  assert.match(await refusalReason(dynamicHeader([1, 1, 1, 1])), /over-subscribed/);
});

test("a code-length code that leaves bit patterns unused is refused as incomplete", async () => {
  assert.match(await refusalReason(dynamicHeader([0, 0, 0, 1])), /incomplete/);
});

test("a stream that stops before its end-of-block code is refused as malformed", async () => {
  // 3 header bits + 2 literals (16) + one match (29) = 48 bits: the end-of-block code is the 7 bits of the last byte.
  const valid = new FixedBlock().literal(0x61).literal(0x62).match(300, 2).end();
  assert.equal(valid.byteLength, 7);
  await assert.rejects(decode(valid.subarray(0, 6)), MalformedDocumentError);
});

test("a flipped byte anywhere in a dynamic-Huffman stream parses or is refused, within the output cap", { timeout: 60_000 }, async () => {
  const text = new TextEncoder().encode(
    Array.from({ length: 200 }, (_, index) => `item${(index * 31) % 97} value ${index}`).join("\n"),
  );
  const valid = deflateRawSync(text);
  for (let position = 0; position < valid.byteLength; position++) {
    const damaged = valid.slice();
    damaged[position] = damaged[position]! ^ 0xff;
    try {
      await runParser(new Deflate64Parser(), damaged, boundedContext());
    } catch (error) {
      assert.ok(
        error instanceof MalformedDocumentError || error instanceof LimitExceededError,
        `byte ${position}: ${String(error)}`,
      );
    }
  }
});

test("a Deflate64 bomb fails with LimitExceededError at the output cap", async () => {
  // Each 65538-byte match costs 29 bits, about 18,000:1; the cap is 100,000 bytes.
  const block = new FixedBlock().literal(0x30);
  for (let index = 0; index < 20; index++) block.match(65_538, 1);
  await assert.rejects(
    runParser(new Deflate64Parser(), block.end(), boundedContext()),
    // The decoder's own budget must trip, not a later check.
    (error: unknown) => error instanceof LimitExceededError && /Deflate64Parser output exceeds 100000 bytes/.test(error.message),
  );
});
