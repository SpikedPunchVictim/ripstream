import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";

const detector = new DefaultDetector();

async function detect(bytes: Uint8Array): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes);
  try {
    const type = await detector.detect(stream, new Metadata(), new ParseContext());
    return `${type.type}/${type.subtype}`;
  } finally {
    await stream.close();
  }
}

test("detects compressor, archive and document magic", async () => {
  const iso = new Uint8Array(40_000);
  iso.set([0x43, 0x44, 0x30, 0x30, 0x31], 0x8001);

  const cases: Array<[string, Uint8Array]> = [
    ["application/pdf", new TextEncoder().encode("%PDF-1.7\n")],
    ["application/gzip", new Uint8Array([0x1f, 0x8b, 8, 0])],
    ["application/x-7z-compressed", new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
    ["application/x-rar-compressed", new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])],
    ["application/applefile", new Uint8Array([0x00, 0x05, 0x16, 0x00])],
    ["application/x-iso9660-image", iso],
    ["application/warc", new TextEncoder().encode("WARC/1.0\r\nWARC-Type: warcinfo\r\n\r\n")],
  ];
  const failures: string[] = [];
  for (const [expected, bytes] of cases) {
    const actual = await detect(bytes);
    if (actual !== expected) failures.push(`${expected}: got ${actual}`);
  }
  assert.deepEqual(failures, []);
});

test("numeric rules honour endianness and detect TNEF", async () => {
  // TNEF: little32 0x223e9f78 at offset 0 -> bytes 78 9f 3e 22
  assert.equal(
    await detect(new Uint8Array([0x78, 0x9f, 0x3e, 0x22, 0x01, 0x00])),
    "application/vnd.ms-tnef",
  );
  // Big-endian byte order must not match the little32 rule.
  assert.notEqual(
    await detect(new Uint8Array([0x22, 0x3e, 0x9f, 0x78, 0x01, 0x00])),
    "application/vnd.ms-tnef",
  );
});
