import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { ShapefileParser } from "../src/index.ts";

test("reads shapefile header metadata", async () => {
  const data = new Uint8Array(100);
  const view = new DataView(data.buffer);
  view.setUint32(0, 9994, false);
  view.setUint32(24, 50, false);
  view.setUint32(28, 1000, true);
  view.setUint32(32, 5, true);
  view.setFloat64(36, -10, true);
  view.setFloat64(44, -20, true);
  view.setFloat64(52, 30, true);
  view.setFloat64(60, 40, true);
  const stream = await RipstreamInputStream.from(data);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new ShapefileParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("shapefile:shape-type"), "Polygon");
  assert.match(handler.toString(), /Bounds/);
});
