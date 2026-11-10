import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  CONTEXT_KEYS,
  MediaType,
  Metadata,
  Ripstream,
  RipstreamInputStream,
  type ContentHandler,
  type Detector,
  type Parser,
  type ParseContext,
} from "../src/index.ts";
import { ParsingEmbeddedDocumentExtractor, type EmbeddedDocumentExtractor } from "../src/embedded.ts";

/*
 * `ParseOptions.unpackBytes` is what `/unpack` is built on: each embedded document's own bytes come back on its record,
 * up to a total budget, without disturbing the parse of the document.
 */

const detector: Detector = { detect: async () => MediaType.TEXT_PLAIN };

interface Child {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** The embedded parse fails after reading the stream. */
  readonly fails?: boolean;
  /** Documents this one embeds in turn. */
  readonly children?: readonly Child[];
}

/** A container that embeds `children`; an embedded document reads its stream whole and notes how much it saw. */
function parserOf(children: readonly Child[]): Parser {
  const childrenOf = new Map<string, readonly Child[]>();
  const failing = new Set<string>();
  const index = (list: readonly Child[]): void => {
    for (const child of list) {
      if (child.children !== undefined) childrenOf.set(child.name, child.children);
      if (child.fails === true) failing.add(child.name);
      if (child.children !== undefined) index(child.children);
    }
  };
  index(children);

  return {
    name: "Embedding",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(stream: RipstreamInputStream, handler: ContentHandler, metadata: Metadata, ctx: ParseContext): Promise<void> {
      await handler.startElement?.("", "body", "body", new AttributesImpl([]));
      await handler.endElement?.("", "body", "body");
      const depth = ctx.get(CONTEXT_KEYS.EMBEDDED_DEPTH) ?? 0;
      let mine: readonly Child[] = children;
      if (depth > 0) {
        let seen = 0;
        for await (const chunk of stream) seen += chunk.length;
        metadata.set("test:seen", String(seen));
        const name = metadata.get("tk:resource-name") ?? "";
        mine = childrenOf.get(name) ?? [];
        if (failing.has(name)) throw new Error(`cannot read ${name}`);
      }
      const extractor = (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ?? new ParsingEmbeddedDocumentExtractor();
      for (const child of mine) {
        const embedded = new Metadata();
        embedded.set("tk:resource-name", child.name);
        await extractor.parseEmbedded(await RipstreamInputStream.from(child.bytes), handler, embedded, ctx);
      }
    },
  };
}

const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values);

test("a parse that does not ask for the bytes gets none", async () => {
  const ripstream = new Ripstream({ detector, parser: parserOf([{ name: "a", bytes: bytesOf(1, 2, 3) }]) });
  const records = await ripstream.parseRecursive(bytesOf(9));
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.bytes === undefined));
});

test("each embedded document carries its own bytes; the container carries none", async () => {
  const children = [
    { name: "a", bytes: bytesOf(1, 2, 3) },
    { name: "b", bytes: bytesOf(4, 5) },
  ];
  const ripstream = new Ripstream({ detector, parser: parserOf(children) });
  const records = await ripstream.parseRecursive(bytesOf(9), { unpackBytes: 1024 });
  const [container, a, b] = records;
  assert.equal(container?.bytes, undefined);
  assert.deepEqual([...(a?.bytes ?? [])], [1, 2, 3]);
  assert.deepEqual([...(b?.bytes ?? [])], [4, 5]);
});

test("capturing the bytes leaves the embedded parse its whole stream", async () => {
  const ripstream = new Ripstream({ detector, parser: parserOf([{ name: "a", bytes: bytesOf(1, 2, 3, 4) }]) });
  const records = await ripstream.parseRecursive(bytesOf(9), { unpackBytes: 1024 });
  assert.equal(records[1]?.metadata.get("test:seen"), "4");
});

test("a document that fails, an empty one and a nested one all keep their bytes", async () => {
  const children: Child[] = [
    { name: "bad", bytes: bytesOf(7, 7), fails: true },
    { name: "empty", bytes: new Uint8Array(0) },
    { name: "outer", bytes: bytesOf(1), children: [{ name: "inner", bytes: bytesOf(2, 3) }] },
  ];
  const ripstream = new Ripstream({ detector, parser: parserOf(children) });
  const records = await ripstream.parseRecursive(bytesOf(9), { unpackBytes: 1024 });
  const byName = new Map(records.map((record) => [record.metadata.get("tk:resource-name"), record]));
  assert.ok(byName.get("bad")?.exception instanceof Error);
  assert.deepEqual([...(byName.get("bad")?.bytes ?? [])], [7, 7]);
  assert.equal(byName.get("empty")?.bytes?.length, 0);
  assert.deepEqual([...(byName.get("inner")?.bytes ?? [])], [2, 3]);
});

test("the budget is shared by the whole tree: a document that would pass it is left out, the parse goes on", async () => {
  const children: Child[] = [
    { name: "a", bytes: bytesOf(1, 2, 3, 4, 5) },
    { name: "b", bytes: bytesOf(6, 7, 8, 9, 10) },
    { name: "c", bytes: bytesOf(11, 12) },
  ];
  const ripstream = new Ripstream({ detector, parser: parserOf(children) });
  const records = await ripstream.parseRecursive(bytesOf(9), { unpackBytes: 8 });
  const byName = new Map(records.map((record) => [record.metadata.get("tk:resource-name"), record]));
  assert.equal(byName.get("a")?.bytes?.length, 5);
  assert.equal(byName.get("b")?.bytes, undefined, "5 more bytes would pass the 8 allowed");
  assert.equal(byName.get("c")?.bytes?.length, 2, "what still fits is kept");
  assert.equal(byName.get("b")?.exception, null, "leaving the bytes out is not the document's failure");
});

test("a budget of zero keeps only empty documents", async () => {
  const ripstream = new Ripstream({
    detector,
    parser: parserOf([
      { name: "a", bytes: bytesOf(1) },
      { name: "e", bytes: new Uint8Array(0) },
    ]),
  });
  const records = await ripstream.parseRecursive(bytesOf(9), { unpackBytes: 0 });
  assert.equal(records[1]?.bytes, undefined);
  assert.equal(records[2]?.bytes?.length, 0);
});

test("unpackBytes must be a non-negative whole number", async () => {
  const ripstream = new Ripstream({ detector, parser: parserOf([]) });
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(ripstream.parseRecursive(bytesOf(9), { unpackBytes: value }), RangeError, String(value));
  }
});
