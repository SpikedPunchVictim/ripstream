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
  ToXMLContentHandler,
  type EmbeddedDocumentExtractor,
} from "@spikedpunch/ripstream-core";
import initSqlJs from "sql.js";
import { SqliteParser } from "../src/index.ts";

/*
 * SQLite3Parser as Tika's SQLite3ParserTest, AbstractDBParser, SQLite3DBParser and JDBCTableReader have it, read from the
 * Tika source and not run against a Tika or sqlite-jdbc (tikajs-68os.64). The real file of testSpacesInBodyContentHandler
 * is a fixture, packages/parsers/test/fixtures/database/sqlite3-tika.json.
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

async function parseSqlite(
  bytes: Uint8Array,
  context = new ParseContext(),
): Promise<{ text: string; xml: string; metadata: Metadata }> {
  const run = async (handler: BodyContentHandler | ToXMLContentHandler): Promise<Metadata> => {
    const stream = await RipstreamInputStream.from(bytes);
    const metadata = new Metadata();
    try {
      await new SqliteParser().parse(stream, handler, metadata, context);
    } finally {
      await stream.close();
    }
    return metadata;
  };
  const body = new BodyContentHandler();
  const metadata = await run(body);
  const xml = new ToXMLContentHandler();
  await run(xml);
  return { text: body.toString(), xml: xml.toString(), metadata };
}

test("reads SQLite tables: database:table-name for each, a header row, a row for each record", async () => {
  const { text, xml, metadata } = await parseSqlite(
    buildDatabase([
      "CREATE TABLE people (name TEXT, age INTEGER)",
      "INSERT INTO people VALUES ('Ada', 36), ('Grace', 45)",
      "CREATE TABLE places (city TEXT)",
    ]),
  );
  assert.deepEqual(metadata.getAll("database:table-name"), ["people", "places"]);
  assert.equal(metadata.get("sqlite:table-count"), null);
  assert.match(text, /Ada\t36\n/);
  assert.match(text, /Grace\t45\n/);
  const flat = xml.replace(/\s+/g, "");
  assert.match(flat, /<tablename="people"><thead><tr><th>name<\/th><th>age<\/th><\/tr><\/thead><tbody><tr><td>Ada<\/td><td>36<\/td><\/tr>/);
  assert.match(flat, /<tablename="places"><thead><tr><th>city<\/th><\/tr><\/thead><tbody><\/tbody><\/table>/);
});

test("sqlite3:application_id and sqlite3:user_version are base 16, a negative one with a minus sign", async () => {
  const { metadata } = await parseSqlite(
    buildDatabase(["PRAGMA application_id = 1196444487", "PRAGMA user_version = -1", "CREATE TABLE t (a)"]),
  );
  assert.equal(metadata.get("sqlite3:application_id"), "47504b47");
  assert.equal(metadata.get("sqlite3:user_version"), "-1");
});

test("a row of nulls is empty cells, as SQLite3ParserTest.testNulls", async () => {
  const { xml } = await parseSqlite(
    buildDatabase(["CREATE TABLE t (pk INT PRIMARY KEY, a INTEGER, b TEXT)", "INSERT INTO t (pk) VALUES (2)"]),
  );
  assert.match(xml.replace(/\s+/g, ""), /<tr><td>2<\/td><td><\/td><td><\/td><\/tr>/);
});

test("a FLOAT column is written as a Java float and a BOOLEAN as true or false", async () => {
  const { text } = await parseSqlite(
    buildDatabase([
      "CREATE TABLE t (f FLOAT, d DOUBLE, b BOOLEAN)",
      "INSERT INTO t VALUES (2.3, 2.4, 1)",
    ]),
  );
  assert.match(text, /2\.3\t2\.4\ttrue\n/);
});

test("every BLOB is an embedded document, with the database:* metadata of Tika's JDBCTableReader", async () => {
  const embedded: Array<{ metadata: Metadata; bytes: number[] }> = [];
  const extractor: EmbeddedDocumentExtractor = {
    shouldParseEmbedded: () => true,
    async parseEmbedded(stream, _handler, metadata) {
      embedded.push({ metadata, bytes: [...(await stream.readFully(1024))] });
    },
  };
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  // GeoPackage's `geom` and `data` are not special here: SQLite3Parser parses every BLOB column.
  await parseSqlite(
    buildDatabase(["CREATE TABLE t (id INTEGER, geom BLOB, data BLOB)", "INSERT INTO t VALUES (1, x'01', x'0a0b')"]),
    context,
  );
  // run twice by parseSqlite (text, xml): the first two are the first run
  assert.deepEqual(
    embedded.slice(0, 2).map((e) => e.bytes),
    [[0x01], [0x0a, 0x0b]],
  );
  const first = embedded[0]!.metadata;
  assert.equal(first.get("database:table-name"), "t");
  assert.equal(first.get("database:column-name"), "geom");
  assert.equal(first.get("database:ROW_NUM"), "0");
  assert.equal(first.get("database:IS_BLOB"), "true");
});

test("at most 100 rows are read from each table, the rest being left out without an error", async () => {
  const inserts = Array.from({ length: 150 }, (_, i) => `INSERT INTO t VALUES (${i})`);
  const { text } = await parseSqlite(buildDatabase(["CREATE TABLE t (n INTEGER)", ...inserts]));
  assert.match(text, /\t99\n/);
  assert.doesNotMatch(text, /\t100\n/);
});

test("a TEXT cell is cut to 4,096 characters", async () => {
  const { text } = await parseSqlite(
    buildDatabase(["CREATE TABLE t (s TEXT)", "INSERT INTO t VALUES (replace(hex(zeroblob(5000)), '00', 'a'))"]),
  );
  const cell = text.split("\n").find((line) => line.startsWith("\taaa"))!.slice(1);
  assert.equal(cell.length, 4_096);
});

test("more than a million characters of cell text is a LimitExceededError", async () => {
  // 100 rows x 4,096 characters x 3 tables is over the limit
  const statements: string[] = [];
  for (const name of ["a", "b", "c"]) {
    statements.push(`CREATE TABLE ${name} (s TEXT)`);
    for (let i = 0; i < 100; i++) statements.push(`INSERT INTO ${name} VALUES (replace(hex(zeroblob(4096)), '00', 'x'))`);
  }
  await assert.rejects(parseSqlite(buildDatabase(statements)), LimitExceededError);
});

test("drops generated columns instead of materializing them", async () => {
  const database = new SQL.Database();
  database.run("CREATE TABLE t (a INTEGER, g TEXT GENERATED ALWAYS AS (hex(zeroblob(3000000 + a))) VIRTUAL)");
  database.run("INSERT INTO t (a) VALUES (1), (2), (3)");
  const bytes = database.export();
  database.close();

  const { text } = await parseSqlite(bytes);
  // The generated column g = hex(zeroblob(~6MB)) must never be materialized inside WASM:
  // it is dropped entirely rather than SELECTed and truncated as a result string.
  assert.ok(text.length < 20_000);
  assert.doesNotMatch(text, /0000/); // generated column absent from output
  assert.match(text, /\b1\b/); // real column `a` still emitted
});

test("a document that is not a SQLite database is a MalformedDocumentError", async () => {
  await assert.rejects(parseSqlite(new TextEncoder().encode("not a database at all")), MalformedDocumentError);
});

// Pins found by mutating sqlite-tables.ts and sqlite.ts (tikajs-68os.64). The reference is Tika's SQLite3Parser, JDBCTableReader
// and AbstractDBParser, read from the source and not run against a Tika or sqlite-jdbc.

test("SqliteParser is SQLite3Parser, claims the three SQLite media types, and needs random access and sql.js isolation", () => {
  const parser = new SqliteParser();
  assert.equal(parser.name, "SQLite3Parser");
  assert.deepEqual(
    [...parser.getSupportedTypes()].map((type) => type.toString()).sort(),
    ["application/vnd.sqlite3", "application/x-sqlite", "application/x-sqlite3"],
  );
  assert.equal(parser.capabilities.requiresRandomAccess, true);
  assert.equal(parser.capabilities.unsafe, true);
});

test("a table of 500 columns is read, even with a generated one besides, and one of 501 is a LimitExceededError", async () => {
  const columns = (count: number): string => Array.from({ length: count }, (_, i) => `c${i} INTEGER`).join(", ");
  const generated = buildDatabase([`CREATE TABLE t (${columns(500)}, g INTEGER GENERATED ALWAYS AS (c0 + 1) VIRTUAL)`]);
  const { xml } = await parseSqlite(generated);
  assert.equal(xml.match(/<th>/g)?.length, 500);
  await assert.rejects(
    parseSqlite(buildDatabase([`CREATE TABLE t (${columns(501)})`])),
    (error: unknown) => error instanceof LimitExceededError && /Table t has more than 500 columns/.test(error.message),
  );
});

test("exactly 1,000,000 characters of cell text are read, and one more is a LimitExceededError that names the database", async () => {
  // 100 rows of 4,096 characters is 409,600; two tables of those and 100 rows of 1,808 is 1,000,000
  const table = (name: string, width: number, extra = 0): string[] => [
    `CREATE TABLE ${name} (s TEXT)`,
    `INSERT INTO ${name} WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) SELECT substr(hex(zeroblob(${Math.ceil(width / 2)})), 1, ${width}) FROM n`,
    ...(extra > 0 ? [`UPDATE ${name} SET s = s || 'x' WHERE rowid = 1`] : []),
  ];
  await parseSqlite(buildDatabase([...table("a", 4_096), ...table("b", 4_096), ...table("c", 1_808)]));
  await assert.rejects(
    parseSqlite(buildDatabase([...table("a", 4_096), ...table("b", 4_096), ...table("c", 1_808, 1)])),
    (error: unknown) =>
      error instanceof LimitExceededError && /A SQLite database has more than 1000000 characters of cell text/.test(error.message),
  );
});

test("10,000 tables are read, and 10,001 are a LimitExceededError that names the database", async () => {
  const database = new SQL.Database();
  for (let i = 0; i < 10_000; i++) database.run(`CREATE TABLE t${i} (v INTEGER)`);
  const allowed = database.export();
  database.run("CREATE TABLE one_too_many (v INTEGER)");
  const refused = database.export();
  database.close();
  const { metadata } = await parseSqlite(allowed);
  assert.equal(metadata.getAll("database:table-name").length, 10_000);
  await assert.rejects(
    parseSqlite(refused),
    (error: unknown) => error instanceof LimitExceededError && /A SQLite database has more than 10000 tables/.test(error.message),
  );
});

test("a file of 256 MiB is read as far as its header, and one byte more is a LimitExceededError", async () => {
  const mebibyte = new Uint8Array(1024 * 1024);
  const parseStreamOf = async (bytes: number): Promise<void> => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let left = bytes; left > 0; left -= mebibyte.length) yield mebibyte.subarray(0, Math.min(left, mebibyte.length));
    }
    const stream = await RipstreamInputStream.from(chunks(), { spoolThreshold: 512 * 1024 * 1024 });
    try {
      await new SqliteParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext());
    } finally {
      await stream.close();
    }
  };
  // zeros are no database: the cap is passed, and the header is what refuses them
  await assert.rejects(parseStreamOf(256 * 1024 * 1024), MalformedDocumentError);
  await assert.rejects(parseStreamOf(256 * 1024 * 1024 + 1), LimitExceededError);
});

test("an aborted parse stops between tables that have no rows", async () => {
  const controller = new AbortController();
  controller.abort();
  const context = new ParseContext({ signal: controller.signal });
  const bytes = buildDatabase(Array.from({ length: 1_100 }, (_, i) => `CREATE TABLE t${i} (v INTEGER)`));
  await assert.rejects(parseSqlite(bytes, context));
});

test("the stream of an embedded blob is closed once the extractor is done with it", async () => {
  let embedded: RipstreamInputStream | undefined;
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, {
    shouldParseEmbedded: () => true,
    async parseEmbedded(stream) {
      embedded = stream;
    },
  } satisfies EmbeddedDocumentExtractor);
  await parseSqlite(buildDatabase(["CREATE TABLE t (b BLOB)", "INSERT INTO t VALUES (x'0102030405')"]), context);
  assert.ok(embedded);
  const rest = await embedded.readFully(16).catch(() => new Uint8Array(0));
  assert.equal(rest.length, 0);
});
