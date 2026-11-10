import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  CONTEXT_KEYS,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParseContext,
  RecursiveParserWrapper,
  Ripstream,
  RipstreamInputStream,
  rmetaObjects,
  type ContentHandler,
  type Detector,
  type Parser,
} from "../src/index.ts";
import type { EmbeddedDocumentExtractor } from "../src/embedded.ts";

const detector: Detector = { detect: async () => MediaType.TEXT_PLAIN };

/**
 * A container with two embedded documents, the first holding one of its own. `fail` names the document whose parse
 * throws: "container" for the top-level one, "c0" for the first embedded document.
 */
function containerParser(fail?: "container" | "c0"): Parser {
  return {
    name: "Container",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(stream, handler: ContentHandler, metadata, ctx): Promise<void> {
      const depth = ctx.get(CONTEXT_KEYS.EMBEDDED_DEPTH) ?? 0;
      const name = metadata.get("tk:resource-name");
      for await (const _chunk of stream) { /* read it all, as a real parser does: the size is known at the end */ }
      await handler.startElement?.("", "body", "body", new AttributesImpl([]));
      await handler.characters?.("text", 0, 4);
      await handler.endElement?.("", "body", "body");
      if (fail === "container" && depth === 0) throw new MalformedDocumentError("bad container");
      if (fail === "c0" && name === "c0") throw new MalformedDocumentError("bad c0");
      const extractor = ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor;
      const names = depth === 0 ? ["c0", "c1"] : name === "c0" && depth === 1 ? ["inner.txt"] : [];
      for (const child of names) {
        const embedded = new Metadata();
        embedded.set("tk:resource-name", child);
        await extractor.parseEmbedded(await RipstreamInputStream.from(new Uint8Array([1, 2, 3])), handler, embedded, ctx);
      }
    },
  };
}

test("parseRecursive gives each record Tika's embedded keys: depth, id, id path, a path below the container", async () => {
  const records = await new Ripstream({ detector, parser: containerParser() }).parseRecursive(new Uint8Array([9, 9]), {
    filename: "box.bin",
  });
  const [container, c0, inner, c1] = records.map((record) => record.metadata);
  assert.equal(records.length, 4);
  assert.equal(container?.get("tk:embedded-depth"), "0");
  assert.equal(container?.get("tk:embedded-resource-path"), null, "the container has no embedded path");
  assert.equal(container?.get("tk:embedded-id"), null);
  assert.deepEqual(
    [c0, inner, c1].map((m) => [m?.get("tk:embedded-depth"), m?.get("tk:embedded-id"), m?.get("tk:embedded-id-path"), m?.get("tk:embedded-resource-path")]),
    [
      ["1", "1", "/1", "/c0"],
      ["2", "2", "/1/2", "/c0/inner.txt"],
      ["1", "3", "/3", "/c1"],
    ],
  );
});

test("Content-Length is the size of the input, for the container and each embedded document", async () => {
  const records = await new Ripstream({ detector, parser: containerParser() }).parseRecursive(new Uint8Array([9, 9]));
  assert.equal(records[0]?.metadata.get("Content-Length"), "2");
  assert.equal(records[1]?.metadata.get("Content-Length"), "3");
});

test("rmetaObjects works the final embedded paths out from the ids", async () => {
  const records = await new Ripstream({ detector, parser: containerParser() }).parseRecursive(new Uint8Array([9]));
  const objects = rmetaObjects(records);
  assert.deepEqual(
    objects.map((object) => object["tk:final-embedded-resource-path"]),
    [undefined, "/c0", "/c0/inner.txt", "/c1"],
  );
});

test("a container that fails keeps its record, with the failure on its own metadata", async () => {
  const ctx = new ParseContext();
  const wrapper = new RecursiveParserWrapper(containerParser("container"));
  const stream = await RipstreamInputStream.from(new Uint8Array([1]));
  await assert.rejects(
    wrapper.parse(stream, { startDocument() {}, endDocument() {} }, new Metadata(), ctx),
    MalformedDocumentError,
  );
  const [container] = wrapper.getRecords();
  assert.equal(container?.metadata.get("tk:exception:container-exception"), "MalformedDocumentError: bad container");
  assert.equal(container?.content, "text", "what was extracted before the failure is kept");
  assert.equal(container?.metadata.get("tk:embedded-depth"), "0");
  assert.notEqual(container?.metadata.get("tk:parse-time-millis"), null);
});

test("an embedded document that fails notes it on its own record and the parse goes on", async () => {
  const records = await new Ripstream({ detector, parser: containerParser("c0") }).parseRecursive(new Uint8Array([1]));
  const c0 = records.find((record) => record.metadata.get("tk:resource-name") === "c0");
  assert.equal(c0?.metadata.get("tk:exception:embedded-exception"), "MalformedDocumentError: bad c0");
  assert.equal(records[0]?.metadata.get("tk:exception:container-exception"), null);
  assert.ok(records.some((record) => record.metadata.get("tk:resource-name") === "c1"), "the sibling is still parsed");
});
