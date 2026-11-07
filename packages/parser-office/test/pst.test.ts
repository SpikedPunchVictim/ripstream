import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { PstParser } from "../src/index.ts";

test("reads PST header metadata", async () => {
  const data = new Uint8Array(512);
  data.set([...new TextEncoder().encode("!BDN")], 0);
  const view = new DataView(data.buffer);
  view.setUint16(8, 23, true);
  view.setUint16(10, 19, true);
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new PstParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("pst:version"), "23");
  assert.equal(metadata.get("pst:ost"), "true");
});
