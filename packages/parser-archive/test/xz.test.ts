import assert from "node:assert/strict";
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
import { XzParser } from "../src/index.ts";

const fixture = Uint8Array.from(
  Buffer.from(
    "/Td6WFoAAATm1rRGBMAMCCEBFgAAAAAAAAAAAKx3qqQBAAdIZWxsbyBYWgBXz7NGvwtu0gABKAizkwBzH7bzfQEAAAAABFla",
    "base64",
  ),
);

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

test("decompresses XZ streams", async () => {
  const stream = await RipstreamInputStream.from(fixture);
  const handler = new BodyContentHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.PARSER, plainText);
  await new XzParser().parse(stream, handler, new Metadata(), context);
  await stream.close();
  assert.match(handler.toString(), /Hello XZ/);
});

test("rejects malformed XZ input", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(
    new XzParser().parse(
      stream,
      new BodyContentHandler(),
      new Metadata(),
      new ParseContext(),
    ),
    MalformedDocumentError,
  );
  await stream.close();
});
