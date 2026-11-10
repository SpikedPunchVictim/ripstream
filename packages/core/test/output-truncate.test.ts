import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  CONTEXT_KEYS,
  LimitExceededError,
  MediaType,
  Metadata,
  Ripstream,
  RipstreamInputStream,
  WriteLimitReachedError,
  WriteOutContentHandler,
  TextContentHandler,
  type ContentHandler,
  type Detector,
  type Parser,
} from "../src/index.ts";
import type { EmbeddedDocumentExtractor } from "../src/embedded.ts";

const FLAG = "tk:exception:write-limit-reached";
const detector: Detector = { detect: async () => MediaType.TEXT_PLAIN };

/** A parser whose body is `text`, written in one chunk; `swallow` makes it catch what its handler throws. */
function textParser(text: string, options: { swallow?: boolean } = {}): Parser {
  return {
    name: "Text",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(_stream, handler: ContentHandler): Promise<void> {
      await handler.startElement?.("", "body", "body", new AttributesImpl([]));
      try {
        await handler.characters?.(text, 0, text.length);
        await handler.characters?.("more", 0, 4);
      } catch (error) {
        if (options.swallow !== true) throw error;
      }
      await handler.endElement?.("", "body", "body");
    },
  };
}

test("parse: a truncating call answers with the text up to the limit and flags it", async () => {
  const ripstream = new Ripstream({ detector, parser: textParser("abcdefghij") });
  const result = await ripstream.parse(new Uint8Array([1]), { limits: { maxOutputChars: 4 }, onOutputLimit: "truncate" });
  assert.equal(result.text, "abcd");
  assert.equal(result.metadata.get(FLAG), "true");
  assert.equal(result.exception, undefined);
});

test("parse: without truncate the limit still rejects, and the text is not an answer", async () => {
  const ripstream = new Ripstream({ detector, parser: textParser("abcdefghij") });
  await assert.rejects(ripstream.parse(new Uint8Array([1]), { limits: { maxOutputChars: 4 } }), LimitExceededError);
});

test("parse: text that fits exactly is not truncated, and carries no flag", async () => {
  const ripstream = new Ripstream({ detector, parser: textParser("ab", { swallow: true }) });
  // "ab" and "more" are 6 characters: the limit is met, not passed.
  const exact = await ripstream.parse(new Uint8Array([1]), { limits: { maxOutputChars: 6 }, onOutputLimit: "truncate" });
  assert.equal(exact.text, "abmore");
  assert.equal(exact.metadata.get(FLAG), null);
});

test("parse: a parser that swallows the limit still gets a capped text and the flag", async () => {
  const ripstream = new Ripstream({ detector, parser: textParser("abcdefghij", { swallow: true }) });
  const result = await ripstream.parse(new Uint8Array([1]), { limits: { maxOutputChars: 4 }, onOutputLimit: "truncate" });
  assert.equal(result.text, "abcd");
  assert.equal(result.metadata.get(FLAG), "true");
});

test("parse: unlimited output (-1) never truncates", async () => {
  const ripstream = new Ripstream({ detector, parser: textParser("abcdefghij") });
  const result = await ripstream.parse(new Uint8Array([1]), { limits: { maxOutputChars: -1 }, onOutputLimit: "truncate" });
  assert.equal(result.text, "abcdefghijmore");
  assert.equal(result.metadata.get(FLAG), null);
});

test("parseToString and parseToHandler ignore truncate: they always throw at the limit", async () => {
  const ripstream = new Ripstream({ detector, parser: textParser("abcdefghij") });
  const options = { limits: { maxOutputChars: 4 }, onOutputLimit: "truncate" } as const;
  await assert.rejects(ripstream.parseToString(new Uint8Array([1]), options), LimitExceededError);
  await assert.rejects(ripstream.parseToHandler(new Uint8Array([1]), new TextContentHandler(), options), LimitExceededError);
});

test("parse: a caller's own WriteOutContentHandler limit is the caller's, not a truncation", async () => {
  const ripstream = new Ripstream({ detector, parser: textParser("abcdefghij") });
  const own = new WriteOutContentHandler(new TextContentHandler(), { writeLimit: 3 });
  await assert.rejects(ripstream.parseToHandler(new Uint8Array([1]), own), WriteLimitReachedError);
});

/**
 * A container that writes "text" and then parses embedded documents c0 (which has an inner document of its own) and c1,
 * each of which also writes "text".
 */
function containerParser(options: { swallow?: boolean } = {}): Parser {
  return {
    name: "Container",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(_stream, handler: ContentHandler, metadata, ctx): Promise<void> {
      const depth = ctx.get(CONTEXT_KEYS.EMBEDDED_DEPTH) ?? 0;
      const name = metadata.get("tk:resource-name");
      await handler.startElement?.("", "body", "body", new AttributesImpl([]));
      await handler.characters?.("text", 0, 4);
      await handler.endElement?.("", "body", "body");
      const extractor = ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor;
      const names = depth === 0 ? ["c0", "c1"] : name === "c0" ? ["inner.txt"] : [];
      for (const child of names) {
        const embedded = new Metadata();
        embedded.set("tk:resource-name", child);
        try {
          await extractor.parseEmbedded(await RipstreamInputStream.from(new Uint8Array([1])), handler, embedded, ctx);
        } catch (error) {
          if (options.swallow !== true) throw error;
        }
      }
    },
  };
}

test("parseRecursive: the output budget is shared; the record that hits it keeps its prefix and everything is flagged", async () => {
  const ripstream = new Ripstream({ detector, parser: containerParser() });
  const records = await ripstream.parseRecursive(new Uint8Array([9]), {
    limits: { maxOutputChars: 6 },
    onOutputLimit: "truncate",
  });
  assert.deepEqual(
    records.map((record) => [record.metadata.get("tk:resource-name"), record.content]),
    [[null, "text"], ["c0", "te"]],
    "the parse ends at the limit: the records so far are the answer",
  );
  assert.equal(records[0]?.metadata.get(FLAG), "true", "the container is flagged");
  assert.equal(records[1]?.metadata.get(FLAG), "true", "so is the document whose text was cut");
  assert.equal(records[1]?.metadata.get("tk:exception:embedded-exception"), null, "a cut is not that document's failure");
  assert.equal(records[0]?.exception, null);
  assert.equal(records[1]?.exception, null);
});

test("parseRecursive: a limit the whole parse stays under flags nothing", async () => {
  const ripstream = new Ripstream({ detector, parser: containerParser() });
  const records = await ripstream.parseRecursive(new Uint8Array([9]), {
    limits: { maxOutputChars: 100 },
    onOutputLimit: "truncate",
  });
  assert.equal(records.length, 4);
  assert.ok(records.every((record) => record.metadata.get(FLAG) === null));
});

test("parseRecursive: a parser that swallows the limit still gets the container flagged, and nothing more is kept", async () => {
  const ripstream = new Ripstream({ detector, parser: containerParser({ swallow: true }) });
  const records = await ripstream.parseRecursive(new Uint8Array([9]), {
    limits: { maxOutputChars: 6 },
    onOutputLimit: "truncate",
  });
  assert.equal(records[0]?.metadata.get(FLAG), "true");
  assert.equal(records[0]?.content, "text");
  assert.equal(records.map((record) => record.content).join(""), "textte", "later documents write nothing");
});

test("parseRecursive: the per-document limit stays a hard limit under truncate", async () => {
  const ripstream = new Ripstream({ detector, parser: containerParser() });
  await assert.rejects(
    ripstream.parseRecursive(new Uint8Array([9]), {
      limits: { maxDocumentOutputChars: 2 },
      onOutputLimit: "truncate",
    }),
    LimitExceededError,
  );
});

test("parseRecursive: without truncate the shared budget still records a document that overruns it", async () => {
  const ripstream = new Ripstream({ detector, parser: containerParser() });
  const records = await ripstream.parseRecursive(new Uint8Array([9]), { limits: { maxOutputChars: 6 } });
  const c0 = records.find((record) => record.metadata.get("tk:resource-name") === "c0");
  assert.match(c0?.metadata.get("tk:exception:embedded-exception") ?? "", /^LimitExceededError: Recursive output exceeds 6/);
  assert.equal(records[0]?.metadata.get(FLAG), null);
});
