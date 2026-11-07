import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { AsfParser, AviParser, ImageParser, MatroskaParser, Mp4Parser, WmfEmfParser } from "../src/index.ts";

/** Every prefix of a file must parse or fail with MalformedDocumentError. */
async function assertPrefixesSafe(parser: Parser, full: Uint8Array, label: string): Promise<void> {
  for (let length = 0; length <= full.length; length++) {
    const stream = await RipstreamInputStream.from(full.slice(0, length));
    try {
      await parser.parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext());
    } catch (error) {
      assert.ok(
        error instanceof MalformedDocumentError,
        `${label} prefix ${length}: ${error instanceof Error ? error.constructor.name : error}`,
      );
    } finally {
      await stream.close();
    }
  }
}

const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];

test("mp4: truncated mvhd v0 and v1 raise MalformedDocumentError", async () => {
  for (const version of [0, 1]) {
    const mvhdSize = version === 1 ? 8 + 32 : 8 + 20;
    const mvhd = new Uint8Array(mvhdSize);
    new DataView(mvhd.buffer).setUint32(0, mvhdSize);
    mvhd.set(ascii("mvhd"), 4);
    mvhd[8] = version;
    const moov = new Uint8Array(8 + mvhd.length);
    new DataView(moov.buffer).setUint32(0, moov.length);
    moov.set(ascii("moov"), 4);
    moov.set(mvhd, 8);
    await assertPrefixesSafe(new Mp4Parser(), moov, `mvhd v${version}`);
    // Header declares more than the box holds.
    const lying = moov.slice();
    new DataView(lying.buffer).setUint32(0, lying.length);
    lying[8 + 8] = version;
    new DataView(lying.buffer).setUint32(8, 8 + 4);
    const stream = await RipstreamInputStream.from(lying);
    await assert.rejects(
      new Mp4Parser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
      MalformedDocumentError,
    );
    await stream.close();
  }
});

test("avi, asf, emf, j2c and matroska: truncated input is Malformed or tolerated", async () => {
  const avi = new Uint8Array(12 + 8 + 40);
  avi.set(ascii("RIFF"), 0);
  avi.set(ascii("AVI "), 8);
  avi.set(ascii("avih"), 12);
  new DataView(avi.buffer).setUint32(16, 40, true);
  await assertPrefixesSafe(new AviParser(), avi, "avi");

  const asf = new Uint8Array(30 + 24 + 64);
  asf.set([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]);
  new DataView(asf.buffer).setBigUint64(16, BigInt(asf.length - 24), true);
  asf.set([0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11, 0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65], 30);
  new DataView(asf.buffer).setBigUint64(30 + 16, 24n + 64n, true);
  await assertPrefixesSafe(new AsfParser(), asf, "asf");

  const emf = new Uint8Array(48);
  new DataView(emf.buffer).setUint32(0, 1, true);
  emf[40] = 0x20;
  await assertPrefixesSafe(new WmfEmfParser(), emf, "emf");

  const j2c = new Uint8Array(24);
  j2c.set([0xff, 0x4f, 0xff, 0x51]);
  await assertPrefixesSafe(new ImageParser(), j2c, "j2c");

  const mkv = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, 0x44, 0x89, 0x88, 1, 2, 3]);
  await assertPrefixesSafe(new MatroskaParser(), mkv, "mkv");
});
