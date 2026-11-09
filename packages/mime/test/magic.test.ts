import assert from "node:assert/strict";
import { test } from "node:test";
import type { TikaMagic, TikaMimeEntry } from "../src/registry-types.ts";
import { MagicDetector } from "../src/magic.ts";

function entry(type: string, magic: TikaMagic[]): TikaMimeEntry {
  return { type, aliases: [], globs: [], rootXml: [], magic };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

test("matches a fixed-offset string", () => {
  const detector = new MagicDetector([
    entry("application/pdf", [
      { priority: 50, matches: [{ type: "string", value: "%PDF-", offset: "0" }] },
    ]),
  ]);
  assert.deepEqual(detector.detect(bytes("%PDF-1.7"))[0]?.toString(), "application/pdf");
  assert.equal(detector.detect(bytes("not a pdf")).length, 0);
});

test("matches hex values and masks", () => {
  const detector = new MagicDetector([
    entry("application/x-masked", [
      {
        priority: 50,
        matches: [{ type: "string", value: "0x00", offset: "1", mask: "0xF8" }],
      },
    ]),
  ]);
  assert.equal(detector.detect(new Uint8Array([0xff, 0x07])).length, 1);
  assert.equal(detector.detect(new Uint8Array([0xff, 0x08])).length, 0);
});

test("searches within an offset range", () => {
  const detector = new MagicDetector([
    entry("application/x-range", [
      { priority: 50, matches: [{ type: "string", value: "CDR", offset: "2:6" }] },
    ]),
  ]);
  assert.equal(detector.detect(bytes("xxCDR")).length, 1);
  // The end of the range is inclusive: Tika 4.2.0 matches `BOOKMOBI` at 60 but not 61 for `0:60`.
  assert.equal(detector.detect(bytes("xxxxxxCDR")).length, 1);
  assert.equal(detector.detect(bytes("xxxxxxxCDR")).length, 0);
  assert.equal(detector.detect(bytes("xCDR")).length, 0);
});

test("evaluates nested matches and group thresholds", () => {
  const detector = new MagicDetector([
    entry("audio/wav", [
      {
        priority: 50,
        matches: [
          {
            type: "string",
            value: "RIFF",
            offset: "0",
            children: [{ type: "string", value: "WAVE", offset: "8" }],
          },
        ],
      },
    ]),
    entry("application/x-group", [
      {
        priority: 40,
        matches: [
          {
            type: "string",
            value: "",
            offset: "0",
            minShouldMatch: 2,
            children: [
              { type: "string", value: "a", offset: "0" },
              { type: "string", value: "b", offset: "1" },
              { type: "string", value: "c", offset: "2" },
            ],
          },
        ],
      },
    ]),
  ]);

  const wav = new Uint8Array(12);
  wav.set(bytes("RIFF"), 0);
  wav.set(bytes("WAVE"), 8);
  assert.deepEqual(detector.detect(wav).map(String), ["audio/wav"]);
  assert.equal(detector.detect(bytes("abx")).length, 1);
  assert.equal(detector.detect(bytes("axc")).length, 1);
  assert.equal(detector.detect(bytes("xbx")).length, 0);
});

test("stringignorecase compares ASCII case-insensitively", () => {
  const detector = new MagicDetector([
    entry("text/x-case", [
      { priority: 50, matches: [{ type: "stringignorecase", value: "@echo off", offset: "0" }] },
    ]),
  ]);
  assert.equal(detector.detect(bytes("@ECHO OFF")).length, 1);
});

test("unicodeLE matches UTF-16 little-endian", () => {
  const detector = new MagicDetector([
    entry("video/x-ms-asf", [
      { priority: 50, matches: [{ type: "unicodeLE", value: "WMV", offset: "0" }] },
    ]),
  ]);
  const data = new Uint8Array([0x57, 0x00, 0x4d, 0x00, 0x56, 0x00]);
  assert.equal(detector.detect(data).length, 1);
});

test("only the highest matching priority band is returned", () => {
  const detector = new MagicDetector([
    entry("application/low", [
      { priority: 40, matches: [{ type: "string", value: "A", offset: "0" }] },
    ]),
    entry("application/high", [
      { priority: 70, matches: [{ type: "string", value: "AB", offset: "0" }] },
    ]),
  ]);
  assert.deepEqual(detector.detect(bytes("AB")).map(String), ["application/high"]);
});

test("full registry detects common container signatures", () => {
  const detector = new MagicDetector();
  assert.equal(detector.detect(bytes("%PDF-1.7"))[0]?.toString(), "application/pdf");
  assert.equal(
    detector.detect(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))[0]?.toString(),
    "image/png",
  );
  assert.equal(
    detector.detect(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))[0]?.toString(),
    "application/zip",
  );
  assert.equal(
    detector.detect(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))[0]?.toString(),
    "image/jpeg",
  );
  assert.equal(
    detector.detect(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))[0]?.toString(),
    "application/x-tika-msoffice",
  );
});

function types(detector: MagicDetector, data: Uint8Array): string[] {
  return detector.detect(data).map((type) => type.toString());
}

test("orders equal-priority rules by clause size, then by type name, both descending", () => {
  const detector = new MagicDetector([
    entry("application/x-short", [{ priority: 50, matches: [{ type: "string", value: "AB", offset: "0" }] }]),
    entry("application/x-long", [{ priority: 50, matches: [{ type: "string", value: "ABC", offset: "0" }] }]),
    entry("application/x-a", [{ priority: 50, matches: [{ type: "string", value: "XY", offset: "0" }] }]),
    entry("application/x-b", [{ priority: 50, matches: [{ type: "string", value: "XY", offset: "0" }] }]),
  ]);
  assert.deepEqual(types(detector, bytes("ABC")), ["application/x-long", "application/x-short"]);
  assert.deepEqual(types(detector, bytes("XY")), ["application/x-b", "application/x-a"]);
});

test("a match with sub-matches is sized as its own pattern plus its largest sub-match", () => {
  const detector = new MagicDetector([
    entry("application/x-plain", [{ priority: 50, matches: [{ type: "string", value: "RIFF", offset: "0" }] }]),
    entry("application/x-nested", [
      {
        priority: 50,
        matches: [
          {
            type: "string",
            value: "RIFF",
            offset: "0",
            children: [
              { type: "string", value: "WA", offset: "8" },
              { type: "string", value: "WAVE", offset: "8" },
            ],
          },
        ],
      },
    ]),
  ]);
  // Both match; nested is sized 4 + 4 = 8 against 4, though "x-plain" would win a name tie.
  assert.deepEqual(types(detector, bytes("RIFF....WAVE")), ["application/x-nested", "application/x-plain"]);
});

test("a numeric value without 0x is octal, as Tika reads it", () => {
  const detector = new MagicDetector([
    entry("application/x-octal", [{ priority: 50, matches: [{ type: "little16", value: "23", offset: "0" }] }]),
    entry("application/x-hex", [{ priority: 50, matches: [{ type: "big16", value: "0x2301", offset: "2" }] }]),
  ]);
  assert.deepEqual(types(detector, new Uint8Array([0x13, 0x00])), ["application/x-octal"]);
  assert.deepEqual(types(detector, new Uint8Array([0x17, 0x00])), []);
  assert.deepEqual(types(detector, new Uint8Array([0, 0, 0x23, 0x01])), ["application/x-hex"]);
});

test("a mask shorter than its value is padded with 0xFF", () => {
  const detector = new MagicDetector([
    entry("application/x-masked", [{ priority: 50, matches: [{ type: "string", value: "0x0102", offset: "0", mask: "0xFF" }] }]),
  ]);
  assert.equal(detector.detect(new Uint8Array([1, 2])).length, 1);
  assert.equal(detector.detect(new Uint8Array([1, 3])).length, 0);
});

test("regex rules decode the registry's escapes and match at the offset, or anywhere in a range", () => {
  const detector = new MagicDetector([
    entry("application/x-digits", [{ priority: 50, matches: [{ type: "regex", value: "\\\\d+x", offset: "0" }] }]),
    entry("application/x-lines", [{ priority: 50, matches: [{ type: "regex", value: "L\\r?\\nM", offset: "0" }] }]),
    entry("application/x-ranged", [{ priority: 50, matches: [{ type: "regex", value: "Z+Q", offset: "0:2" }] }]),
  ]);
  assert.deepEqual(types(detector, bytes("123x")), ["application/x-digits"]);
  assert.deepEqual(types(detector, bytes("a123x")), []);
  assert.deepEqual(types(detector, bytes("L\r\nM")), ["application/x-lines"]);
  assert.deepEqual(types(detector, bytes("L\nM")), ["application/x-lines"]);
  assert.deepEqual(types(detector, bytes("aaZQ")), ["application/x-ranged"]);
  assert.deepEqual(types(detector, bytes("aaaZQ")), []);
});

test("a regex that cannot be compiled is reported and never matches", () => {
  const detector = new MagicDetector([
    entry("application/x-broken", [{ priority: 50, matches: [{ type: "regex", value: "(unclosed", offset: "0" }] }]),
  ]);
  assert.deepEqual(detector.uncompilableRegexes, ["application/x-broken: (unclosed"]);
  assert.deepEqual(types(detector, bytes("(unclosed")), []);
});

test("an atomic group is emulated, so a failing match cannot be made exponential", () => {
  // The registry's PDF rule: `(?>(?:%%[^\r\n]{0,148})?(?:\r\n|[\r\n])){1,50}%PDF-[12]\.`. Read as a plain group,
  // 24 CRLF pairs take ~1.5 s to fail (Tika's atomic group takes microseconds), and each pair doubles that.
  const detector = new MagicDetector();
  const hostile = new Uint8Array(64 * 1024).fill(0x58);
  hostile.set(bytes("\r\n".repeat(24) + "Z"));
  const started = performance.now();
  detector.detect(hostile);
  assert.ok(performance.now() - started < 1000);

});

test("an emulated atomic group does not backtrack into itself, as in Java", () => {
  const detector = new MagicDetector([
    entry("application/x-atomic", [{ priority: 50, matches: [{ type: "regex", value: "(?>a|ab)c", offset: "0" }] }]),
    entry("application/x-repeated", [{ priority: 50, matches: [{ type: "regex", value: "(?>x|xy){2}z", offset: "0" }] }]),
  ]);
  assert.deepEqual(types(detector, bytes("ac")), ["application/x-atomic"]);
  // A plain group would retry `ab` after `a` and match.
  assert.deepEqual(types(detector, bytes("abc")), []);
  // A quantifier on the group applies to the group, not to the lookahead's backreference.
  assert.deepEqual(types(detector, bytes("xxz")), ["application/x-repeated"]);
  assert.deepEqual(types(detector, bytes("xz")), []);
});

test("an atomic group with a numeric backreference is refused rather than renumbered", () => {
  const detector = new MagicDetector([
    entry("application/x-mixed", [{ priority: 50, matches: [{ type: "regex", value: "(?>a)(b)\\\\1", offset: "0" }] }]),
  ]);
  assert.equal(detector.uncompilableRegexes.length, 1);
});

test("\\s in a regex is ASCII whitespace only, as in Java", () => {
  const detector = new MagicDetector([
    entry("application/x-space", [{ priority: 50, matches: [{ type: "regex", value: "a\\\\s+b", offset: "0" }] }]),
  ]);
  assert.deepEqual(types(detector, bytes("a \t\nb")), ["application/x-space"]);
  // U+00A0 is the Latin-1 byte 0xA0; JS `\s` would accept it, Java's does not.
  assert.deepEqual(types(detector, new Uint8Array([0x61, 0xa0, 0x62])), []);
});
