import assert from "node:assert/strict";
import { test } from "node:test";
import { eofOffsets } from "../src/pdf-eof.ts";

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));
const BODY = "%PDF-1.4\n1 0 obj\n<< >>\nendobj\n";

// The expected values are what Tika 4.2.0 reported for the same shapes (tikajs-p1qx).
test("the offset is the end of %%EOF plus the end-of-line character that follows", () => {
  const head = `${BODY}startxref\n9\n`;
  assert.deepEqual(eofOffsets(bytes(`${head}%%EOF\n`)), [head.length + 6]);
  assert.deepEqual(eofOffsets(bytes(`${head}%%EOF\r\n`)), [head.length + 6]);
  assert.deepEqual(eofOffsets(bytes(`${head}%%EOF\r`)), [head.length + 6]);
  assert.deepEqual(eofOffsets(bytes(`${head}%%EOF`)), [head.length + 5]);
  assert.deepEqual(eofOffsets(bytes(`${head}%%EOF  \n`)), [head.length + 5]);
  assert.deepEqual(eofOffsets(bytes(`${head}%%EOF\n\n`)), [head.length + 6]);
});

test("whitespace between the offset and %%EOF is skipped, anything else leaves the offset where the marker was expected", () => {
  const head = `${BODY}startxref\n9`;
  assert.deepEqual(eofOffsets(bytes(`${head}\n\n \n%%EOF\n`)), [head.length + 4 + 6]);
  assert.deepEqual(eofOffsets(bytes(`${head} %%EOF\n`)), [head.length + 1 + 6]);
  assert.deepEqual(eofOffsets(bytes(`${head}\n%junk\n%%EOF\n`)), [head.length + 1]);
  assert.deepEqual(eofOffsets(bytes(`${head}\n`)), [head.length + 1]);
  assert.deepEqual(eofOffsets(bytes(`${head}\n%%eof\n`)), [head.length + 1]);
});

test("each startxref is a revision; startxref 0 and a marker with no startxref are not", () => {
  const first = `${BODY}startxref\n9\n%%EOF\n`;
  const second = `${first}2 0 obj\n<< >>\nendobj\nstartxref\n40\n%%EOF\n`;
  assert.deepEqual(eofOffsets(bytes(first)), [first.length]);
  assert.deepEqual(eofOffsets(bytes(second)), [first.length, second.length]);
  assert.deepEqual(eofOffsets(bytes(`${first}startxref\n0\n%%EOF\n`)), [first.length]);
  assert.deepEqual(eofOffsets(bytes(`${first}junk\n%%EOF\n`)), [first.length]);
  assert.deepEqual(eofOffsets(bytes(`${BODY}%%EOF\n`)), []);
  assert.deepEqual(eofOffsets(bytes(`${BODY}startxref\n`)), []);
});

test("a file of nothing but startxref keywords is bounded", () => {
  assert.equal(eofOffsets(bytes("startxref 1 ".repeat(5000))).length, 1000);
});
