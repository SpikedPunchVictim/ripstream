import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeText, detectEncoding } from "../src/text-encoding.ts";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

test("detects ASCII/UTF-8 text", () => {
  const result = detectEncoding(utf8("hello world"));
  assert.equal(result.binary, false);
  assert.equal(result.charset, "UTF-8");
  assert.ok(result.confidence > 0.5);
});

test("detects BOMs", () => {
  assert.equal(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])).charset, "UTF-8");
  assert.equal(detectEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0x00])).charset, "UTF-16LE");
  assert.equal(detectEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x41])).charset, "UTF-16BE");
});

test("honors HTML meta charset", () => {
  const result = detectEncoding(
    utf8('<html><head><meta charset="windows-1252"></head><body>x</body></html>'),
  );
  assert.equal(result.charset, "windows-1252");
  assert.equal(result.binary, false);
});

test("honors XML declaration encoding", () => {
  const result = detectEncoding(utf8('<?xml version="1.0" encoding="Shift_JIS"?><a/>'));
  assert.equal(result.charset, "Shift_JIS");
});

test("flags binary data", () => {
  const result = detectEncoding(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.equal(result.binary, true);
});

test("detects UTF-16 without BOM", () => {
  const text = "hello world hello world";
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++) {
    bytes[index * 2] = text.charCodeAt(index) & 0xff;
    bytes[index * 2 + 1] = 0;
  }
  assert.equal(detectEncoding(bytes).charset, "UTF-16LE");
});

test("decodes text with replacement rather than throwing", () => {
  const decoded = decodeText(new Uint8Array([0xff, 0x41]), "UTF-8");
  assert.match(decoded, /A/);
});
