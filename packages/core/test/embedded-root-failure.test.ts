import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler } from "../src/handlers/text.ts";
import { CONTEXT_KEYS, Metadata, ParseContext, RipstreamInputStream, TIKA_KEYS, type Parser } from "../src/index.ts";
import { ParsingEmbeddedDocumentExtractor } from "../src/embedded.ts";

test("a nested container's failure markers reach the root metadata, not only the dropped child's", async () => {
  const child: Parser = {
    getSupportedTypes: () => new Set(),
    async parse(_stream, _handler, metadata) {
      // A container that swallowed a nested failure and recorded it, then returned normally.
      metadata.add(TIKA_KEYS.EMBEDDED_EXCEPTION, "MalformedDocumentError: nested child");
    },
  } as Parser;
  const root = new Metadata();
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, child);
  ctx.set(CONTEXT_KEYS.ROOT_METADATA, root);
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("x"));
  try {
    await new ParsingEmbeddedDocumentExtractor().parseEmbedded(stream, new BodyContentHandler(), new Metadata(), ctx);
  } finally {
    await stream.close();
  }
  assert.deepEqual(root.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION), ["MalformedDocumentError: nested child"]);
});
