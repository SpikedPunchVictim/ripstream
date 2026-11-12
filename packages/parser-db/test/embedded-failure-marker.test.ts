import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
} from "@spikedpunch/ripstream-core";
import initSqlJs from "sql.js";
import { SqliteParser } from "../src/index.ts";

/*
 * A blob that is a document and fails to parse does not end the parse (Tika's extractor swallows it), and the database's own
 * metadata gets the tk:exception:embedded-exception marker, as CompositeParser.recordEmbeddedMetadata puts a failed child's
 * exception on the container. Read from source, not run.
 */

const require = createRequire(import.meta.url);
const SQL = await initSqlJs({ locateFile: (file) => join(dirname(require.resolve("sql.js")), file) });

function buildDatabase(statements: readonly string[]): Uint8Array {
  const database = new SQL.Database();
  for (const statement of statements) database.run(statement);
  const bytes = database.export();
  database.close();
  return bytes;
}

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

const database = buildDatabase(["CREATE TABLE t (b BLOB)", "INSERT INTO t VALUES (x'0102030405')", "INSERT INTO t VALUES (x'0607')"]);

async function parseWith(extractor: EmbeddedDocumentExtractor): Promise<{ text: string; metadata: Metadata }> {
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const stream = await RipstreamInputStream.from(database);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await new SqliteParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

test("a blob that fails after writing text is marked on the database's metadata, once per blob, and its partial text stays", async () => {
  const { text, metadata } = await parseWith(new PartialThenFail(new MalformedDocumentError("blob is cut short")));
  assert.match(text, /partial text/);
  assert.deepEqual(metadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION), [
    "MalformedDocumentError: blob is cut short",
    "MalformedDocumentError: blob is cut short",
  ]);
});

test("the blob's own metadata still gets the marker", async () => {
  const extractor = new PartialThenFail(new MalformedDocumentError("blob is cut short"));
  await parseWith(extractor);
  assert.equal(extractor.seen[0]!.get(TIKA_KEYS.EMBEDDED_EXCEPTION), "MalformedDocumentError: blob is cut short");
});

test("blobs that parse leave the database unmarked", async () => {
  const { metadata } = await parseWith({ shouldParseEmbedded: () => true, parseEmbedded: async () => {} });
  assert.equal(metadata.get(TIKA_KEYS.EMBEDDED_EXCEPTION), null);
});

test("a limit in a blob ends the parse instead of becoming a marker", async () => {
  await assert.rejects(parseWith(new PartialThenFail(new LimitExceededError("too much"))), LimitExceededError);
});
