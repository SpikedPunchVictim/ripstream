import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  ToXMLContentHandler,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
} from "@spikedpunch/ripstream-core";
import initSqlJs from "sql.js";
import {
  DEFAULT_MAX_GEOPKG_BYTES,
  DEFAULT_MAX_GEOPKG_CHARS,
  DEFAULT_MAX_GEOPKG_COLUMNS,
  DEFAULT_MAX_GEOPKG_ROWS,
  DEFAULT_MAX_GEOPKG_TABLES,
  GeoPkgParser,
  type GeoPkgParserOptions,
} from "../src/index.ts";
import { javaDoubleString, javaFloatString } from "../src/java-number.ts";
import { quoteIdentifier } from "../src/sql-js.ts";

/*
 * Pins found by mutation testing the GeoPackage reader (tikajs-68os.22): the default caps, how a column's declared type
 * (any case, with a size in parentheses) picks the way its cells are written, cells whose value does not fit the declared
 * type, the exact bounds of the character and byte caps, the names given to embedded blobs, and what happens when the
 * embedded-document extractor declines, fails or is aborted. The reference is Tika's JDBCTableReader and
 * GeoPkgTableReader, as in geopkg.test.ts; none of it was run against a Tika or sqlite-jdbc.
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

async function parseGeoPkg(
  bytes: Uint8Array,
  options: GeoPkgParserOptions = {},
  context: ParseContext = new ParseContext(),
): Promise<{ xml: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new ToXMLContentHandler();
  const metadata = new Metadata();
  try {
    await new GeoPkgParser(options).parse(stream, handler as ContentHandler, metadata, context);
  } finally {
    await stream.close();
  }
  return { xml: handler.toString(), metadata };
}

function rowsOf(xml: string, table: string): string[][] {
  const found = new RegExp(`<table name="${table}">(.*?)</table>`, "s").exec(xml);
  assert.ok(found, `table ${table}`);
  const body = found[1]!.split("</thead>")[1] ?? "";
  return [...body.matchAll(/<tr>(.*?)<\/tr>/gs)].map((row) => [...row[1]!.matchAll(/<td>(.*?)<\/td>/gs)].map((cell) => cell[1]!));
}

function headersOf(xml: string, table: string): string[] {
  const found = new RegExp(`<table name="${table}">(.*?)</thead>`, "s").exec(xml);
  assert.ok(found, `table ${table}`);
  return [...found[1]!.matchAll(/<th>(.*?)<\/th>/gs)].map((cell) => cell[1]!);
}

interface Embedded {
  readonly metadata: Metadata;
  readonly bytes: number[];
}

/** A context whose extractor records the blobs it is handed. */
function recordingContext(embedded: Embedded[]): ParseContext {
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, {
    shouldParseEmbedded: () => true,
    async parseEmbedded(stream, _handler, metadata) {
      embedded.push({ metadata, bytes: [...(await stream.readFully(1024))] });
    },
  } satisfies EmbeddedDocumentExtractor);
  return context;
}

test("the default caps are the documented ones", () => {
  assert.equal(DEFAULT_MAX_GEOPKG_BYTES, 256 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_GEOPKG_TABLES, 10_000);
  assert.equal(DEFAULT_MAX_GEOPKG_COLUMNS, 500);
  assert.equal(DEFAULT_MAX_GEOPKG_ROWS, 1_000_000);
  assert.equal(DEFAULT_MAX_GEOPKG_CHARS, 64 * 1024 * 1024);
});

test("the parser says it needs random access", () => {
  assert.equal(new GeoPkgParser().capabilities.requiresRandomAccess, true);
});

test("a file of exactly maxBytes is read, and one byte more is a limit", async () => {
  const bytes = buildDatabase(["CREATE TABLE t (v TEXT)", "INSERT INTO t VALUES ('x')"]);
  await parseGeoPkg(bytes, { maxBytes: bytes.byteLength });
  await assert.rejects(parseGeoPkg(bytes, { maxBytes: bytes.byteLength - 1 }), LimitExceededError);
});

test("the header integers are written as Java's Integer.toString(value, 16) writes a negative one", async () => {
  const bytes = buildDatabase(["PRAGMA application_id = -1", "PRAGMA user_version = -2147483648", "CREATE TABLE t (v TEXT)"]);
  const { metadata } = await parseGeoPkg(bytes);
  assert.equal(metadata.get("sqlite3:application_id"), "-1");
  assert.equal(metadata.get("sqlite3:user_version"), "-80000000");
});

test("a stored generated column is left out as a virtual one is", async () => {
  const bytes = buildDatabase([
    "CREATE TABLE g (a INTEGER, d INTEGER GENERATED ALWAYS AS (a * 2) STORED, b TEXT)",
    "INSERT INTO g (a, b) VALUES (4, 'x')",
  ]);
  const { xml } = await parseGeoPkg(bytes);
  assert.deepEqual(headersOf(xml, "g"), ["a", "b"]);
  assert.deepEqual(rowsOf(xml, "g"), [["4", "x"]]);
});

test("a declared type is matched in any case and without its size: boolean, Double, double precision, DOUBLE(10,2), float(24)", async () => {
  // 12345678.5 is written 1.23456785E7 by Double.toString and 12345678.5 by SQLite; a float32 of pi is 3.1415927
  const bytes = buildDatabase([
    "CREATE TABLE ty (a boolean, b Double, c double precision, d DOUBLE(10,2), e float(24), f VARCHAR(10), g Float)",
    "INSERT INTO ty VALUES (5, 12345678.5, 12345678.5, 12345678.5, 3.14159265358979, 'v', 3.14159265358979)",
  ]);
  const { xml } = await parseGeoPkg(bytes);
  assert.deepEqual(rowsOf(xml, "ty"), [["true", "1.23456785E7", "1.23456785E7", "1.23456785E7", "3.1415927", "v", "3.1415927"]]);
});

test("a column with no declared type is typed by each cell's value", async () => {
  const bytes = buildDatabase([
    "CREATE TABLE u (a, b, c, d, data)",
    "INSERT INTO u VALUES ('text', 7, 3.14159265358979, x'0a0b', NULL)",
  ]);
  const embedded: Embedded[] = [];
  const { xml } = await parseGeoPkg(bytes, {}, recordingContext(embedded));
  const [row] = rowsOf(xml, "u");
  assert.equal(row![0], "text");
  assert.equal(row![1], "7");
  // a REAL in a column with no type is a FLOAT to sqlite-jdbc, so a float32 in Java
  assert.equal(row![2], "3.1415927");
  assert.match(row![3]!, /^<span type="blob" column_name="d" row_number="0">/);
  // a NULL in a column with no type is not a BLOB, even in a column called data: no span
  assert.equal(row![4], "");
  assert.deepEqual(embedded.map((e) => e.bytes), [[0x0a, 0x0b]]);
});

test("a value that does not fit its declared type is written as the text it is", async () => {
  const bytes = buildDatabase([
    "CREATE TABLE m (b BOOLEAN, f FLOAT, d DOUBLE, k BLOB, c CLOB)",
    "INSERT INTO m VALUES ('yes', 'abc', 'def', 'plain', x'0102')",
    "INSERT INTO m VALUES ('no', 'ghi', 'jkl', 12, x'03')",
  ]);
  const embedded: Embedded[] = [];
  const { xml } = await parseGeoPkg(bytes, {}, recordingContext(embedded));
  const rows = rowsOf(xml, "m");
  assert.deepEqual(rows.map((row) => row.slice(0, 4)), [["yes", "abc", "def", "plain"], ["no", "ghi", "jkl", "12"]]);
  // a blob in a column declared CLOB is still a blob
  assert.match(rows[0]![4]!, /^<span type="blob" column_name="c" row_number="0">/);
  assert.deepEqual(embedded.map((e) => e.bytes), [[1, 2], [3]]);
});

test("the characters of cell text are counted exactly against maxChars: the cap is allowed, one more is not", async () => {
  const bytes = buildDatabase(["CREATE TABLE t (v TEXT)", "INSERT INTO t VALUES ('ab'), ('cde'), (NULL), ('')"]);
  await parseGeoPkg(bytes, { maxChars: 5 });
  await assert.rejects(parseGeoPkg(bytes, { maxChars: 4 }), LimitExceededError);
});

test("a blob's resource name has no directory in it: FilenameUtils.getName of <column>_<row>", async () => {
  const bytes = buildDatabase([
    `CREATE TABLE t ("dir/tile" BLOB, "dir\\tile2" BLOB, "a/b\\c" BLOB, plain BLOB)`,
    "INSERT INTO t VALUES (x'01', x'02', x'03', x'04')",
  ]);
  const embedded: Embedded[] = [];
  await parseGeoPkg(bytes, {}, recordingContext(embedded));
  assert.deepEqual(embedded.map((e) => e.metadata.get("tk:resource-name")), ["tile_0", "tile2_0", "c_0", "plain_0"]);
  assert.deepEqual(embedded.map((e) => e.metadata.get("database:column-name")), ["dir/tile", "dir\\tile2", "a/b\\c", "plain"]);
});

test("an extractor that declines a blob is not asked to parse it, and the span is written empty", async () => {
  const bytes = buildDatabase(["CREATE TABLE t (tile BLOB)", "INSERT INTO t VALUES (x'01')"]);
  const context = new ParseContext();
  let parsed = 0;
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, {
    shouldParseEmbedded: () => false,
    async parseEmbedded() {
      parsed++;
    },
  } satisfies EmbeddedDocumentExtractor);
  const { xml } = await parseGeoPkg(bytes, {}, context);
  assert.equal(parsed, 0);
  assert.deepEqual(rowsOf(xml, "t"), [['<span type="blob" column_name="tile" row_number="0"></span>']]);
});

test("a blob that fails while the parse is aborted ends the parse, whatever the error was", async () => {
  const bytes = buildDatabase(["CREATE TABLE t (tile BLOB)", "INSERT INTO t VALUES (x'01')"]);
  const controller = new AbortController();
  const context = new ParseContext({ signal: controller.signal });
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, {
    shouldParseEmbedded: () => true,
    async parseEmbedded() {
      controller.abort();
      throw new Error("interrupted");
    },
  } satisfies EmbeddedDocumentExtractor);
  await assert.rejects(parseGeoPkg(bytes, {}, context));
});

test("a blob that fails is noted as the error's name and message, or as the text of what was thrown", async () => {
  const bytes = buildDatabase(["CREATE TABLE t (tile BLOB)", "INSERT INTO t VALUES (x'01'), (x'02')"]);
  const failure = new MalformedDocumentError("not an image");
  const thrown: unknown[] = [failure, "just text"];
  const metadatas: Metadata[] = [];
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, {
    shouldParseEmbedded: () => true,
    async parseEmbedded(_stream, _handler, metadata) {
      metadatas.push(metadata);
      throw thrown.shift();
    },
  } satisfies EmbeddedDocumentExtractor);
  await parseGeoPkg(bytes, {}, context);
  assert.deepEqual(metadatas[0]!.getAll("tk:exception:embedded-exception"), [`${failure.name}: not an image`]);
  assert.deepEqual(metadatas[1]!.getAll("tk:exception:embedded-exception"), ["just text"]);
});

test("a column whose name has a quote in it is read", async () => {
  const bytes = buildDatabase([`CREATE TABLE t ("a""b" TEXT, c TEXT)`, `INSERT INTO t VALUES ('one', 'two')`]);
  const { xml } = await parseGeoPkg(bytes);
  assert.deepEqual(headersOf(xml, "t"), ['a"b', "c"]);
  assert.deepEqual(rowsOf(xml, "t"), [["one", "two"]]);
  assert.equal(quoteIdentifier('a"b"c'), '"a""b""c"');
});

test("a virtual table that cannot be connected for a reason other than a missing module fails the parse", async () => {
  const database = new SQL.Database();
  database.run("PRAGMA writable_schema = 1");
  // fts3 is in sql.js; this tokenizer is not, so reading the table's columns fails when SQLite connects it
  database.run(
    "INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('table', 'bad', 'bad', 0, 'CREATE VIRTUAL TABLE bad USING fts3(a, tokenize=nosuch)')",
  );
  database.run("PRAGMA writable_schema = 0");
  const bytes = database.export();
  database.close();
  await assert.rejects(parseGeoPkg(bytes), MalformedDocumentError);
});

test("javaDoubleString: infinities, hundreds, and the closest two digits", () => {
  assert.equal(javaDoubleString(Number.POSITIVE_INFINITY), "Infinity");
  assert.equal(javaDoubleString(Number.NEGATIVE_INFINITY), "-Infinity");
  assert.equal(javaDoubleString(100), "100.0");
  assert.equal(javaDoubleString(1234567), "1234567.0");
  assert.equal(javaDoubleString(12345678), "1.2345678E7");
  assert.equal(javaDoubleString(-1.5e10), "-1.5E10");
  assert.equal(javaDoubleString(0.00123), "0.00123");
  assert.equal(javaDoubleString(1e-5), "1.0E-5");
  assert.equal(javaDoubleString(-0.5), "-0.5");
  assert.equal(javaDoubleString(Number.MIN_VALUE), "4.9E-324");
  assert.equal(javaDoubleString(2e-323), "2.0E-323");
  assert.equal(javaDoubleString(1.7976931348623157e308), "1.7976931348623157E308");
});

test("javaFloatString: the fewest digits that read back as the same float, and at least two", () => {
  assert.equal(javaFloatString(Number.NaN), "NaN");
  assert.equal(javaFloatString(Number.POSITIVE_INFINITY), "Infinity");
  assert.equal(javaFloatString(Number.NEGATIVE_INFINITY), "-Infinity");
  assert.equal(javaFloatString(0), "0.0");
  assert.equal(javaFloatString(-0), "-0.0");
  assert.equal(javaFloatString(1e10), "1.0E10");
  assert.equal(javaFloatString(1234567), "1234567.0");
  assert.equal(javaFloatString(-0.1), "-0.1");
  assert.equal(javaFloatString(0.001), "0.001");
  assert.equal(javaFloatString(3.4028234663852886e38), "3.4028235E38"); // Float.MAX_VALUE
  assert.equal(javaFloatString(1.1754943508222875e-38), "1.1754944E-38"); // Float.MIN_NORMAL: eight digits are enough (JDK 19+)
  // a float32 that needs all nine digits to read back
  assert.equal(javaFloatString(1.0486059453089844e-36), "1.04860595E-36");
  // Float.MIN_VALUE: one digit reads back as the same float, but Java takes the closest two and writes 1.4E-45
  assert.equal(javaFloatString(1.401298464324817e-45), "1.4E-45");
  // a float32 that is a double-rounding of a decimal: 16777216 is exact, 16777217 is not a float32
  assert.equal(javaFloatString(16777217), "1.6777216E7");
});
