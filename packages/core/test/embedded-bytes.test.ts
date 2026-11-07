import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  LimitExceededError,
  ParsingEmbeddedDocumentExtractor,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "../src/index.ts";

test("buffers embedded documents with paths and URIs", async () => {
  const handler = new EmbeddedDocumentBytesHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_RESOURCE_PATH, "/doc");
  const metadata = new Metadata();
  metadata.set("resourceName", "a.txt");
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("hello"));
  await handler.parseEmbedded(
    stream,
    new BodyContentHandler(),
    metadata,
    context,
  );
  await stream.close();
  assert.equal(handler.resources.length, 1);
  assert.equal(handler.resources[0]?.path, "/doc/a.txt");
  assert.equal(handler.resources[0]?.uri, "embedded:/doc/a.txt");
  assert.equal(new TextDecoder().decode(handler.resources[0]?.bytes), "hello");
  assert.equal(metadata.get("X-TIKA:embedded_resource_uri"), "embedded:/doc/a.txt");
});

test("default extractor aborts an unknown-size child as soon as the byte budget is crossed", async () => {
  let pulled = 0;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < 1000; i++) {
      pulled += 1;
      yield new Uint8Array(1024);
    }
  }
  const context = new ParseContext({ limits: { maxEmbeddedResourceBytes: 4096 } });
  const consumer = {
    getSupportedTypes: () => new Set(),
    async parse(stream: RipstreamInputStream): Promise<void> {
      for await (const _chunk of stream) { /* consume */ }
    },
  };
  context.set(CONTEXT_KEYS.PARSER, consumer);
  const stream = await RipstreamInputStream.from(chunks());
  assert.equal(stream.length, null);
  await assert.rejects(
    new ParsingEmbeddedDocumentExtractor().parseEmbedded(stream, new BodyContentHandler(), new Metadata(), context),
    LimitExceededError,
  );
  await stream.close();
  assert.ok(pulled < 20, `pulled ${pulled} chunks`);
});
