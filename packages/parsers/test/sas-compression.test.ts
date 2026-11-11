import assert from "node:assert/strict";
import { test } from "node:test";
import { MalformedDocumentError, UnsupportedFormatError } from "@spikedpunch/ripstream-core";
import { rdcDecompress, rleDecompress } from "../src/sas-compression.ts";

/*
 * The two row compressions of SAS7BDAT (tikajs-68os.69): RLE ("SASYZCRL") and RDC ("SASYZCR2"). Neither algorithm is in the
 * Tika tree and no file of either kind was available: every input here is written by hand from the algorithms as they are
 * remembered from the pandas and ReadStat readers, so these tests pin what this port does, not what SAS writes.
 */

const bytes = (...values: Array<number | string>): Uint8Array =>
  Uint8Array.from(values.flatMap((value) => (typeof value === "string" ? [...value].map((char) => char.charCodeAt(0)) : [value])));
const text = (data: Uint8Array): string => Buffer.from(data).toString("latin1");

// ---- RLE ----

test("RLE 0x80 to 0xB0 copy the next 1, 17, 33 or 49 bytes, as many more as the low nibble says", () => {
  assert.equal(text(rleDecompress(bytes(0x80, "A"), 1)), "A");
  assert.equal(text(rleDecompress(bytes(0x83, "ABCD"), 4)), "ABCD");
  assert.equal(text(rleDecompress(bytes(0x90, "x".repeat(17)), 17)), "x".repeat(17));
  assert.equal(text(rleDecompress(bytes(0xa0, "y".repeat(33)), 33)), "y".repeat(33));
  assert.equal(text(rleDecompress(bytes(0xb1, "z".repeat(50)), 50)), "z".repeat(50));
});

test("RLE 0x00 copies the next 64 bytes, and the length byte after the command says how many more", () => {
  assert.equal(text(rleDecompress(bytes(0x00, 0x00, "a".repeat(64)), 64)), "a".repeat(64));
  assert.equal(text(rleDecompress(bytes(0x00, 0x03, "b".repeat(67)), 67)), "b".repeat(67));
});

test("RLE 0xC0 repeats the byte after it three times and more by the low nibble", () => {
  assert.equal(text(rleDecompress(bytes(0xc0, "A"), 3)), "AAA");
  assert.equal(text(rleDecompress(bytes(0xc2, "A"), 5)), "AAAAA");
});

test("RLE 0xD0, 0xE0 and 0xF0 insert two '@', blanks or NULs and more by the low nibble", () => {
  assert.equal(text(rleDecompress(bytes(0xd0), 2)), "@@");
  assert.equal(text(rleDecompress(bytes(0xe3), 5)), " ".repeat(5));
  assert.equal(text(rleDecompress(bytes(0xf0), 2)), "\0\0");
});

test("RLE 0x50, 0x60 and 0x70 insert 17 '@', blanks or NULs, with the low nibble times 256 and the next byte added", () => {
  assert.equal(text(rleDecompress(bytes(0x50, 0x00), 17)), "@".repeat(17));
  assert.equal(text(rleDecompress(bytes(0x60, 0x00), 17)), " ".repeat(17));
  assert.equal(text(rleDecompress(bytes(0x61, 0x02), 275)), " ".repeat(275));
  assert.equal(text(rleDecompress(bytes(0x70, 0x05), 22)), "\0".repeat(22));
});

test("RLE commands follow one another, and the output is exactly the length asked for", () => {
  assert.equal(text(rleDecompress(bytes(0x81, "ab", 0xc0, "-", 0xe0), 7)), "ab---  ");
});

test("RLE output that is shorter or longer than the length asked for is malformed", () => {
  assert.throws(() => rleDecompress(bytes(0x80, "A"), 2), MalformedDocumentError);
  assert.throws(() => rleDecompress(bytes(0x81, "AB"), 1), MalformedDocumentError);
  assert.throws(() => rleDecompress(bytes(0xd0), 1), MalformedDocumentError);
});

test("RLE input that ends inside a command is malformed", () => {
  assert.throws(() => rleDecompress(bytes(0x83, "AB"), 4), MalformedDocumentError);
  assert.throws(() => rleDecompress(bytes(0xc0), 3), MalformedDocumentError);
  assert.throws(() => rleDecompress(bytes(0x60), 17), MalformedDocumentError);
  assert.throws(() => rleDecompress(bytes(0x00), 64), MalformedDocumentError);
});

test("RLE commands 0x20 and 0x30 are not defined and are malformed", () => {
  assert.throws(() => rleDecompress(bytes(0x30, 0x00), 1), MalformedDocumentError);
});

test("RLE commands whose length the sources of this port do not agree on are unsupported, not guessed", () => {
  for (const command of [0x10, 0x20, 0x40]) {
    assert.throws(() => rleDecompress(bytes(command, 0x00, 0x41), 18), UnsupportedFormatError);
  }
  assert.throws(() => rleDecompress(bytes(0x01, 0x00), 64), UnsupportedFormatError);
});

test("RLE with a length asked for of nothing and no input is nothing", () => {
  assert.equal(rleDecompress(new Uint8Array(0), 0).length, 0);
});

test("RLE does not run past the length asked for, however much a command says", () => {
  assert.throws(() => rleDecompress(bytes(0x6f, 0xff), 100), MalformedDocumentError);
});

// ---- RDC ----

test("RDC literals follow a control word of zeros, which is two bytes, most significant first", () => {
  assert.equal(text(rdcDecompress(bytes(0x00, 0x00, "ABC"), 3)), "ABC");
});

test("RDC command 0 repeats the byte after it three times and more by the low nibble", () => {
  assert.equal(text(rdcDecompress(bytes(0x80, 0x00, 0x01, "X"), 4)), "XXXX");
});

test("RDC command 1 repeats the byte after its length byte, 19 times and the length byte times 16 more", () => {
  assert.equal(text(rdcDecompress(bytes(0x80, 0x00, 0x10, 0x01, "Y"), 35)), "Y".repeat(35));
});

test("RDC command 2 copies 16 bytes and the byte after the offset byte more, from an offset back in the output", () => {
  // ABCD, then the command at item 4 (control bit 0x0800): offset 1 + 3 = 4, count 0 + 16.
  assert.equal(text(rdcDecompress(bytes(0x08, 0x00, "ABCD", 0x21, 0x00, 0x00), 20)), "ABCD".repeat(5));
});

test("RDC commands 3 to 15 copy that many bytes from an offset back in the output", () => {
  assert.equal(text(rdcDecompress(bytes(0x08, 0x00, "ABCD", 0x31, 0x00), 7)), "ABCDABC");
  assert.equal(text(rdcDecompress(bytes(0x08, 0x00, "ABCD", 0xf1, 0x00), 19)), "ABCD" + "ABCDABCDABCDABC");
});

test("RDC offsets add the next byte times 16", () => {
  const literals = "0123456789abcdefghij"; // 20 bytes, the 21st item needs a second control word
  const stream = bytes(0x00, 0x00, literals.slice(0, 16), 0x08, 0x00, literals.slice(16), 0x31, 0x01);
  // After 20 literals, the command: offset 1 + 3 + 16 = 20 back is the start; 3 bytes copied.
  assert.equal(text(rdcDecompress(stream, 23)), literals + "012");
});

test("RDC takes a new control word after sixteen items", () => {
  const sixteen = "abcdefghijklmnop";
  assert.equal(text(rdcDecompress(bytes(0x00, 0x00, sixteen, 0x00, 0x00, "q"), 17)), sixteen + "q");
});

test("RDC output that is shorter or longer than the length asked for is malformed", () => {
  assert.throws(() => rdcDecompress(bytes(0x00, 0x00, "AB"), 3), MalformedDocumentError);
  assert.throws(() => rdcDecompress(bytes(0x00, 0x00, "ABC"), 2), MalformedDocumentError);
});

test("RDC offset that reaches before the start of the output is malformed", () => {
  assert.throws(() => rdcDecompress(bytes(0x80, 0x00, 0x31, 0x00), 3), MalformedDocumentError);
});

test("RDC input that ends inside a command or a control word is malformed", () => {
  assert.throws(() => rdcDecompress(bytes(0x80), 1), MalformedDocumentError);
  assert.throws(() => rdcDecompress(bytes(0x80, 0x00, 0x01), 4), MalformedDocumentError);
  assert.throws(() => rdcDecompress(bytes(0x08, 0x00, "ABCD", 0x21, 0x00), 20), MalformedDocumentError);
});

test("RDC with a length asked for of nothing and no input is nothing", () => {
  assert.equal(rdcDecompress(new Uint8Array(0), 0).length, 0);
});

test("RDC does not run past the length asked for, however much a command says", () => {
  assert.throws(() => rdcDecompress(bytes(0x80, 0x00, 0x1f, 0xff, "Z"), 100), MalformedDocumentError);
});

// ---- the checks on the input (mutation hardening) ----

const CUT = /ends inside a command/;

test("RLE commands that need a byte after them say the data ends inside a command when it does", () => {
  assert.throws(() => rleDecompress(bytes(0x00), 64), CUT);
  assert.throws(() => rleDecompress(bytes(0x60), 17), CUT);
  assert.throws(() => rleDecompress(bytes(0xc0), 3), CUT);
});

test("RDC commands that need bytes after them say the data ends inside a command when it does", () => {
  assert.throws(() => rdcDecompress(bytes(0x80), 1), CUT);
  assert.throws(() => rdcDecompress(bytes(0x80, 0x00, 0x00), 4), CUT);
  assert.throws(() => rdcDecompress(bytes(0x80, 0x00, 0x10, 0x01), 40), CUT);
  assert.throws(() => rdcDecompress(bytes(0x80, 0x00, 0x20, 0x01), 40), CUT);
  assert.throws(() => rdcDecompress(bytes(0x80, 0x00, 0x30), 40), CUT);
});

test("RDC data that is a control word and nothing after it has no items, and does not write a byte", () => {
  assert.equal(rdcDecompress(bytes(0x00, 0x00), 0).length, 0);
  assert.throws(() => rdcDecompress(bytes(0x00, 0x00), 1), /shorter than its row/);
});

test("RDC command 2 puts the byte after the offset byte times 16 into its distance", () => {
  const literals = "0123456789abcdefghij";
  // Four literals after the second control word, then command 0x21: offset 1 + 3 + 1 * 16 = 20 back, 0 + 16 bytes copied.
  const stream = bytes(0x00, 0x00, literals.slice(0, 16), 0x08, 0x00, literals.slice(16), 0x21, 0x01, 0x00);
  assert.equal(text(rdcDecompress(stream, 36)), literals + literals.slice(0, 16));
});
