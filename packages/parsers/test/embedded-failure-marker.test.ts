import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  TIKA_KEYS,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { HttpParser, MailParser } from "../src/index.ts";

/*
 * Tika's ParsingEmbeddedDocumentExtractor keeps what a failed child wrote and records the failure, and the container's metadata
 * gets one X-TIKA:EXCEPTION:embedded_exception (tk:exception:embedded-exception) per failed child (CompositeParser.
 * recordEmbeddedMetadata). Read from source, not run. Here the extractor throws and the container parser swallows the failure,
 * so the container's own metadata must carry the marker, not just the child's metadata, which a plain parse drops.
 */

/** Writes some text of its own and then fails, as a child that dies half way through does. */
class PartialThenFail implements EmbeddedDocumentExtractor {
  readonly seen: Metadata[] = [];
  readonly #failure: Error;

  constructor(failure: Error) {
    this.#failure = failure;
  }

  shouldParseEmbedded(): boolean {
    return true;
  }

  async parseEmbedded(stream: unknown, handler: ContentHandler, metadata: Metadata): Promise<void> {
    void stream;
    this.seen.push(metadata);
    await handler.characters?.("partial text", 0, 12);
    throw this.#failure;
  }
}

const FAILURE = new MalformedDocumentError("child is cut short");

const eml = (...parts: string[]): string => {
  const lines = ["Subject: parts", 'Content-Type: multipart/mixed; boundary="b"', ""];
  for (const part of parts) lines.push("--b", part, "");
  lines.push("--b--", "");
  return lines.join("\r\n");
};

const attachment = ["Content-Type: application/zip", 'Content-Disposition: attachment; filename="a.zip"', "", "payload"].join("\r\n");

async function parseWith(parser: Parser, text: string, extractor: EmbeddedDocumentExtractor): Promise<{ text: string; metadata: Metadata }> {
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(text));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await parser.parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

test("mail: a part that fails after writing text is marked on the message's metadata, and its partial text stays", async () => {
  const { text, metadata } = await parseWith(new MailParser(), eml(attachment), new PartialThenFail(FAILURE));
  assert.match(text, /partial text/);
  assert.deepEqual(metadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION), ["MalformedDocumentError: child is cut short"]);
});

test("mail: each failed part adds its own value, and a message whose parts parse has no marker", async () => {
  const two = await parseWith(new MailParser(), eml(attachment, attachment), new PartialThenFail(FAILURE));
  assert.equal(two.metadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION).length, 2);

  const clean: EmbeddedDocumentExtractor = { shouldParseEmbedded: () => true, parseEmbedded: async () => {} };
  const none = await parseWith(new MailParser(), eml(attachment), clean);
  assert.equal(none.metadata.get(TIKA_KEYS.EMBEDDED_EXCEPTION), null);
});

test("mail: the part's own metadata still gets the marker", async () => {
  const extractor = new PartialThenFail(FAILURE);
  await parseWith(new MailParser(), eml(attachment), extractor);
  assert.equal(extractor.seen[0]!.get(TIKA_KEYS.EMBEDDED_EXCEPTION), "MalformedDocumentError: child is cut short");
});

test("mail: a limit still ends the parse, and leaves no marker behind as if it were a bad part", async () => {
  await assert.rejects(
    parseWith(new MailParser(), eml(attachment), new PartialThenFail(new LimitExceededError("too much"))),
    LimitExceededError,
  );
});

const BODY = "hello";
const httpResponse = `HTTP/1.1 200 OK\nContent-Type: text/plain\nContent-Length: ${BODY.length}\n\n${BODY}`;

test("http: a payload that fails after writing text is marked on the response's metadata", async () => {
  const { text, metadata } = await parseWith(new HttpParser(), httpResponse, new PartialThenFail(FAILURE));
  assert.match(text, /partial text/);
  assert.deepEqual(metadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION), ["MalformedDocumentError: child is cut short"]);
});

test("http: the payload's own metadata still gets the marker", async () => {
  const extractor = new PartialThenFail(FAILURE);
  await parseWith(new HttpParser(), httpResponse, extractor);
  assert.equal(extractor.seen[0]!.get(TIKA_KEYS.EMBEDDED_EXCEPTION), "MalformedDocumentError: child is cut short");
});

test("http: a payload that parses leaves no marker", async () => {
  const clean: EmbeddedDocumentExtractor = { shouldParseEmbedded: () => true, parseEmbedded: async () => {} };
  const { metadata } = await parseWith(new HttpParser(), httpResponse, clean);
  assert.equal(metadata.get(TIKA_KEYS.EMBEDDED_EXCEPTION), null);
});

test("mail: a part that is a container records its own failed children on the message too", async () => {
  const nested: EmbeddedDocumentExtractor = {
    shouldParseEmbedded: () => true,
    async parseEmbedded(_stream, _handler, metadata): Promise<void> {
      metadata.add(TIKA_KEYS.EMBEDDED_EXCEPTION, "MalformedDocumentError: nested child");
    },
  };
  const { metadata } = await parseWith(new MailParser(), eml(attachment), nested);
  assert.deepEqual(metadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION), ["MalformedDocumentError: nested child"]);
});
