import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { IWork13Parser } from "../src/index.ts";

test("reads iWork 13 IWA metadata and strings", async () => {
  const bytes = zipSync({
    "Index/Document.iwa": strToU8("Hello iWork13 document text"),
    "QuickLook/Preview.pdf": strToU8("%PDF-1.4"),
  });
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new IWork13Parser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("iwork:iwa-parts"), "1");
  assert.equal(metadata.get("iwork:preview"), "true");
  assert.match(handler.toString(), /Hello iWork13/);
});
