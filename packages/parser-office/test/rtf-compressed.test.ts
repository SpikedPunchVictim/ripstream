import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError } from "@spikedpunch/ripstream-core";
import { decompressRtf } from "../src/rtf-compressed.ts";

// The example of MS-OXRTFCP: compressed with LZFu, it refers back into the format's 207-byte starting dictionary.
const EXAMPLE = Buffer.from(
  "2d000000 2b000000 4c5a4675 f1c5c7a7 03000a00 72637067 31323542 320af320 68656c09 00206277 05b06c64 7d0a800f a0".replaceAll(" ", ""),
  "hex",
);

const text = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : Buffer.from(bytes).toString("latin1");

test("decompresses the LZFu example of MS-OXRTFCP", () => {
  assert.equal(text(decompressRtf(EXAMPLE, 1 << 20)), "{\\rtf1\\ansi\\ansicpg1252\\pard hello world}\r\n");
});

test("returns the raw bytes of a MELA value", () => {
  const raw = Buffer.from("{\\rtf1 x}", "latin1");
  const header = Buffer.alloc(16);
  header.writeUInt32LE(raw.length + 12, 0);
  header.writeUInt32LE(raw.length, 4);
  header.write("MELA", 8, "latin1");
  assert.equal(text(decompressRtf(Buffer.concat([header, raw]), 1 << 20)), "{\\rtf1 x}");
});

test("a value of another type, or one shorter than its header, is not compressed RTF", () => {
  const unknown = Buffer.from(EXAMPLE);
  unknown.write("ABCD", 8, "latin1");
  assert.equal(decompressRtf(unknown, 1 << 20), undefined);
  assert.equal(decompressRtf(EXAMPLE.subarray(0, 15), 1 << 20), undefined);
});

test("a raw size over the limit is refused before anything is allocated", () => {
  assert.throws(() => decompressRtf(EXAMPLE, 10), LimitExceededError);
});

test("a stream cut short yields the text read so far", () => {
  const cut = decompressRtf(EXAMPLE.subarray(0, 24), 1 << 20);
  assert.ok(cut !== undefined && cut.byteLength > 0 && cut.byteLength < 43);
});
