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
import { SnappyParser } from "../src/index.ts";

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

function frame(payload: Uint8Array, compressed: boolean): Uint8Array {
  const body = [0, 0, 0, 0, ...payload]; // CRC placeholder
  const length = body.length;
  return new Uint8Array([
    0xff, 6, 0, 0, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59,
    compressed ? 0 : 1,
    length & 0xff,
    (length >> 8) & 0xff,
    (length >> 16) & 0xff,
    ...body,
  ]);
}

test("decompresses Snappy framed streams", async () => {
  const stream = await RipstreamInputStream.from(
    frame(new TextEncoder().encode("hello snappy"), false),
  );
  const handler = new BodyContentHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.PARSER, plainText);
  await new SnappyParser().parse(stream, handler, new Metadata(), context);
  await stream.close();
  assert.match(handler.toString(), /hello snappy/);
});

test("rejects truncated Snappy frames", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array([0, 10, 0, 0, 1]));
  await assert.rejects(
    new SnappyParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
});

test("claims application/x-snappy, the type Tika's CompressorParser claims for framed Snappy", () => {
  const types = [...new SnappyParser().getSupportedTypes()].map((type) => type.toString());
  assert.ok(types.includes("application/x-snappy"), types.join(", "));
});

test("every prefix of a framed Snappy stream parses or is refused as malformed", async () => {
  const valid = frame(new TextEncoder().encode("hello snappy"), false);
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.PARSER, plainText);
  for (let length = 0; length <= valid.byteLength; length++) {
    const stream = await RipstreamInputStream.from(valid.subarray(0, length));
    try {
      await new SnappyParser().parse(stream, new BodyContentHandler(), new Metadata(), context);
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix of ${length} bytes: ${String(error)}`);
    } finally {
      await stream.close();
    }
  }
});
