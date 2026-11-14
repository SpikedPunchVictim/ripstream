import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { GeoPkgParser, type GeoPkgParserOptions } from "../src/index.ts";
import { javaDoubleString, javaFloatString } from "@spikedpunch/ripstream-core";

/*
 * Tika's GeoPkgParser (tika-parser-sqlite3-module): SQLite3Parser with the BLOB columns `geom` and `data` written as an
 * empty `<span type="blob" column_name row_number/>`. Tika's tree has no GeoPackage file and no GeoPackage test, so the
 * database here is built with sql.js to the GeoPackage 1.2 table layout, and the expected text is what JDBCTableReader,
 * AbstractDBParser and GeoPkgTableReader write for it, read from the Tika source and not run against a Tika or sqlite-jdbc.
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

const GEOPACKAGE = [
  "PRAGMA page_size = 512",
  "PRAGMA application_id = 1196444487",
  "PRAGMA user_version = 10200",
  `CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL,
     organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT)`,
  `INSERT INTO gpkg_spatial_ref_sys VALUES ('WGS 84 geodetic', 4326, 'EPSG', 4326, 'GEOGCS["WGS 84"]', 'longitude/latitude')`,
  `CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE,
     description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER)`,
  `INSERT INTO gpkg_contents VALUES ('points', 'features', 'points', 'sample points', '2024-01-02T03:04:05.000Z', -10.5, 0.1, 10000000, 52, 4326)`,
  `CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL,
     srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL)`,
  `INSERT INTO gpkg_geometry_columns VALUES ('points', 'geom', 'POINT', 4326, 0, 0)`,
  "CREATE TABLE points (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom POINT, name TEXT, height DOUBLE, active BOOLEAN)",
  `INSERT INTO points (geom, name, height, active) VALUES (x'47500001e6100000', 'Alpha', 12.5, 1),
     (x'47500001e6100000', 'Beta', 3, 0), (NULL, NULL, NULL, NULL)`,
];

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

/** The `<table name>` blocks of the text: its header cells and its rows, each cell as the markup inside it. */
function tables(xml: string): Map<string, { headers: string[]; rows: string[][] }> {
  const found = new Map<string, { headers: string[]; rows: string[][] }>();
  for (const table of xml.matchAll(/<table name="([^"]*)">(.*?)<\/table>/gs)) {
    const body = table[2]!;
    const [head = "", rest = ""] = body.split("</thead>");
    const headers = [...head.matchAll(/<th>(.*?)<\/th>/gs)].map((cell) => cell[1]!);
    const rows = [...rest.matchAll(/<tr>(.*?)<\/tr>/gs)].map((row) => [...row[1]!.matchAll(/<td>(.*?)<\/td>/gs)].map((cell) => cell[1]!));
    found.set(table[1]!, { headers, rows });
  }
  return found;
}

const BLOB_SPAN = (column: string, row: number): string => `<span type="blob" column_name="${column}" row_number="${row}"></span>`;

test("the GeoPackage parser claims application/x-geopackage and declares that it runs sql.js", () => {
  const parser = new GeoPkgParser();
  assert.equal(parser.name, "GeoPkgParser");
  assert.deepEqual([...parser.getSupportedTypes()].map(String), ["application/x-geopackage"]);
  assert.equal(parser.capabilities.unsafe, true);
});

test("a GeoPackage: the metadata Tika's SQLite3DBParser writes, the tables in sqlite_master order", async () => {
  const { metadata } = await parseGeoPkg(buildDatabase(GEOPACKAGE));
  assert.deepEqual(metadata.getAll("database:table-name"), [
    "gpkg_spatial_ref_sys",
    "gpkg_contents",
    "gpkg_geometry_columns",
    "points",
    "sqlite_sequence",
  ]);
  // Integer.toString(value, 16): 0x47504b47 is "GPKG", and 10200 is 0x27d8
  assert.equal(metadata.get("sqlite3:application_id"), "47504b47");
  assert.equal(metadata.get("sqlite3:user_version"), "27d8");
});

test("a GeoPackage: a table is a header row and one row per record, with the geometry column as an empty blob span", async () => {
  const { xml } = await parseGeoPkg(buildDatabase(GEOPACKAGE));
  const found = tables(xml);
  assert.deepEqual([...found.keys()], ["gpkg_spatial_ref_sys", "gpkg_contents", "gpkg_geometry_columns", "points", "sqlite_sequence"]);

  const points = found.get("points")!;
  assert.deepEqual(points.headers, ["fid", "geom", "name", "height", "active"]);
  assert.deepEqual(points.rows, [
    ["1", BLOB_SPAN("geom", 0), "Alpha", "12.5", "true"],
    // 3 is stored as 3.0 (DOUBLE affinity) and written by Double.toString; BOOLEAN 0 is Boolean.toString(false)
    ["2", BLOB_SPAN("geom", 1), "Beta", "3.0", "false"],
    // a NULL is no characters. The span of an ignored column is written for a NULL too, but only a cell that sqlite-jdbc
    // types as BLOB reaches it, and a NULL in a column declared POINT is not one (a NULL in a column declared BLOB is)
    ["3", "", "", "", ""],
  ]);

  assert.deepEqual(found.get("gpkg_contents")!.rows[0], [
    "points",
    "features",
    "points",
    "sample points",
    "2024-01-02T03:04:05.000Z",
    "-10.5",
    "0.1",
    "1.0E7",
    "52.0",
    "4326",
  ]);
  assert.deepEqual(found.get("gpkg_spatial_ref_sys")!.rows[0], ["WGS 84 geodetic", "4326", "EPSG", "4326", 'GEOGCS["WGS 84"]', "longitude/latitude"]);
  assert.deepEqual(found.get("sqlite_sequence")!.rows, [["points", "3"]]);
});

test("only the columns named geom and data are skipped as blobs; any other blob goes to the embedded-document extractor", async () => {
  const bytes = buildDatabase([
    "CREATE TABLE tiles (id INTEGER PRIMARY KEY, geom BLOB, data BLOB, tile_data BLOB)",
    "INSERT INTO tiles VALUES (1, x'01', x'02', x'0a0b'), (2, NULL, NULL, NULL)",
    "CREATE TABLE upper (GEOM BLOB)",
    "INSERT INTO upper VALUES (x'03')",
  ]);
  const embedded: Array<{ metadata: Metadata; bytes: number[] }> = [];
  const extractor: EmbeddedDocumentExtractor = {
    shouldParseEmbedded: () => true,
    async parseEmbedded(stream, _handler, metadata) {
      embedded.push({ metadata, bytes: [...(await stream.readFully(1024))] });
    },
  };
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);

  const { xml } = await parseGeoPkg(bytes, {}, context);
  const found = tables(xml);
  const row = found.get("tiles")!.rows;
  assert.deepEqual(row[0]!.slice(0, 3), ["1", BLOB_SPAN("geom", 0), BLOB_SPAN("data", 0)]);
  assert.match(row[0]![3]!, /^<span type="blob" column_name="tile_data" row_number="0">/);
  // NULL BLOBs: the ignored columns still write their span, the others write nothing
  assert.deepEqual(row[1], ["2", BLOB_SPAN("geom", 1), BLOB_SPAN("data", 1), ""]);
  // the column name is compared as written: GEOM is not geom, so it is embedded like tile_data
  assert.match(found.get("upper")!.rows[0]![0]!, /^<span type="blob" column_name="GEOM" row_number="0">/);

  assert.deepEqual(
    embedded.map((e) => e.bytes),
    [[0x0a, 0x0b], [0x03]],
  );
  const first = embedded[0]!.metadata;
  assert.equal(first.get("database:table-name"), "tiles");
  assert.equal(first.get("database:column-name"), "tile_data");
  assert.equal(first.get("database:ROW_NUM"), "0");
  assert.equal(first.get("database:IS_BLOB"), "true");
  assert.equal(first.get("tk:resource-name"), "tile_data_0");
});

test("ignoreBlobColumns replaces the default geom and data, as setIgnoreBlobColumns does", async () => {
  const bytes = buildDatabase(["CREATE TABLE t (geom BLOB, shape BLOB)", "INSERT INTO t VALUES (x'01', x'02')"]);
  const seen: string[] = [];
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, {
    shouldParseEmbedded: () => true,
    async parseEmbedded(stream, _handler, metadata) {
      await stream.readFully(16);
      seen.push(metadata.get("database:column-name") ?? "");
    },
  } satisfies EmbeddedDocumentExtractor);
  const { xml } = await parseGeoPkg(bytes, { ignoreBlobColumns: ["shape"] }, context);
  assert.deepEqual(seen, ["geom"]);
  assert.deepEqual(tables(xml).get("t")!.rows[0]![1], BLOB_SPAN("shape", 0));
});

test("a blob that cannot be parsed is noted on its metadata and the rest of the database is still written", async () => {
  const bytes = buildDatabase(["CREATE TABLE t (id INTEGER, tile_data BLOB)", "INSERT INTO t VALUES (1, x'01'), (2, x'02')"]);
  const metadatas: Metadata[] = [];
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, {
    shouldParseEmbedded: () => true,
    async parseEmbedded(_stream, _handler, metadata) {
      metadatas.push(metadata);
      throw new MalformedDocumentError("not an image");
    },
  } satisfies EmbeddedDocumentExtractor);
  const { xml } = await parseGeoPkg(bytes, {}, context);
  assert.equal(tables(xml).get("t")!.rows.length, 2);
  assert.match(metadatas[0]!.get("tk:exception:embedded-exception") ?? "", /not an image/);
});

test("a limit crossed inside an embedded blob ends the parse", async () => {
  const bytes = buildDatabase(["CREATE TABLE t (tile_data BLOB)", "INSERT INTO t VALUES (x'01')"]);
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, {
    shouldParseEmbedded: () => true,
    async parseEmbedded() {
      throw new LimitExceededError("embedded too big");
    },
  } satisfies EmbeddedDocumentExtractor);
  await assert.rejects(parseGeoPkg(bytes, {}, context), LimitExceededError);
});

test("a cell is written the way JDBCTableReader writes the JDBC type sqlite-jdbc gives the column", async () => {
  const bytes = buildDatabase([
    "CREATE TABLE cells (i INTEGER, big BIGINT, d DOUBLE, f FLOAT, r REAL, n NUMERIC, nt, c CLOB, b BOOLEAN, t TEXT, dt DATETIME)",
    // nt has no declared type: a REAL value there is typed FLOAT by its value, so it is a float32 in Java
    `INSERT INTO cells VALUES (7, 9007199254740993, 0.1, 3.14159265358979, 0.00001, 2.5, 3.14159265358979,
       'clob text, which SQLite3TableReader drops', 5, 'text', '2024-01-02')`,
    "INSERT INTO cells (i, b) VALUES (NULL, 4294967296)",
  ]);
  const { xml } = await parseGeoPkg(bytes);
  const rows = tables(xml).get("cells")!.rows;
  assert.deepEqual(rows[0], [
    "7",
    "9007199254740993", // BIGINT: JDBC getString, so the digits SQLite has
    "0.1", // DOUBLE: Double.toString
    "3.1415927", // FLOAT: Float.toString of the float32
    "1.0e-05", // REAL: no case of the switch, so getString and SQLite's own text for the number
    "2.5", // NUMERIC: the same
    "3.1415927", // no declared type, REAL value: sqlite-jdbc names the type FLOAT
    "", // CLOB: handleClob is a no-op in SQLite3TableReader
    "true", // BOOLEAN 5: getBoolean is getInt != 0
    "text",
    "2024-01-02",
  ]);
  // BOOLEAN 4294967296: sqlite3_column_int keeps the low 32 bits, which are 0
  assert.deepEqual(rows[1], ["", "", "", "", "", "", "", "", "false", "", ""]);
});

test("javaDoubleString and javaFloatString write what Java's Double.toString and Float.toString write", () => {
  assert.equal(javaDoubleString(12.5), "12.5");
  assert.equal(javaDoubleString(3), "3.0");
  assert.equal(javaDoubleString(1e7), "1.0E7");
  assert.equal(javaDoubleString(0.001), "0.001");
  assert.equal(javaDoubleString(0.0001), "1.0E-4");
  assert.equal(javaDoubleString(-0), "-0.0");
  assert.equal(javaDoubleString(Number.NaN), "NaN");
  assert.equal(javaFloatString(0.1), "0.1");
  assert.equal(javaFloatString(3.14159265358979), "3.1415927");
  assert.equal(javaFloatString(16777216), "1.6777216E7");
  assert.equal(javaFloatString(1e-10), "1.0E-10");
});

test("a generated column is left out: its expression would be evaluated for every row, whatever size it asks for", async () => {
  const bytes = buildDatabase([
    "CREATE TABLE t (a INTEGER, g TEXT GENERATED ALWAYS AS (hex(zeroblob(3000000 + a))) VIRTUAL, b TEXT)",
    "INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y')",
  ]);
  const { xml } = await parseGeoPkg(bytes);
  assert.ok(xml.length < 5_000, `${xml.length} characters`);
  assert.deepEqual(tables(xml).get("t"), { headers: ["a", "b"], rows: [["1", "x"], ["2", "y"]] });
});

test("a table name with a space or a quote is read: Tika's unquoted SELECT would fail on it", async () => {
  const bytes = buildDatabase([`CREATE TABLE "my ""odd"" table" (v TEXT)`, `INSERT INTO "my ""odd"" table" VALUES ('ok')`]);
  const { xml, metadata } = await parseGeoPkg(bytes);
  assert.deepEqual(metadata.getAll("database:table-name"), [`my "odd" table`]);
  assert.match(xml, /<td>ok<\/td>/);
});

test("a virtual table whose module sql.js lacks (the rtree index of a GeoPackage) is listed with no rows", async () => {
  const database = new SQL.Database();
  database.run("PRAGMA page_size = 512");
  database.run("CREATE TABLE real_table (v TEXT)");
  database.run("INSERT INTO real_table VALUES ('kept')");
  database.run("PRAGMA writable_schema = 1");
  // sql.js has no rtree module to create one with, so its schema row is written as SQLite itself would
  database.run(
    "INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('table', 'rtree_points_geom', 'rtree_points_geom', 0, 'CREATE VIRTUAL TABLE rtree_points_geom USING rtree(id, minx, maxx, miny, maxy)')",
  );
  database.run("PRAGMA writable_schema = 0");
  const bytes = database.export();
  database.close();

  const { xml, metadata } = await parseGeoPkg(bytes);
  assert.deepEqual(metadata.getAll("database:table-name"), ["real_table", "rtree_points_geom"]);
  const found = tables(xml);
  assert.deepEqual(found.get("real_table")!.rows, [["kept"]]);
  assert.deepEqual(found.get("rtree_points_geom"), { headers: [], rows: [] });
});

test("a database with no tables is an empty document", async () => {
  const { xml, metadata } = await parseGeoPkg(buildDatabase(["PRAGMA application_id = 1196444487"]));
  assert.equal(tables(xml).size, 0);
  assert.equal(metadata.has("database:table-name"), false);
  assert.equal(metadata.get("sqlite3:application_id"), "47504b47");
  assert.equal(metadata.get("sqlite3:user_version"), "0");
});

test("a file that is not a SQLite database is a malformed document", async () => {
  await assert.rejects(parseGeoPkg(new TextEncoder().encode("this is not a database")), MalformedDocumentError);
  await assert.rejects(parseGeoPkg(new Uint8Array(0)), MalformedDocumentError);
  // the right first sixteen bytes and nothing SQLite can read after them
  const magic = new Uint8Array(4096);
  magic.set(new TextEncoder().encode("SQLite format 3\0"));
  await assert.rejects(parseGeoPkg(magic), MalformedDocumentError);
});

test("every prefix of a valid GeoPackage parses or is refused as malformed", async () => {
  const bytes = buildDatabase(GEOPACKAGE);
  let parsed = 0;
  let refused = 0;
  // a prefix of fewer than 100 bytes is refused before SQLite sees it, so stride coarsely through the file and take
  // every length around the header and the end
  const lengths = new Set<number>();
  for (let length = 0; length <= 130; length++) lengths.add(length);
  for (let length = 131; length < bytes.length; length += 37) lengths.add(length);
  for (let length = bytes.length - 3; length <= bytes.length; length++) lengths.add(length);
  for (const length of [...lengths].sort((a, b) => a - b)) {
    try {
      await parseGeoPkg(bytes.subarray(0, length));
      parsed++;
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix ${length}: ${String(error)}`);
      refused++;
    }
  }
  assert.ok(refused > 100, `refused ${refused}`);
  assert.ok(parsed >= 1, `parsed ${parsed}`);
  // the whole file parses
  await parseGeoPkg(bytes);
});

test("a header that claims far more pages than the file holds is read by the bytes there are", async () => {
  const bytes = buildDatabase(GEOPACKAGE).slice();
  // offset 28: the database size in pages; offset 92: version-valid-for, set to the change counter at offset 24 so SQLite believes it
  new DataView(bytes.buffer).setUint32(28, 0x7fffffff);
  bytes.copyWithin(92, 24, 28);
  try {
    await parseGeoPkg(bytes);
  } catch (error) {
    assert.ok(error instanceof MalformedDocumentError, String(error));
  }
});

test("a file over maxBytes is a LimitExceededError, and the input is read no further than the cap", async () => {
  let pulled = 0;
  async function* endless(): AsyncGenerator<Uint8Array> {
    while (true) {
      pulled++;
      if (pulled > 100) throw new Error("the parser kept reading past maxBytes");
      yield new Uint8Array(1024);
    }
  }
  const stream = await RipstreamInputStream.from(endless());
  await assert.rejects(
    new GeoPkgParser({ maxBytes: 2048 }).parse(stream, new ToXMLContentHandler(), new Metadata(), new ParseContext()),
    LimitExceededError,
  );
  await stream.close();
  assert.ok(pulled < 5, `pulled ${pulled} chunks`);
});

test("maxTables, maxColumns, maxRows and maxChars refuse a database that is larger than they allow", async () => {
  const bytes = buildDatabase([
    "CREATE TABLE a (x TEXT, y TEXT, z TEXT)",
    "CREATE TABLE b (x TEXT)",
    "CREATE TABLE c (x TEXT)",
    "INSERT INTO a VALUES ('1', '2', '3'), ('4', '5', '6'), ('7', '8', '9')",
  ]);
  await assert.rejects(parseGeoPkg(bytes, { maxTables: 2 }), LimitExceededError);
  await assert.rejects(parseGeoPkg(bytes, { maxColumns: 2 }), LimitExceededError);
  await assert.rejects(parseGeoPkg(bytes, { maxRows: 2 }), LimitExceededError);
  await assert.rejects(parseGeoPkg(bytes, { maxChars: 5 }), LimitExceededError);
  // and exactly at the limits it is read
  await parseGeoPkg(bytes, { maxTables: 3, maxColumns: 3, maxRows: 3, maxChars: 100 });
});

test("a database of more rows than maxRows is refused after maxRows are read, not after all of them", async () => {
  const bytes = buildDatabase([
    "CREATE TABLE t (v INTEGER)",
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO t SELECT i FROM n",
  ]);
  await assert.rejects(parseGeoPkg(bytes, { maxRows: 100 }), LimitExceededError);
});

test("the options are positive integers, and ignoreBlobColumns is a list of names", () => {
  assert.throws(() => new GeoPkgParser({ maxBytes: 0 }), RangeError);
  assert.throws(() => new GeoPkgParser({ maxTables: 1.5 }), RangeError);
  assert.throws(() => new GeoPkgParser({ maxColumns: -1 }), RangeError);
  assert.throws(() => new GeoPkgParser({ maxRows: Number.NaN }), RangeError);
  assert.throws(() => new GeoPkgParser({ maxChars: 0 }), RangeError);
  assert.throws(() => new GeoPkgParser({ ignoreBlobColumns: "geom" as unknown as string[] }), TypeError);
});

test("a real GDAL GeoPackage: the tile table and its matrix are read from a file this project did not make", async () => {
  // OSGeo/gdal autotest/gdrivers/data/gpkg/byte.gpkg (fixtures/README.md).
  const data = new Uint8Array(readFileSync(new URL("./fixtures/gdal-byte.gpkg", import.meta.url)));
  const { metadata, xml } = await parseGeoPkg(data, { ignoreBlobColumns: ["tile_data"] });
  assert.deepEqual(metadata.getAll("database:table-name"), [
    "gpkg_spatial_ref_sys",
    "gpkg_contents",
    "gpkg_ogr_contents",
    "gpkg_tile_matrix_set",
    "gpkg_tile_matrix",
    "byte",
    "sqlite_sequence",
  ]);
  assert.equal(metadata.get("sqlite3:application_id"), "47503130");
  const found = tables(xml);
  assert.deepEqual(found.get("gpkg_contents")!.rows[0]!.slice(0, 3), ["byte", "tiles", "byte"]);
  assert.deepEqual(found.get("gpkg_tile_matrix")!.rows[0]!.slice(0, 5), ["byte", "0", "1", "1", "256"]);
  assert.deepEqual(found.get("byte")!.headers, ["id", "zoom_level", "tile_column", "tile_row", "tile_data"]);
  assert.equal(found.get("byte")!.rows[0]![0], "1");
});
