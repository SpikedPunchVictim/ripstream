import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { AnpaParser } from "../src/index.ts";

test("extracts ANPA records", async () => {
  const text = new TextEncoder().encode("hello anpa");
  const bytes = new Uint8Array([
    0, 0, text.length, 1,
    ...text,
  ]);
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new AnpaParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /hello anpa/);
  assert.equal(metadata.get("anpa:record-count"), "1");
});
