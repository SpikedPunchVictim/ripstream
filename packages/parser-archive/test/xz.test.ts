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
import { loadXzReadableStream } from "../src/xz.ts";

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

async function decode(bytes: Uint8Array): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.PARSER, plainText);
  try {
    await new XzParser().parse(stream, handler, new Metadata(), context);
  } finally {
    await stream.close();
  }
  return handler.toString();
}

test("each document gets its own xz-decompress class, with its own instance and mutex", () => {
  const first = loadXzReadableStream() as unknown as { _contextMutex: unknown } | undefined;
  const second = loadXzReadableStream() as unknown as { _contextMutex: unknown } | undefined;
  assert.ok(first && second);
  assert.notEqual(first, second);
  assert.notEqual(first._contextMutex, second._contextMutex);
});

test("a mutex that was never released, as when a failing decode cannot dispose its context, does not stall the next document", async () => {
  const leaked = loadXzReadableStream() as unknown as { _contextMutex: { locked: boolean } };
  leaked._contextMutex.locked = true;
  const timeout = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("decode stalled")), 5_000).unref());
  assert.match(await Promise.race([decode(fixture), timeout]), /Hello XZ/);
});

test("a stream that fails mid-decode fails as a document, and the next one decodes", async () => {
  const corrupt = fixture.slice();
  corrupt[corrupt.length - 20] ^= 0xff;
  await assert.rejects(decode(corrupt), MalformedDocumentError);
  assert.match(await decode(fixture), /Hello XZ/);
});

test("decodes that overlap each finish", async () => {
  const results = await Promise.all([decode(fixture), decode(fixture), decode(fixture)]);
  for (const text of results) assert.match(text, /Hello XZ/);
});
