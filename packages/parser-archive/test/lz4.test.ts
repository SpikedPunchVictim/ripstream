import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  XHTMLContentHandler,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { Lz4Parser } from "../src/index.ts";

const plainText: Parser = {
  getSupportedTypes: () => new Set(),
  async parse(stream, handler) {
    const xhtml = new XHTMLContentHandler(handler, new Metadata());
    await xhtml.startDocument();
    let text = "";
    for await (const chunk of stream) text += new TextDecoder().decode(chunk);
    await xhtml.element("p", text);
    await xhtml.endDocument();
  },
};

async function compressed(): Promise<Uint8Array> {
  const module = (await import("lz4js")) as unknown as {
    default?: { compress(value: Uint8Array): Uint8Array };
    compress?(value: Uint8Array): Uint8Array;
  };
  const compress = module.default?.compress ?? module.compress!;
  return compress(new TextEncoder().encode("hello lz4"));
}

test("decompresses LZ4 frames", async () => {
  const stream = await RipstreamInputStream.from(await compressed());
  const handler = new BodyContentHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.PARSER, plainText);
  await new Lz4Parser().parse(stream, handler, new Metadata(), context);
  await stream.close();
  assert.match(handler.toString(), /hello lz4/);
});

test("rejects malformed LZ4", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(
    new Lz4Parser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
});
