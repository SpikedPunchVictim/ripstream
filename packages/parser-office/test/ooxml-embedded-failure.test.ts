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
import { strToU8, zipSync } from "fflate";
import { OoxmlParser } from "../src/index.ts";

/*
 * Tika's CompositeParser records each failed embedded child's exception on the container (EMBEDDED_EXCEPTION). A part that
 * fails must not fail the package, and the container's own metadata, not the part's (a plain parse drops it), carries the
 * marker. A limit is not one of those failures: it ends the parse. Read from Tika's source, not run.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const FILES = {
  "[Content_Types].xml": strToU8("<Types/>"),
  "word/document.xml": strToU8(`<w:document ${W}><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>`),
  "word/embeddings/oleObject1.bin": new Uint8Array([1, 2, 3, 4]),
};

function failing(failure: Error): EmbeddedDocumentExtractor {
  return {
    shouldParseEmbedded: () => true,
    parseEmbedded: () => Promise.reject(failure),
  };
}

async function parseWith(extractor: EmbeddedDocumentExtractor): Promise<Metadata> {
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const stream = await RipstreamInputStream.from(zipSync(FILES));
  const metadata = new Metadata();
  try {
    await new OoxmlParser().parse(stream, new BodyContentHandler(), metadata, context);
  } finally {
    await stream.close();
  }
  return metadata;
}

test("a failed embedded part puts its exception on the package's metadata", async () => {
  const metadata = await parseWith(failing(new MalformedDocumentError("part is cut short")));
  assert.deepEqual(metadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION), ["MalformedDocumentError: part is cut short"]);
});

test("a clean embedded part leaves no marker", async () => {
  const metadata = await parseWith({ shouldParseEmbedded: () => true, parseEmbedded: () => Promise.resolve() });
  assert.deepEqual(metadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION), []);
});

test("a limit reached in an embedded part still ends the parse", async () => {
  await assert.rejects(parseWith(failing(new LimitExceededError("too big"))), LimitExceededError);
});
