import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { Mp4Parser } from "../src/index.ts";

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function box(type: string, payload: number[]): number[] {
  return [...u32(payload.length + 8), ...[...type].map((c) => c.charCodeAt(0)), ...payload];
}

function sample(): Uint8Array {
  const ftyp = box("ftyp", [...[... "isom"].map((c) => c.charCodeAt(0)), ...u32(0)]);
  const mvhdPayload = new Array(100).fill(0);
  const mvhd = box("mvhd", [...mvhdPayload, ...u32(1000), ...u32(5000)]);
  // timescale/duration live at fixed offsets; rebuild with the header layout.
  const mvhdBytes = new Uint8Array(8 + 100);
  const view = new DataView(mvhdBytes.buffer);
  view.setUint32(0, 108);
  mvhdBytes.set([0x6d, 0x76, 0x68, 0x64], 4);
  view.setUint32(20, 1000);
  view.setUint32(24, 5000);
  const moov = box("moov", [...mvhdBytes]);
  void mvhd;
  return new Uint8Array([...ftyp, ...moov]);
}

test("reads MP4 duration metadata", async () => {
  const stream = await RipstreamInputStream.from(sample());
  const metadata = new Metadata();
  await new Mp4Parser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("audio:spi-duration"), "5");
});

test("rejects files without moov", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array(16));
  await assert.rejects(
    new Mp4Parser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
});
