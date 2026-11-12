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
  type EmbeddedDocumentExtractor,
} from "@spikedpunch/ripstream-core";
import { PDFDocument } from "pdf-lib";
import { PdfParser } from "../src/index.ts";

/*
 * A PDF attachment that fails is listed by name, and the exception goes on the PDF's metadata, as Tika's CompositeParser
 * records each failed child. A limit or abort in an attachment ends the parse; it used to be swallowed. Read from Tika's
 * source, not run.
 */

async function parseWith(extractor: EmbeddedDocumentExtractor): Promise<{ text: string; metadata: Metadata }> {
  const document = await PDFDocument.create();
  document.addPage();
  await document.attach(new TextEncoder().encode("attached text"), "note.txt", { mimeType: "text/plain" });
  const stream = await RipstreamInputStream.from(await document.save());
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await new PdfParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

const failing = (failure: Error): EmbeddedDocumentExtractor => ({
  shouldParseEmbedded: () => true,
  parseEmbedded: () => Promise.reject(failure),
});

test("a failed attachment is listed and its exception is on the PDF's metadata", async () => {
  const { text, metadata } = await parseWith(failing(new MalformedDocumentError("attachment is cut short")));
  assert.match(text, /note\.txt/);
  assert.deepEqual(metadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION), ["MalformedDocumentError: attachment is cut short"]);
});

test("a clean attachment leaves no marker", async () => {
  const { metadata } = await parseWith({ shouldParseEmbedded: () => true, parseEmbedded: () => Promise.resolve() });
  assert.deepEqual(metadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION), []);
});

test("a limit reached in an attachment ends the parse", async () => {
  await assert.rejects(parseWith(failing(new LimitExceededError("too big"))), LimitExceededError);
});
