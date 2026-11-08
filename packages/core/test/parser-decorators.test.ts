import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  CompositeParser,
  ParserDeclinedError,
  BodyContentHandler,
  CONTEXT_KEYS,
  EmptyParser,
  ErrorParser,
  FallbackParser,
  MediaType,
  Metadata,
  MimeFilteringDecorator,
  ParseContext,
  RipstreamInputStream,
  UnsupportedFormatError,
  XHTMLContentHandler,
  type Parser,
} from "../src/index.ts";

function textParser(text: string): Parser {
  return {
    name: "Text",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(stream, handler) {
      for await (const _chunk of stream) {
        // Drain so a fallback must rely on rewind.
      }
      const xhtml = new XHTMLContentHandler(handler, new Metadata());
      await xhtml.startDocument();
      await xhtml.element("p", text);
      await xhtml.endDocument();
    },
  };
}

const failing: Parser = {
  name: "Failing",
  getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
  async parse(): Promise<void> {
    throw new Error("primary failed");
  },
};

async function run(parser: Parser, stream: RipstreamInputStream): Promise<string> {
  const handler = new BodyContentHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.PARSER, parser);
  await parser.parse(stream, handler, new Metadata(), context);
  return handler.toString();
}

test("fallback rewinds the stream and succeeds", async () => {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("data"));
  const text = await run(new FallbackParser(failing, textParser("fallback")), stream);
  await stream.close();
  assert.match(text, /fallback/);
});

test("fallback keeps the primary error when both fail", async () => {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("data"));
  await assert.rejects(
    run(new FallbackParser(failing, new ErrorParser()), stream),
    /primary failed/,
  );
  await stream.close();
});

test("MIME filtering narrows supported types", async () => {
  const decorated = new MimeFilteringDecorator(textParser("x"), [
    MediaType.parse("text/html")!,
  ]);
  assert.equal((await decorated.getSupportedTypes(new ParseContext())).size, 0);
  const all = new MimeFilteringDecorator(textParser("x"), [MediaType.TEXT_PLAIN]);
  assert.equal((await all.getSupportedTypes(new ParseContext())).size, 1);
  void new EmptyParser();
  void new AttributesImpl([]);
  void UnsupportedFormatError;
});

test("capabilities have safe defaults and merge overrides", async () => {
  const { parserCapabilities, DEFAULT_PARSER_CAPABILITIES } = await import(
    "../src/index.ts"
  );
  assert.deepEqual(parserCapabilities(new EmptyParser()), {
    ...DEFAULT_PARSER_CAPABILITIES,
  });
  const metadataOnly = {
    ...new EmptyParser(),
    capabilities: { metadataOnly: true },
  };
  assert.equal(parserCapabilities(metadataOnly).metadataOnly, true);
  assert.equal(parserCapabilities(metadataOnly).requiresRandomAccess, false);
});

test("auto-detect records detected and final content type", async () => {
  const { AutoDetectParser, MediaType: MT } = await import("../src/index.ts");
  const parser = new AutoDetectParser({
    detector: {
      async detect() {
        return MT.TEXT_PLAIN;
      },
    },
    parser: textParser("x"),
  });
  const metadata = new Metadata();
  const context = new ParseContext();
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("x"));
  await parser.parse(stream, new BodyContentHandler(), metadata, context);
  await stream.close();
  assert.equal(metadata.get("Content-Type"), "text/plain");
  assert.equal(metadata.get("tk:content-type-magic-detected"), "text/plain");
});

test("CompositeParser runs only the best match and prefers exact over wildcard", async () => {
  const calls: string[] = [];
  const named = (name: string, types: MediaType[]): Parser => ({
    name,
    getSupportedTypes: () => new Set(types),
    async parse(stream) {
      calls.push(name);
      for await (const _chunk of stream) {
        // consume
      }
    },
  });
  const parser = new CompositeParser({
    parsers: [
      named("wild", [MediaType.parseOrThrow("text/*")]),
      named("first", [MediaType.TEXT_PLAIN]),
      named("second", [MediaType.TEXT_PLAIN]),
    ],
  });
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.CONTENT_TYPE, MediaType.TEXT_PLAIN);
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("abc"));
  await parser.parse(stream, new BodyContentHandler(), new Metadata(), context);
  assert.deepEqual(calls, ["first"]);
});

test("CompositeParser rewinds the stream when a parser declines", async () => {
  let seen = "";
  const declining: Parser = {
    name: "decline",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(stream) {
      await stream.read();
      throw new ParserDeclinedError("no");
    },
  };
  const reading: Parser = {
    name: "reader",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(stream) {
      for await (const chunk of stream) seen += new TextDecoder().decode(chunk);
    },
  };
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.CONTENT_TYPE, MediaType.TEXT_PLAIN);
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("abc"));
  await new CompositeParser({ parsers: [declining, reading] }).parse(
    stream,
    new BodyContentHandler(),
    new Metadata(),
    context,
  );
  assert.equal(seen, "abc");
});

test("CompositeParser throws UnsupportedFormatError when every candidate declines", async () => {
  const declining: Parser = {
    name: "decline",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse() {
      throw new ParserDeclinedError("no");
    },
  };
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.CONTENT_TYPE, MediaType.TEXT_PLAIN);
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("abc"));
  await assert.rejects(
    new CompositeParser({ parsers: [declining] }).parse(
      stream,
      new BodyContentHandler(),
      new Metadata(),
      context,
    ),
    UnsupportedFormatError,
  );
});

test("MimeFilteringDecorator filters async delegates", async () => {
  const delegate: Parser = {
    name: "Async",
    getSupportedTypes: async () =>
      new Set([MediaType.TEXT_PLAIN, MediaType.parseOrThrow("text/html")]),
    async parse() {},
  };
  const filtered = await new MimeFilteringDecorator(delegate, [
    MediaType.TEXT_PLAIN,
  ]).getSupportedTypes(new ParseContext());
  assert.deepEqual([...filtered].map(String), ["text/plain"]);
});
