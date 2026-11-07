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
