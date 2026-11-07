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
  assert.equal(detector.detect(bytes("xxxxxxCDR")).length, 0);
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
