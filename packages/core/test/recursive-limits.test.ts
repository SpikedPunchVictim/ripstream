import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  BodyContentHandler,
  CONTEXT_KEYS,
  LimitExceededError,
  MediaType,
  Metadata,
  ParseContext,
  RecursiveParserWrapper,
  Ripstream,
  RipstreamInputStream,
  type ContentHandler,
  type Detector,
  type Parser,
} from "../src/index.ts";
import {
  ParsingEmbeddedDocumentExtractor,
  type EmbeddedDocumentExtractor,
} from "../src/embedded.ts";

const detector: Detector = { detect: async () => MediaType.TEXT_PLAIN };

/** Text "root" plus `children` embedded docs; each child nests `nest` levels. */
function embeddingParser(children: number, nest: number, text = "x"): Parser {
  const parser: Parser = {
    name: "Embedding",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(
      stream: RipstreamInputStream,
      handler: ContentHandler,
      _m: Metadata,
      ctx: ParseContext,
    ): Promise<void> {
      await handler.startElement?.("", "body", "body", new AttributesImpl([]));
      await handler.characters?.(text, 0, text.length);
      await handler.endElement?.("", "body", "body");
      const depth = ctx.get(CONTEXT_KEYS.EMBEDDED_DEPTH) ?? 0;
      if (depth > 0) for await (const _chunk of stream) { /* consume */ }
      const extractor: EmbeddedDocumentExtractor =
        (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as
          | EmbeddedDocumentExtractor
          | undefined) ?? new ParsingEmbeddedDocumentExtractor();
      const count = depth === 0 ? children : depth < nest ? 1 : 0;
      for (let i = 0; i < count; i++) {
        const metadata = new Metadata();
        metadata.set("tk:resource-name", `c${i}`);
        await extractor.parseEmbedded(
          await RipstreamInputStream.from(new Uint8Array([1])),
          handler,
          metadata,
          ctx,
        );
      }
    },
  };
  return parser;
}

test("parseRecursive enforces maxNodeDepth", async () => {
  const ripstream = new Ripstream({ detector, parser: embeddingParser(1, 30) });
  const records = await ripstream.parseRecursive(new Uint8Array([1]), {
    limits: { maxNodeDepth: 3 },
  });
  assert.ok(Math.max(...records.map((r) => r.depth)) <= 3);
  assert.ok(
    records.some((r) => r.exception instanceof LimitExceededError),
    "depth overflow is recorded as a limit error",
  );
});

test("parseRecursive enforces maxEmbeddedResources across the tree", async () => {
  const ripstream = new Ripstream({ detector, parser: embeddingParser(10, 0) });
  await assert.rejects(
    ripstream.parseRecursive(new Uint8Array([1]), {
      limits: { maxEmbeddedResources: 4 },
    }),
    LimitExceededError,
  );
});

test("parseRecursive caps total output across records", async () => {
  const ripstream = new Ripstream({ detector, parser: embeddingParser(5, 0, "y".repeat(100)) });
  const records = await ripstream.parseRecursive(new Uint8Array([1]), {
    limits: { maxOutputChars: 250 },
  });
  const total = records.reduce((n, r) => n + r.content.length, 0);
  assert.ok(total <= 250, `total ${total}`);
});

test("parseRecursive does not copy embedded text into ancestors", async () => {
  const ripstream = new Ripstream({ detector, parser: embeddingParser(1, 3, "z") });
  const records = await ripstream.parseRecursive(new Uint8Array([1]));
  for (const record of records) assert.equal(record.content, "z");
});

test("default extractor counts embedded resources globally, not per child context", async () => {
  const parser = embeddingParser(3, 2);
  const ripstream = new Ripstream({ detector, parser });
  await assert.rejects(
    ripstream.parseToString(new Uint8Array([1]), {
      limits: { maxEmbeddedResources: 4 },
    }),
    LimitExceededError,
  );
});

test("default extractor enforces maxTotalEmbeddedBytes across siblings", async () => {
  const ripstream = new Ripstream({ detector, parser: embeddingParser(5, 0) });
  await assert.rejects(
    ripstream.parseToString(new Uint8Array([1]), {
      limits: { maxTotalEmbeddedBytes: 3 },
    }),
    LimitExceededError,
  );
});

test("parseRecursive maxDocumentOutputChars caps each document without changing the total cap", async () => {
  const ripstream = new Ripstream({ detector, parser: embeddingParser(3, 0, "y".repeat(100)) });
  const records = await ripstream.parseRecursive(new Uint8Array([1]), {
    limits: { maxDocumentOutputChars: 150 },
  });
  assert.equal(records.length, 4);
  assert.ok(records.every((r) => r.exception === null));
  await assert.rejects(
    ripstream.parseRecursive(new Uint8Array([1]), { limits: { maxDocumentOutputChars: 50 } }),
    LimitExceededError,
  );
});

/** A root that embeds one child; the child (any document at depth > 0) writes `chars` characters of metadata. */
function childMetadataParser(chars: number): Parser {
  const inner = embeddingParser(1, 1);
  return {
    name: "ChildMetadata",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(stream, handler, metadata, ctx): Promise<void> {
      if ((ctx.get(CONTEXT_KEYS.EMBEDDED_DEPTH) ?? 0) > 0) metadata.set("big", "x".repeat(chars));
      else await inner.parse(stream, handler, metadata, ctx);
    },
  };
}

test("the default extractor applies maxMetadataTotalChars to an embedded document's metadata", async () => {
  const ripstream = new Ripstream({ detector, parser: childMetadataParser(600) });
  await assert.rejects(
    ripstream.parseToString(new Uint8Array([1]), { limits: { maxMetadataTotalChars: 500 } }),
    LimitExceededError,
  );
  await ripstream.parseToString(new Uint8Array([1]), { limits: { maxMetadataTotalChars: 5000 } });
});

test("parseRecursive applies maxMetadataTotalChars to an embedded document, whose failure it records on that document", async () => {
  const ripstream = new Ripstream({ detector, parser: childMetadataParser(600) });
  const refused = await ripstream.parseRecursive(new Uint8Array([1]), { limits: { maxMetadataTotalChars: 500 } });
  assert.ok(refused[1]?.exception instanceof LimitExceededError);
  assert.equal(refused[1]?.metadata.has("big"), false);
  assert.equal(refused[0]?.exception, null);
  const records = await ripstream.parseRecursive(new Uint8Array([1]), { limits: { maxMetadataTotalChars: 5000 } });
  assert.equal(records[1]?.exception, null);
  assert.equal(records[1]?.metadata.get("big")?.length, 600);
});

test("RecursiveParserWrapper applies maxMetadataTotalChars to the metadata it is given, not only to the facade's", async () => {
  const root: Parser = {
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    parse: async (_stream, _handler, metadata) => metadata.set("big", "x".repeat(600)),
  };
  const ctx = new ParseContext({ limits: { maxMetadataTotalChars: 500 } });
  const stream = await RipstreamInputStream.from(new Uint8Array([1]));
  await assert.rejects(
    new RecursiveParserWrapper(root).parse(stream, new BodyContentHandler(), new Metadata(), ctx),
    LimitExceededError,
  );
});
