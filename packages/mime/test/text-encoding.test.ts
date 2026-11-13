import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeText, detectEncoding } from "../src/text-encoding.ts";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

// Tika 4.2.0's MojibusterEncodingDetector answers windows-1252 for a probe that is pure ASCII (no byte >= 0x80, no NUL)
// and for one under two bytes, before it weighs any other charset. Read from the Tika source, not run against a Tika.
test("pure ASCII text is windows-1252, as Tika's detector answers it", () => {
  const result = detectEncoding(utf8("hello world"));
  assert.equal(result.binary, false);
  assert.equal(result.charset, "windows-1252");
  // 0x7f is the last ASCII byte: still ASCII.
  assert.equal(detectEncoding(new Uint8Array([0x68, 0x7f, 0x69])).charset, "windows-1252");
});

test("text with a byte over 0x7f that is valid UTF-8 is UTF-8", () => {
  const result = detectEncoding(utf8("héllo wörld"));
  assert.equal(result.binary, false);
  assert.equal(result.charset, "UTF-8");
  assert.ok(result.confidence > 0.5);
});

test("an empty or one-byte probe is windows-1252", () => {
  assert.equal(detectEncoding(new Uint8Array(0)).charset, "windows-1252");
  assert.equal(detectEncoding(new Uint8Array([0x41])).charset, "windows-1252");
  assert.equal(detectEncoding(new Uint8Array([0xe9])).charset, "windows-1252");
});

test("a declared charset still wins over the ASCII default", () => {
  assert.equal(detectEncoding(utf8('<meta charset="ISO-8859-2"><p>plain ascii</p>')).charset, "ISO-8859-2");
  assert.equal(detectEncoding(utf8('<?xml version="1.0" encoding="UTF-8"?><a>plain</a>')).charset, "UTF-8");
});

test("a BOM still wins over the ASCII default", () => {
  assert.equal(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])).charset, "UTF-8");
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

test("an ISO-2022 escape sequence selects the variant before the pure-ASCII answer", () => {
  assert.equal(detectEncoding(new Uint8Array([0x1b, 0x24, 0x42, 0x41])).charset, "ISO-2022-JP");
  assert.equal(detectEncoding(new Uint8Array([0x1b, 0x24, 0x40, 0x41])).charset, "ISO-2022-JP");
  assert.equal(detectEncoding(new Uint8Array([0x1b, 0x24, 0x29, 0x43, 0x41])).charset, "ISO-2022-KR");
  assert.equal(detectEncoding(new Uint8Array([0x1b, 0x24, 0x29, 0x41, 0x41])).charset, "ISO-2022-CN");
  assert.equal(detectEncoding(new Uint8Array([0x1b, 0x24, 0x2a, 0x48, 0x41])).charset, "ISO-2022-CN");
  // ESC ( alone is not an ISO-2022 designation; the control byte makes it binary.
  assert.equal(detectEncoding(new Uint8Array([0x1b, 0x28, 0x42, 0x41])).charset, "ISO-8859-1");
});
