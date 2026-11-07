import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, LimitExceededError, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { IWork09Parser } from "../src/index.ts";

test("extracts iWork '09 index.apxl text", async () => {
  const bytes = zipSync({
    "index.apxl": strToU8(
      '<?xml version="1.0"?><apxl><sf:text>Hello Keynote</sf:text><sf:text>Second slide</sf:text></apxl>',
    ),
  });
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  await new IWork09Parser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /Hello Keynote/);
  assert.match(handler.toString(), /Second slide/);
});

test("rejects an iWork '09 package whose entry exceeds the limits", async () => {
  const bytes = zipSync({ "index.apxl": new Uint8Array(5_000_000) });
  const stream = await RipstreamInputStream.from(bytes);
  const ctx = new ParseContext();
  await assert.rejects(
    new IWork09Parser().parse(stream, new BodyContentHandler(), new Metadata(), ctx),
    LimitExceededError,
  );
  await stream.close();
});
