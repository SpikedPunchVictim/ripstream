import assert from "node:assert/strict";
import { test } from "node:test";
import { StderrRing } from "../src/ring.ts";

const enc = (value: string): Uint8Array => new TextEncoder().encode(value);

test("keeps everything while under capacity", () => {
  const ring = new StderrRing(16);
  ring.push(enc("abc"));
  ring.push(enc("def"));
  assert.equal(ring.text(), "abcdef");
});

test("empty ring yields empty text", () => {
  assert.equal(new StderrRing(16).text(), "");
});

test("keeps the last bytes when pushes overflow capacity", () => {
  const ring = new StderrRing(8);
  ring.push(enc("0123456"));
  ring.push(enc("789ab"));
  assert.equal(ring.text(), "456789ab");
});

test("a single chunk larger than capacity keeps only its tail", () => {
  const ring = new StderrRing(4);
  ring.push(enc("abcdefgh"));
  assert.equal(ring.text(), "efgh");
});

test("a chunk exactly at capacity is kept whole", () => {
  const ring = new StderrRing(4);
  ring.push(enc("abcd"));
  assert.equal(ring.text(), "abcd");
});

test("empty pushes are ignored", () => {
  const ring = new StderrRing(4);
  ring.push(enc("ab"));
  ring.push(new Uint8Array(0));
  assert.equal(ring.text(), "ab");
});

test("a multi-byte code point cut at the head is dropped, not decoded as garbage", () => {
  const ring = new StderrRing(8);
  // "é" is 2 bytes; the cut falls between its two bytes.
  ring.push(enc("é1234567"));
  assert.equal(ring.text(), "1234567");
});

test("a 4-byte code point cut at the head is dropped entirely", () => {
  const ring = new StderrRing(8);
  ring.push(enc("\u{1F600}abcdefg")); // 11 bytes; the last 8 start with the final byte of the emoji
  assert.equal(ring.text(), "abcdefg");
});

test("a code point that fits completely is preserved", () => {
  const ring = new StderrRing(8);
  ring.push(enc("xx\u{1F600}yy"));
  assert.equal(ring.text(), "xx\u{1F600}yy");
});

test("leading continuation bytes are kept while nothing was truncated", () => {
  const ring = new StderrRing(8);
  ring.push(Uint8Array.of(0x80, 0x41));
  assert.equal(ring.text(), "�A");
});

test("invalid UTF-8 decodes lossily instead of throwing", () => {
  const ring = new StderrRing(8);
  ring.push(Uint8Array.of(0x41, 0xff, 0x42));
  assert.equal(ring.text(), "A�B");
});

test("never grows beyond capacity over a 100 MB-equivalent stream", () => {
  const ring = new StderrRing(8192);
  const chunk = new Uint8Array(64 * 1024).fill(0x78);
  for (let index = 0; index < 1600; index++) ring.push(chunk);
  ring.push(enc("END"));
  const text = ring.text();
  assert.equal(text.length, 8192);
  assert.ok(text.endsWith("xxEND"));
});

test("M22: 50 MB of small writes never retain or allocate more than the capacity", () => {
  const ring = new StderrRing(8192);
  const sizes = [1, 7, 100, 4096];
  let total = 0;
  let largest = 0;
  for (let index = 0; total < 50 * 1024 * 1024; index++) {
    const chunk = new Uint8Array(sizes[index % sizes.length] ?? 1).fill(0x61 + (index % 26));
    ring.push(chunk);
    total += chunk.length;
    largest = Math.max(largest, ring.retainedBytes());
    assert.equal(ring.capacityBytes, 8192);
  }
  assert.equal(largest, 8192);
  assert.equal(ring.retainedBytes(), 8192);
});

test("retainedBytes counts only what is held, below capacity too", () => {
  const ring = new StderrRing(16);
  assert.equal(ring.retainedBytes(), 0);
  ring.push(enc("hello"));
  assert.equal(ring.retainedBytes(), 5);
  ring.push(enc("x".repeat(40)));
  assert.equal(ring.retainedBytes(), 16);
});

test("uses an 8 KiB capacity by default", () => {
  const ring = new StderrRing();
  ring.push(new Uint8Array(20_000).fill(0x61));
  assert.equal(ring.text().length, 8192);
});

test("rejects a capacity too small to hold a code point", () => {
  assert.throws(() => new StderrRing(3), RangeError);
});

test("rejects a non-integer capacity", () => {
  assert.throws(() => new StderrRing(8.5), RangeError);
});
