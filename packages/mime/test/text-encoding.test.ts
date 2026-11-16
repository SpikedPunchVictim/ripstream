import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeText, detectEncoding } from "../src/text-encoding.ts";
import { DefaultDetector } from "../src/index.ts";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";

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

test("binary-looking bytes that are valid UTF-8 are UTF-8, as Tika 4.2.0 has them", () => {
  const result = detectEncoding(utf8("Polarization ( \u03a9 ) | \u0000 0.9393 |\n"));
  assert.equal(result.charset, "UTF-8");
  assert.equal(result.binary, true);
});

test("binary-looking bytes that are not valid UTF-8 stay ISO-8859-1", () => {
  assert.equal(detectEncoding(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a])).charset, "ISO-8859-1");
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
  // ESC ( alone is not an ISO-2022 designation (it is the single-byte one, in every variant): the text is not ISO-2022,
  // and ESC is a safe control byte, so it is no longer binary either.
  const single = detectEncoding(new Uint8Array([0x1b, 0x28, 0x42, 0x41]));
  assert.equal(single.charset, "windows-1252");
  assert.equal(single.binary, false);
});

// ---- what is text, apart from which charset it is in -------------------------------------------------------------------

const ascii = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "latin1"));
const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(Buffer.concat(parts));

test("bytes with an ISO-2022 escape in them are not text for that", () => {
  // 1B 24 42 is `ESC $ B`, and a NUL says the rest is not text.
  const data = concat(new Uint8Array([0x00, 0x01, 0x02, 0x1b, 0x24, 0x42, 0x00, 0x03, 0x04, 0x00]), new Uint8Array(200));
  assert.equal(detectEncoding(data).binary, true);
});

test("bytes that happen to hold a charset declaration are not text for that", () => {
  const data = concat(ascii('<meta charset="utf-8">'), new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03, 0x00, 0x00, 0x04]), new Uint8Array(100));
  assert.equal(detectEncoding(data).binary, true);
  assert.equal(detectEncoding(concat(ascii('<?xml version="1.0" encoding="UTF-8"?>'), new Uint8Array(100))).binary, true);
});

test("real ISO-2022-JP text, dense in ESC, is text and is ISO-2022-JP", () => {
  const jis = concat(ascii("\x1b$B"), new Uint8Array([0x33, 0x2b, 0x46, 0x7c]), ascii("\x1b(B"));
  const result = detectEncoding(jis);
  assert.equal(result.charset, "ISO-2022-JP");
  assert.equal(result.binary, false);
});

test("an ANSI-coloured log and a text with form feeds are text", () => {
  assert.equal(detectEncoding(ascii("\x1b[31mERR\x1b[0m x\n".repeat(50))).binary, false);
  assert.equal(detectEncoding(ascii("page one\f".repeat(30))).binary, false);
});

test("a charset the bytes cannot be in is read as UTF-8: a page that says utf-16 in 8-bit text", () => {
  assert.equal(detectEncoding(utf8('<meta charset="utf-16"><p>plain ascii text, one byte each</p>')).charset, "UTF-8");
  assert.equal(detectEncoding(utf8('<meta http-equiv="Content-Type" content="text/html; charset=UTF-16LE"><p>plain</p>')).charset, "UTF-8");
  assert.equal(detectEncoding(utf8('<?xml version="1.0" encoding="UTF-16"?><a>plain</a>')).charset, "UTF-8");
  assert.equal(detectEncoding(utf8('<meta charset="utf-32"><p>plain</p>')).charset, "UTF-8");
});

test("a sample cut in the middle of a UTF-8 character is still UTF-8", () => {
  const whole = utf8("a".repeat(65_535) + "\u00e9");
  const cut = whole.subarray(0, whole.length - 1); // the lead byte of the e-acute, and not its second
  assert.equal(detectEncoding(cut).charset, "UTF-8");
  const three = utf8("a".repeat(65_534) + "\u20ac").subarray(0, 65_536); // two of the euro sign's three bytes
  assert.equal(detectEncoding(three).charset, "UTF-8");
  // A byte that is wrong in the middle is still not UTF-8.
  assert.notEqual(detectEncoding(concat(ascii("a".repeat(100)), new Uint8Array([0xe9, 0x41]))).charset, "UTF-8");
});

test("UTF-32 text is decoded as UTF-32, with its BOM left out", () => {
  const units = [0x68, 0x69, 0x1f600, 0x20ac];
  const le = new Uint8Array(4 + units.length * 4);
  const be = new Uint8Array(4 + units.length * 4);
  le.set([0xff, 0xfe, 0x00, 0x00]);
  be.set([0x00, 0x00, 0xfe, 0xff]);
  units.forEach((unit, index) => {
    new DataView(le.buffer).setUint32(4 + index * 4, unit, true);
    new DataView(be.buffer).setUint32(4 + index * 4, unit, false);
  });
  assert.equal(detectEncoding(le).charset, "UTF-32LE");
  assert.equal(detectEncoding(be).charset, "UTF-32BE");
  assert.equal(decodeText(le, "UTF-32LE"), "hi\u{1f600}\u20ac");
  assert.equal(decodeText(be, "UTF-32BE"), "hi\u{1f600}\u20ac");
  assert.equal(decodeText(be, "utf-32"), "hi\u{1f600}\u20ac", "no byte order named: the BOM says it");
  // A code point out of range, a surrogate and a cut-off unit are each one replacement character.
  const odd = new Uint8Array(13);
  new DataView(odd.buffer).setUint32(0, 0x110000, true);
  new DataView(odd.buffer).setUint32(4, 0xd800, true);
  new DataView(odd.buffer).setUint32(8, 0x41, true);
  odd[12] = 0x42;
  assert.equal(decodeText(odd, "UTF-32LE"), "\ufffd\ufffdA\ufffd");
});

test("the detector does not call random bytes text because they hold an ESC $ pair", async () => {
  const detector = new DefaultDetector();
  const bytes = new Uint8Array(4096);
  let seed = 12345;
  for (let index = 0; index < bytes.length; index++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = (seed >> 16) & 0xff;
  }
  bytes[100] = 0x1b;
  bytes[101] = 0x24;
  bytes[102] = 0x42;
  bytes[103] = 0x00;
  const stream = await RipstreamInputStream.from(bytes);
  const type = await detector.detect(stream, new Metadata(), new ParseContext());
  assert.equal(type.toString(), "application/octet-stream");
});

// The cases below were each checked against a running Tika 4.2.0 (`/meta`, `tk:detected-encoding`, and /tika/text for the
// decoded text) in tikajs-w7xw.
const bytesOf = (...parts: Array<string | number[]>): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...new TextEncoder().encode(part)] : part)));

test("a latin1 or us-ascii label is reported as windows-1252, as Tika does", () => {
  assert.equal(detectEncoding(bytesOf('<meta charset="iso-8859-1"><p>caf', [0xe9], "</p>")).charset, "windows-1252");
  assert.equal(detectEncoding(bytesOf('<meta charset="latin1"><p>caf', [0xe9], "</p>")).charset, "windows-1252");
  assert.equal(detectEncoding(bytesOf('<meta charset="us-ascii"><p>plain</p>')).charset, "windows-1252");
});

test("valid non-ASCII UTF-8 beats a declared single-byte charset", () => {
  const page = bytesOf('<meta charset="iso-8859-1"><p>', "wörld", "</p>");
  assert.equal(detectEncoding(page).charset, "UTF-8");
});

test("a declaration the bytes cannot be read in is passed over for the next one", () => {
  // UTF-8 declared, but the byte is a lone 0xE9: not UTF-8, so the declaration is junk and the next one is tried.
  const page = bytesOf('<meta charset="utf-8"><meta charset="iso-8859-2"><p>caf', [0xe9], "</p>");
  assert.equal(detectEncoding(page).charset.toUpperCase(), "ISO-8859-2");
});

test("an unsupported declared charset is ignored", () => {
  const page = bytesOf('<meta charset="no-such-charset"><meta charset="windows-1251"><p>', [0xcf, 0xf0, 0xe8], "</p>");
  assert.equal(detectEncoding(page).charset, "windows-1251");
});

test("a declaration inside a comment is used only when there is none outside it", () => {
  const both = bytesOf('<!-- <meta charset="iso-8859-2"> --><meta charset="windows-1251"><p>', [0xcf, 0xf0, 0xe8], "</p>");
  assert.equal(detectEncoding(both).charset, "windows-1251");
  const commentOnly = bytesOf('<!-- <meta charset="windows-1251"> --><p>', [0xcf, 0xf0, 0xe8], "</p>");
  assert.equal(detectEncoding(commentOnly).charset, "windows-1251");
});

test("a meta tag's content that merely mentions charset= counts as a declaration", () => {
  const page = bytesOf('<meta name="x" content="charset=windows-1251"><p>', [0xcf, 0xf0, 0xe8], "</p>");
  assert.equal(detectEncoding(page).charset, "windows-1251");
});

test("only the first 8192 bytes are scanned for a declaration", () => {
  const filler = " ".repeat(8000);
  assert.equal(detectEncoding(bytesOf("<html>", filler, '<meta charset="windows-1251"><p>', [0xcf, 0xf0, 0xe8], "</p>")).charset, "windows-1251");
  const tooFar = bytesOf("<html>", " ".repeat(8300), '<meta charset="windows-1251"><p>', [0xcf, 0xf0, 0xe8], "</p>");
  assert.notEqual(detectEncoding(tooFar).charset, "windows-1251");
});

test("a charset the caller was told of is tried before the page's own", () => {
  const page = bytesOf('<meta charset="windows-1251"><p>', [0xe9], "</p>");
  assert.equal(detectEncoding(page, "ISO-8859-2").charset, "ISO-8859-2");
});

test("a caller's charset the bytes cannot be read in is passed over", () => {
  assert.equal(detectEncoding(bytesOf("caf", [0xe9], " au lait"), "UTF-8").charset, "windows-1252");
});

test("a UTF-8 text told to be latin1 is still UTF-8", () => {
  assert.equal(detectEncoding(utf8("héllo"), "ISO-8859-1").charset, "UTF-8");
});

test("an ISO-2022-JP escape sequence in text is ISO-2022-JP, in binary it proves nothing", () => {
  assert.equal(detectEncoding(bytesOf("abc ", [0x1b, 0x24, 0x42, 0x30, 0x6c, 0x1b, 0x28, 0x42], " def")).charset, "ISO-2022-JP");
  assert.equal(detectEncoding(bytesOf([0x1b, 0x24, 0x42, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x00, 0x00])).binary, true);
});

// Tika 4.2.0: a UTF-32LE mark (FF FE 00 00) passes its text sniff as UTF-16LE, a UTF-32BE mark (00 00 FE FF) starts with
// NULs and is application/octet-stream; with a `.txt` name it is text/plain (tikajs-w7xw).
test("an unnamed UTF-32BE text is octet-stream and a UTF-32LE one is text, as in Tika", async () => {
  const detector = new DefaultDetector();
  const kind = async (bytes: number[], filename?: string): Promise<string> => {
    const metadata = new Metadata();
    if (filename !== undefined) metadata.set("tk:resource-name", filename);
    const stream = await RipstreamInputStream.from(Uint8Array.from(bytes));
    return (await detector.detect(stream, metadata, new ParseContext())).toString();
  };
  const be = [0, 0, 0xfe, 0xff, 0, 0, 0, 0x68, 0, 0, 0, 0x69];
  const le = [0xff, 0xfe, 0, 0, 0x68, 0, 0, 0, 0x69, 0, 0, 0];
  assert.equal(await kind(be), "application/octet-stream");
  assert.equal(await kind(le), "text/plain");
  assert.equal(await kind(be, "a.txt"), "text/plain");
});

// Tika 4.2.0 oracle (PUT /rmeta/body, tikajs-z5j5): a UTF-16 text with no byte order mark has NULs, so its type sniff finds
// binary: no name is application/octet-stream, a name settles the type (.eml is message/rfc822, .txt text/plain). With a mark
// it is text whatever the name (text/plain even for .eml).
test("a UTF-16 text without a mark is binary to the type sniff, and with a mark it is text", async () => {
  const detector = new DefaultDetector();
  const kind = async (bytes: number[], filename?: string): Promise<string> => {
    const metadata = new Metadata();
    if (filename !== undefined) metadata.set("tk:resource-name", filename);
    const stream = await RipstreamInputStream.from(Uint8Array.from(bytes));
    return (await detector.detect(stream, metadata, new ParseContext())).toString();
  };
  const le = [...new TextEncoder().encode("Subject: hello\n\nbody text\n")].flatMap((byte) => [byte, 0]);
  const be = [...new TextEncoder().encode("Subject: hello\n\nbody text\n")].flatMap((byte) => [0, byte]);
  for (const bytes of [le, be]) {
    assert.equal(await kind(bytes), "application/octet-stream");
    assert.equal(await kind(bytes, "a.eml"), "message/rfc822");
    assert.equal(await kind(bytes, "a.txt"), "text/plain");
  }
  assert.equal(await kind([0xff, 0xfe, ...le], "a.eml"), "text/plain");
  assert.equal(await kind([0xfe, 0xff, ...be], "a.eml"), "text/plain");
});

// Tika 4.2.0 oracle (PUT /rmeta/body): Shift_JIS bytes with no kana (names and cities of a CSV), with kana, with ASCII
// mixed in and of two characters are text/plain; charset=windows-31j; Western windows-1252 text with accents is not.
const shiftJis = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex.replace(/\s+/g, ""), "hex"));

test("short Shift_JIS text with no kana is windows-31j, as Tika has it", () => {
  // 名前,年齢,住所 CRLF 佐藤太郎,30,東京 CRLF
  const bytes = shiftJis("96bc914f2c944e97ee2c8f5a8f8a0d0a 8db293a191be98592c33302c938c8b9e0d0a");
  assert.equal(detectEncoding(bytes).charset, "windows-31j");
});

test("Shift_JIS text with kana, and two kanji alone, are windows-31j", () => {
  assert.equal(detectEncoding(shiftJis("82a082e882aa82c682a4")).charset, "windows-31j"); // ありがとう
  assert.equal(detectEncoding(shiftJis("93fa967b")).charset, "windows-31j"); // 日本
});

test("windows-1252 text with accents followed by letters is not taken for Shift_JIS", () => {
  // Tika 4.2.0 answers windows-1252 for this sentence.
  const text = "Il était une fois un petit garçon qui habitait près de Paris. Séverine était là aussi, très contente.\n";
  assert.equal(detectEncoding(Uint8Array.from(Buffer.from(text, "latin1"))).charset, "windows-1252");
});

// tikajs-wr9i: Tika 4.2.0's Mojibuster answers Java charset names for short East Asian text (PUT /rmeta/body, a short
// names/ages/cities CSV in each charset), and its names for EUC-JP, EUC-KR, Big5 and GBK are not WHATWG labels.
const EAST_ASIAN: readonly (readonly [string, string, string])[] = [
  ["zL7BsCzHr87wLMXUu9QKu7PFxMLAz7osMzAsxey1/gq6tMajsta70iwyNSzC57rlCs7rzNqw7M+6LDQxLMy+uMWysAo=", "x-eucJP-Open", "名前,年齢,都市"],
  ["wMy4pyyzqsDMLLW1vcMKsei5zsHYLDMwLLytv+8KwMy8rb+sLDI1LLrOu+oKudrB9sjGLDQxLLTrsbgK", "x-windows-949", "이름,나이,도시"],
  ["qW2mVyymfsTWLKuwpasKs6+kaqTlLDMwLLtPpV8KqkykcKz8LDI1LLCqtq8KpP2kcKn6LDQxLLtPpKQK", "Big5-HKSCS", "姓名,年齡,城市"],
  ["0NXD+yzE6sHkLLPHytAK1cXOsCwzMCyxsb6pCs31t7wsMjUsyc+6owrA7se/LDQxLLnj1t0K", "GB18030", "姓名,年龄,城市"],
  ["lryRTyyUTpfuLJNzjnMKjlKTY5G+mFksMzAsk4yLngqNspOhidSOcSwyNSyR5Y3jCpfpltiI6phZLDQxLJa8jMOJrgo=", "windows-31j", "名前,年齢,都市"],
];

test("East Asian short text: Tika's charset names, and the bytes decode in them", () => {
  for (const [base64, charset, text] of EAST_ASIAN) {
    const bytes = Buffer.from(base64, "base64");
    assert.equal(detectEncoding(bytes).charset, charset);
    assert.ok(decodeText(bytes, charset).startsWith(text), charset);
  }
});
