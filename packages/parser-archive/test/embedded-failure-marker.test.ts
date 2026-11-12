import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  TIKA_KEYS,
  XHTMLContentHandler,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
} from "@spikedpunch/ripstream-core";
import { parseEntry } from "../src/util.ts";

/*
 * An archive entry that fails is swallowed so the next entry is taken (as Tika's ParsingEmbeddedDocumentExtractor does), and
 * the archive's own metadata gets the tk:exception:embedded-exception marker (Tika: X-TIKA:EXCEPTION:embedded_exception, put
 * on the container by CompositeParser.recordEmbeddedMetadata). Read from source, not run.
 */

/** Writes some text of its own and then fails. */
class PartialThenFail implements EmbeddedDocumentExtractor {
  readonly seen: Metadata[] = [];
  readonly #failure: Error;

  constructor(failure: Error) {
    this.#failure = failure;
  }

  shouldParseEmbedded(): boolean {
    return true;
  }

  async parseEmbedded(_stream: unknown, handler: ContentHandler, metadata: Metadata): Promise<void> {
    this.seen.push(metadata);
    await handler.characters?.("partial text", 0, 12);
    throw this.#failure;
  }
}

async function entry(extractor: EmbeddedDocumentExtractor): Promise<{ text: string; archive: Metadata }> {
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const body = new BodyContentHandler();
  const archive = new Metadata();
  const xhtml = new XHTMLContentHandler(body, archive);
  await xhtml.startDocument();
  await parseEntry(xhtml, "a.bin", new Uint8Array([1, 2, 3]), archive, ctx);
  await xhtml.endDocument();
  return { text: body.toString(), archive };
}

test("an entry that fails after writing text is marked on the archive's metadata, and its partial text stays", async () => {
  const { text, archive } = await entry(new PartialThenFail(new MalformedDocumentError("entry is cut short")));
  assert.match(text, /partial text/);
  assert.deepEqual(archive.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION), ["MalformedDocumentError: entry is cut short"]);
});

test("the entry's own metadata still gets the marker", async () => {
  const extractor = new PartialThenFail(new MalformedDocumentError("entry is cut short"));
  await entry(extractor);
  assert.equal(extractor.seen[0]!.get(TIKA_KEYS.EMBEDDED_EXCEPTION), "MalformedDocumentError: entry is cut short");
});

test("an entry that parses leaves the archive unmarked", async () => {
  const { archive } = await entry({ shouldParseEmbedded: () => true, parseEmbedded: async () => {} });
  assert.equal(archive.get(TIKA_KEYS.EMBEDDED_EXCEPTION), null);
});

test("a limit ends the parse instead of becoming a marker", async () => {
  await assert.rejects(entry(new PartialThenFail(new LimitExceededError("too much"))), LimitExceededError);
});
