import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  CONTEXT_KEYS,
  LimitExceededError,
  Metadata,
  OutputLimitContentHandler,
  ParseContext,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
  type ContentHandler,
  type Parser,
  XHTMLContentHandler,
} from "../src/index.ts";

const CHUNK = "x".repeat(100);
const attrs = new AttributesImpl([]);

/** Parent handler that records every characters() payload. */
function collector(): ContentHandler & { text: string } {
  const sink = {
    text: "",
    startDocument(): void {},
    endDocument(): void {},
    characters(ch: string, start: number, length: number): void {
      sink.text += ch.slice(start, start + length);
    },
  };
  return sink;
}

/** Child parser that emits `chunks` body chunks, then optionally fails. */
function chunkingChild(
  state: { emitted: number; finished: boolean },
  chunks: number,
  failAfter?: Error,
): Parser {
  return {
    name: "Chunking",
    getSupportedTypes: () => new Set(),
    async parse(stream, handler): Promise<void> {
      for await (const _chunk of stream) {
        /* consume at least the first chunk so the source is started */
        break;
      }
      await handler.startElement?.("", "html", "html", attrs);
      await handler.startElement?.("", "head", "head", attrs);
      await handler.startElement?.("", "title", "title", attrs);
      await handler.characters?.("HEAD-TITLE", 0, 10);
      await handler.endElement?.("", "title", "title");
      await handler.endElement?.("", "head", "head");
      await handler.startElement?.("", "body", "body", attrs);
      await handler.startElement?.("", "style", "style", attrs);
      await handler.characters?.("STYLE-TEXT", 0, 10);
      await handler.endElement?.("", "style", "style");
      await handler.startElement?.("", "script", "script", attrs);
      await handler.characters?.("SCRIPT-TEXT", 0, 11);
      await handler.endElement?.("", "script", "script");
      for (let i = 0; i < chunks; i++) {
        await handler.characters?.(CHUNK, 0, CHUNK.length);
        state.emitted += 1;
      }
      if (failAfter !== undefined) throw failAfter;
      await handler.endElement?.("", "body", "body");
      await handler.endElement?.("", "html", "html");
      state.finished = true;
    },
  };
}

async function runEmbedded(
  parser: Parser,
  parent: ContentHandler,
  ctx = new ParseContext({ limits: { maxOutputChars: -1 } }),
  stream?: RipstreamInputStream,
): Promise<void> {
  ctx.set(CONTEXT_KEYS.PARSER, parser);
  const input = stream ?? (await RipstreamInputStream.from(new Uint8Array([1, 2, 3])));
  try {
    await new ParsingEmbeddedDocumentExtractor().parseEmbedded(input, parent, new Metadata(), ctx);
  } finally {
    await input.close();
  }
}

test("embedded text is charged to the parent cap while the child is still parsing", async () => {
  const state = { emitted: 0, finished: false };
  const parent = new OutputLimitContentHandler(collector(), 1_000);
  await assert.rejects(runEmbedded(chunkingChild(state, 10_000), parent), LimitExceededError);
  assert.equal(state.finished, false);
  assert.ok(state.emitted < 20, `child emitted ${state.emitted} chunks before the cap fired`);
});

test("embedded child exactly at the cap succeeds", async () => {
  const state = { emitted: 0, finished: false };
  const sink = collector();
  const parent = new OutputLimitContentHandler(sink, 10 * CHUNK.length);
  await runEmbedded(chunkingChild(state, 10), parent);
  assert.equal(state.finished, true);
  assert.equal(sink.text, CHUNK.repeat(10));
});

test("embedded head, title, style and script text is not forwarded", async () => {
  const state = { emitted: 0, finished: false };
  const sink = collector();
  await runEmbedded(chunkingChild(state, 2), sink);
  assert.equal(sink.text, CHUNK.repeat(2));
});

test("embedded text already emitted stays in the parent when the child fails", async () => {
  const state = { emitted: 0, finished: false };
  const sink = collector();
  await assert.rejects(
    runEmbedded(chunkingChild(state, 3, new Error("child boom")), sink),
    /child boom/,
  );
  assert.equal(sink.text, CHUNK.repeat(3));
});

test("metered embedded source is closed when the child fails", async () => {
  let sourceClosed = false;
  async function* bytes(): AsyncGenerator<Uint8Array> {
    try {
      for (let i = 0; i < 100; i++) yield new Uint8Array(16);
    } finally {
      sourceClosed = true;
    }
  }
  const stream = await RipstreamInputStream.from(bytes());
  assert.equal(stream.length, null);
  const state = { emitted: 0, finished: false };
  await assert.rejects(
    runEmbedded(
      chunkingChild(state, 1, new Error("child boom")),
      collector(),
      undefined,
      stream,
    ),
    /child boom/,
  );
  assert.equal(sourceClosed, true);
});

/**
 * Parent that filters text per characters() call like a real document handler: a surrogate half that
 * arrives alone becomes U+FFFD, so a split pair is only healed if the sink forwards it whole.
 */
function filtering(sink: ContentHandler): ContentHandler {
  return new XHTMLContentHandler(sink, new Metadata());
}

/** Child that emits `pieces` to the handler as separate characters() calls inside <body>. */
function splittingChild(pieces: readonly string[]): Parser {
  return {
    name: "Splitting",
    getSupportedTypes: () => new Set(),
    async parse(_stream, handler): Promise<void> {
      await handler.startElement?.("", "body", "body", attrs);
      for (const piece of pieces) await handler.characters?.(piece, 0, piece.length);
      await handler.endElement?.("", "body", "body");
    },
  };
}

test("embedded text rejoins a surrogate pair split across two child chunks", async () => {
  const sink = collector();
  await runEmbedded(splittingChild(["A\uD83D", "\uDE00B"]), filtering(sink));
  assert.equal(sink.text, "A\u{1F600}B");
});

test("embedded text rejoins a pair split across a chunk that is only the high half", async () => {
  const sink = collector();
  await runEmbedded(splittingChild(["A", "\uD83D", "\uDE00", "B"]), filtering(sink));
  assert.equal(sink.text, "A\u{1F600}B");
});

test("embedded text still forwards a trailing lone high surrogate at the end of the child", async () => {
  const sink = collector();
  await runEmbedded(splittingChild(["A\uD83D"]), filtering(sink));
  assert.equal(sink.text, "A\uFFFD");
});

test("embedded text does not invent a pair from a lone low surrogate", async () => {
  const sink = collector();
  await runEmbedded(splittingChild(["A", "\uDE00B"]), filtering(sink));
  assert.equal(sink.text, "A\uFFFDB");
});
