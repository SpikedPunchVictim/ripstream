import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { WmfEmfParser } from "../src/index.ts";

test("reads EMF bounds and version", async () => {
  const data = new Uint8Array(88);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 88, true);
  view.setInt32(8, 0, true);
  view.setInt32(12, 0, true);
  view.setInt32(16, 640, true);
  view.setInt32(20, 480, true);
  data[40] = 0x20;
  data.set([0x45, 0x4d, 0x46], 41);
  view.setUint32(44, 0x10000, true);
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new WmfEmfParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("tiff:ImageWidth"), "640");
  assert.equal(metadata.get("tiff:ImageLength"), "480");
  assert.equal(metadata.get("emf:version"), "65536");
});

test("accepts a standard (non-placeable) WMF header", async () => {
  const data = new Uint8Array(18);
  const view = new DataView(data.buffer);
  view.setUint16(0, 1, true); // type: memory metafile
  view.setUint16(2, 9, true); // header size in words
  view.setUint16(4, 0x0300, true); // version
  view.setUint32(6, 9, true); // size in words
  const stream = await RipstreamInputStream.from(data);
  await new WmfEmfParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext());
  await stream.close();
});

test("rejects arbitrary bytes as WMF/EMF", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array(32).fill(0x41));
  await assert.rejects(
    new WmfEmfParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    (error: Error) => error.name === "MalformedDocumentError",
  );
  await stream.close();
});
