import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { AsfParser, AviParser, MatroskaParser } from "../src/index.ts";

function riff(): Uint8Array {
  const data = new Uint8Array(12 + 8 + 40);
  data.set([...new TextEncoder().encode("RIFF")], 0);
  const view = new DataView(data.buffer);
  view.setUint32(4, 48, true);
  data.set([...new TextEncoder().encode("AVI ")], 8);
  data.set([...new TextEncoder().encode("avih")], 12);
  view.setUint32(16, 40, true);
  view.setUint32(20, 40_000, true);
  view.setUint32(36, 100, true);
  view.setUint32(52, 640, true);
  view.setUint32(56, 480, true);
  return data;
}

test("reads AVI metadata", async () => {
  const stream = await RipstreamInputStream.from(riff());
  const metadata = new Metadata();
  await new AviParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("tiff:ImageWidth"), "640");
  assert.equal(metadata.get("audio:spi-duration"), "4");
});

test("reads Matroska duration", async () => {
  const duration = new ArrayBuffer(8);
  new DataView(duration).setFloat64(0, 5000);
  const info = [0x15, 0x49, 0xa9, 0x66, 0x8b, 0x44, 0x89, 0x88, ...new Uint8Array(duration)];
  const segment = [0x18, 0x53, 0x80, 0x67, 0x90, ...info];
  const data = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, ...segment]);
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new MatroskaParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("audio:spi-duration"), "5");
});

test("rejects deeply nested EBML with MalformedDocumentError", async () => {
  let content: number[] = [];
  for (let level = 0; level < 100; level++) {
    content = [0xe0, 0x01, 0, 0, 0, 0, 0, 0, content.length, ...content];
  }
  const data = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, ...content]);
  const stream = await RipstreamInputStream.from(data);
  await assert.rejects(
    new MatroskaParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    (error: Error) => error.name === "MalformedDocumentError",
  );
  await stream.close();
});

test("MatroskaParser lists application/x-matroska", () => {
  const types = [...new MatroskaParser().getSupportedTypes()].map(String);
  assert.ok(types.includes("application/x-matroska"));
});
