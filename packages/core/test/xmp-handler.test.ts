import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, TextContentHandler, XmpContentHandler } from "../src/index.ts";

test("writes metadata as an XMP packet", async () => {
  const output = new TextContentHandler();
  const metadata = new Metadata();
  metadata.set("dc:title", "Doc");
  const handler = new XmpContentHandler(output, metadata);
  await handler.startDocument();
  await handler.endDocument();
  const text = output.toString();
  assert.match(text, /xpacket begin/);
  assert.match(text, /<dc:title>Doc<\/dc:title>/);
});
