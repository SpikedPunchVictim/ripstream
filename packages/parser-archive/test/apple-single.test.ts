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
import { AppleSingleParser } from "../src/index.ts";

function buildAppleSingle(payload: string): Uint8Array {
  const bytes = new TextEncoder().encode(payload);
  const header = new Uint8Array(38 + bytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x00051600);
  view.setUint32(4, 0x00020000);
  view.setUint16(24, 1);
  view.setUint32(26, 2);
  view.setUint32(30, 38);
  view.setUint32(34, bytes.length);
  header.set(bytes, 38);
  return header;
}

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

test("extracts the AppleSingle data fork", async () => {
  const stream = await RipstreamInputStream.from(buildAppleSingle("hello apple"));
  const handler = new BodyContentHandler();
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, plainText);
  await new AppleSingleParser().parse(stream, handler, new Metadata(), ctx);
  await stream.close();
  assert.match(handler.toString(), /hello apple/);
});

test("rejects malformed AppleSingle", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array([1, 2, 3]));
  await assert.rejects(
    new AppleSingleParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
});
