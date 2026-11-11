import {
  AttributesImpl,
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParsingEmbeddedDocumentExtractor,
  RipstreamError,
  RipstreamInputStream,
  XHTMLContentHandler,
  signalCheckpoint,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { javaDoubleString, javaFloatString } from "./java-number.ts";
import { loadSqlJs, quoteIdentifier, type SqlDatabase, type SqlValue } from "./sql-js.ts";

const GEOPACKAGE_MIME_TYPE = "application/x-geopackage";
const SQLITE_MAGIC = "SQLite format 3\0";

/** sql.js copies the whole file into WASM memory, so this is also what the parse can cost. */
export const DEFAULT_MAX_GEOPKG_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_GEOPKG_TABLES = 10_000;
/** Each column is read through three result columns, and SQLite allows 2,000 of those in one query. */
export const DEFAULT_MAX_GEOPKG_COLUMNS = 500;
/** Rows across all tables. */
export const DEFAULT_MAX_GEOPKG_ROWS = 1_000_000;
/** Characters of cell text across all tables. */
export const DEFAULT_MAX_GEOPKG_CHARS = 64 * 1024 * 1024;

/** GeoPkgParser.DEFAULT_IGNORE_BLOB_COLUMNS: the geometry of a feature table and the node data of an R-tree. */
const DEFAULT_IGNORE_BLOB_COLUMNS: readonly string[] = ["geom", "data"];

export interface GeoPkgParserOptions {
  /** Maximum size of the file (default {@link DEFAULT_MAX_GEOPKG_BYTES}); a larger one is a LimitExceededError. */
  readonly maxBytes?: number;
  /** Maximum number of tables (default {@link DEFAULT_MAX_GEOPKG_TABLES}). */
  readonly maxTables?: number;
  /** Maximum number of columns in one table (default {@link DEFAULT_MAX_GEOPKG_COLUMNS}). */
  readonly maxColumns?: number;
  /** Maximum number of rows read in all (default {@link DEFAULT_MAX_GEOPKG_ROWS}). */
  readonly maxRows?: number;
  /** Maximum characters of cell text written in all (default {@link DEFAULT_MAX_GEOPKG_CHARS}). */
  readonly maxChars?: number;
  /** GeoPkgParser.setIgnoreBlobColumns: the BLOB columns written as an empty span (default `geom` and `data`). */
  readonly ignoreBlobColumns?: readonly string[];
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}`);
  return value;
}

/**
 * Port of Tika's GeoPkgParser (tika-parser-sqlite3-module): SQLite3Parser, with the BLOB columns `geom` and `data` written
 * as an empty `<span type="blob" column_name row_number/>` instead of being parsed as embedded documents.
 *
 * What Tika writes, read from its source (AbstractDBParser, SQLite3DBParser, JDBCTableReader, GeoPkgTableReader) and not run
 * against a Tika or sqlite-jdbc:
 *  - `database:table-name`, once for each row of `sqlite_master` of type `table`, in that order; `sqlite3:application_id`
 *    and `sqlite3:user_version`, as `Integer.toString(value, 16)`;
 *  - for each table a `<table name>` with a header row of the column names and a row for each record;
 *  - a cell as JDBCTableReader writes it for the JDBC type sqlite-jdbc gives the column (its declared type name, or the
 *    type of the value when it has none): BOOLEAN as `true` or `false`, DOUBLE with `Double.toString`, FLOAT with
 *    `Float.toString`, a CLOB as nothing at all (SQLite3TableReader makes it a no-op), a BLOB as an embedded document,
 *    and everything else as the text SQLite gives it. sqlite-jdbc is not in the Tika tree: its type rules are from memory.
 *
 * Differences from Tika:
 *  - The database is read by sql.js (SQLite as WASM) from memory; it has no R-tree module, so the `rtree_*` virtual table of
 *    a spatially indexed GeoPackage is listed and has a header of no columns and no rows (its `_node`, `_rowid` and
 *    `_parent` tables, which are plain tables, are read).
 *  - A generated column is not read: SQLite evaluates its expression for every row, whatever it asks for (`hex(zeroblob(n))`),
 *    and a hostile file can make that allocate gigabytes. Tika's `SELECT *` includes it.
 *  - A table name is quoted in the query. Tika's `SELECT * from name` fails on a name with a space in it.
 *  - More than `maxTables` tables, `maxColumns` columns, `maxRows` rows or `maxChars` characters of cell text, or a file over
 *    `maxBytes`, is a LimitExceededError. Tika reads it all.
 *  - A blob that is parsed as an embedded document is named `<column>_<row>`; Tika appends the extension its detector gives.
 *    A document that is not a SQLite database, or is corrupt, is a MalformedDocumentError.
 *  - Tika also catches an SQLite file that sqlite-jdbc cannot read and fails with a CorruptedFileException or an IOException
 *    after writing nothing; a table that cannot be read here fails the parse in the same way (MalformedDocumentError).
 */
export class GeoPkgParser implements Parser {
  readonly name = "GeoPkgParser";
  readonly capabilities = { requiresRandomAccess: true, unsafe: true } as const;
  readonly #maxBytes: number;
  readonly #maxTables: number;
  readonly #maxColumns: number;
  readonly #maxRows: number;
  readonly #maxChars: number;
  readonly #ignoreBlobColumns: ReadonlySet<string>;

  constructor(options: GeoPkgParserOptions = {}) {
    this.#maxBytes = positiveInteger("maxBytes", options.maxBytes ?? DEFAULT_MAX_GEOPKG_BYTES);
    this.#maxTables = positiveInteger("maxTables", options.maxTables ?? DEFAULT_MAX_GEOPKG_TABLES);
    this.#maxColumns = positiveInteger("maxColumns", options.maxColumns ?? DEFAULT_MAX_GEOPKG_COLUMNS);
    this.#maxRows = positiveInteger("maxRows", options.maxRows ?? DEFAULT_MAX_GEOPKG_ROWS);
    this.#maxChars = positiveInteger("maxChars", options.maxChars ?? DEFAULT_MAX_GEOPKG_CHARS);
    const ignored = options.ignoreBlobColumns ?? DEFAULT_IGNORE_BLOB_COLUMNS;
    if (!Array.isArray(ignored)) throw new TypeError("ignoreBlobColumns must be an array of column names");
    this.#ignoreBlobColumns = new Set(ignored);
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(GEOPACKAGE_MIME_TYPE)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const tick = signalCheckpoint(ctx);
    const bytes = await stream.readFully(this.#maxBytes);
    if (new TextDecoder("latin1").decode(bytes.subarray(0, SQLITE_MAGIC.length)) !== SQLITE_MAGIC) {
      throw new MalformedDocumentError("Not a SQLite database");
    }

    let database: SqlDatabase | null = null;
    try {
      const SQL = await loadSqlJs();
      database = new SQL.Database(bytes);
      await this.#write(database, handler, metadata, ctx, tick);
    } catch (error) {
      if (error instanceof RipstreamError) throw error;
      throw new MalformedDocumentError("Unable to read SQLite database", { cause: error });
    } finally {
      closeQuietly(database);
    }
  }

  async #write(
    database: SqlDatabase,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
    tick: () => void,
  ): Promise<void> {
    const tableNames = readTableNames(database, this.#maxTables);
    for (const tableName of tableNames) metadata.add("database:table-name", tableName);
    extractMetadata(database, metadata);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    const budget = { rows: 0, chars: 0 };
    for (const tableName of tableNames) {
      tick();
      await this.#writeTable(database, tableName, xhtml, budget, ctx, tick);
    }
    await xhtml.endDocument();
  }

  async #writeTable(
    database: SqlDatabase,
    tableName: string,
    xhtml: XHTMLContentHandler,
    budget: { rows: number; chars: number },
    ctx: ParseContext,
    tick: () => void,
  ): Promise<void> {
    const columns = readColumns(database, tableName, this.#maxColumns);
    await xhtml.startElement("table", "name", tableName);
    await xhtml.startElement("thead");
    await xhtml.startElement("tr");
    for (const column of columns ?? []) {
      await xhtml.startElement("th");
      await xhtml.characters(column.name);
      await xhtml.endElement("th");
    }
    await xhtml.endElement("tr");
    await xhtml.endElement("thead");
    await xhtml.startElement("tbody");
    if (columns !== null && columns.length > 0) {
      await this.#writeRows(database, tableName, columns, xhtml, budget, ctx, tick);
    }
    await xhtml.endElement("tbody");
    await xhtml.endElement("table");
  }

  async #writeRows(
    database: SqlDatabase,
    tableName: string,
    columns: readonly Column[],
    xhtml: XHTMLContentHandler,
    budget: { rows: number; chars: number },
    ctx: ParseContext,
    tick: () => void,
  ): Promise<void> {
    const statement = database.prepare(selectSql(tableName, columns, this.#ignoreBlobColumns));
    try {
      let rowNumber = 0;
      while (statement.step()) {
        tick();
        if (++budget.rows > this.#maxRows) throw new LimitExceededError(`A GeoPackage has more than ${this.#maxRows} rows`);
        const values = statement.get();
        await xhtml.startElement("tr");
        for (const [index, column] of columns.entries()) {
          await xhtml.startElement("td");
          const cell = { valueType: String(values[index * 3]), value: values[index * 3 + 1] ?? null, realText: values[index * 3 + 2] };
          await this.#writeCell(tableName, column, rowNumber, cell, xhtml, budget, ctx);
          await xhtml.endElement("td");
        }
        await xhtml.endElement("tr");
        rowNumber++;
      }
    } finally {
      statement.free();
    }
  }

  async #writeCell(
    tableName: string,
    column: Column,
    rowNumber: number,
    cell: Cell,
    xhtml: XHTMLContentHandler,
    budget: { rows: number; chars: number },
    ctx: ParseContext,
  ): Promise<void> {
    const kind = cellKind(column.typeName ?? valueTypeName(cell.valueType), cell.valueType);
    if (kind === "blob") {
      await this.#writeBlob(tableName, column.name, rowNumber, cell, xhtml, ctx);
      return;
    }
    const text = cellText(kind, cell);
    if (text === null || text === "") return;
    budget.chars += text.length;
    if (budget.chars > this.#maxChars) throw new LimitExceededError(`A GeoPackage has more than ${this.#maxChars} characters of cell text`);
    await xhtml.characters(text);
  }

  /** GeoPkgTableReader.handleBlob, and JDBCTableReader.handleBlob for the columns that are not ignored. */
  async #writeBlob(
    tableName: string,
    columnName: string,
    rowNumber: number,
    cell: Cell,
    xhtml: XHTMLContentHandler,
    ctx: ParseContext,
  ): Promise<void> {
    const attributes = new AttributesImpl();
    attributes.addAttribute("", "type", "type", "CDATA", "blob");
    attributes.addAttribute("", "column_name", "column_name", "CDATA", columnName);
    attributes.addAttribute("", "row_number", "row_number", "CDATA", String(rowNumber));

    // An ignored column writes its span before it looks at the value, so a NULL BLOB gets one too.
    if (this.#ignoreBlobColumns.has(columnName)) {
      await xhtml.startElement("", "span", "span", attributes);
      await xhtml.endElement("", "span", "span");
      return;
    }
    if (!(cell.value instanceof Uint8Array)) return;

    await xhtml.startElement("", "span", "span", attributes);
    const metadata = new Metadata();
    metadata.set("database:table-name", tableName);
    metadata.set("database:column-name", columnName);
    metadata.set("database:ROW_NUM", String(rowNumber));
    metadata.set("database:IS_BLOB", "true");
    metadata.set("tk:resource-name", resourceName(`${columnName}_${rowNumber}`));
    await parseEmbeddedBlob(cell.value, xhtml, metadata, ctx);
    await xhtml.endElement("", "span", "span");
  }
}

interface Column {
  readonly name: string;
  /** The declared type up to its first `(`, in upper case, as sqlite-jdbc's getColumnTypeName; null when there is none. */
  readonly typeName: string | null;
}

/** One cell of the query: SQLite's `typeof`, the value, and SQLite's own text for a REAL. */
interface Cell {
  readonly valueType: string;
  readonly value: SqlValue;
  readonly realText: SqlValue | undefined;
}

type CellKind = "string" | "boolean" | "float" | "double" | "clob" | "blob";

/** SQLite3DBParser.getTableNames: `SELECT name FROM sqlite_master WHERE type='table'`, in the order SQLite gives. */
function readTableNames(database: SqlDatabase, maxTables: number): string[] {
  const names: string[] = [];
  const statement = database.prepare("SELECT name FROM sqlite_master WHERE type='table'");
  try {
    while (statement.step()) {
      if (names.length >= maxTables) throw new LimitExceededError(`A GeoPackage has more than ${maxTables} tables`);
      names.push(String(statement.get()[0]));
    }
  } finally {
    statement.free();
  }
  return names;
}

const METADATA_QUERIES: ReadonlyArray<readonly [string, string]> = [
  ["sqlite3:application_id", "select application_id from pragma_application_id"],
  ["sqlite3:user_version", "select user_version from pragma_user_version"],
];

/** SQLite3DBParser.extractMetadata: the two header integers, as Integer.toString(value, 16). */
function extractMetadata(database: SqlDatabase, metadata: Metadata): void {
  for (const [key, sql] of METADATA_QUERIES) {
    try {
      const value = database.exec(sql)[0]?.values[0]?.[0];
      // getInt is the low 32 bits, and a negative value is written with a minus sign, as Integer.toString does
      if (typeof value === "number") metadata.set(key, (value | 0).toString(16));
    } catch {
      // Tika swallows the SQLException: a header it cannot read leaves the key unset, and the tables below report a corrupt file
    }
  }
}

/**
 * The columns `SELECT *` would give, but not the generated ones. null for a virtual table whose module sql.js does not
 * have, which cannot be read at all.
 */
function readColumns(database: SqlDatabase, tableName: string, maxColumns: number): Column[] | null {
  let info: { columns: string[]; values: unknown[][] } | undefined;
  try {
    info = database.exec(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`)[0];
  } catch (error) {
    if (error instanceof Error && /no such module/i.test(error.message)) return null;
    throw error;
  }
  if (info === undefined) return [];
  const nameIndex = info.columns.indexOf("name");
  const typeIndex = info.columns.indexOf("type");
  const hiddenIndex = info.columns.indexOf("hidden");
  // hidden: 0 is a column, 1 a hidden column of a virtual table, 2 and 3 a generated column
  const real = info.values.filter((row) => row[hiddenIndex] === 0);
  if (real.length > maxColumns) throw new LimitExceededError(`Table ${tableName} has more than ${maxColumns} columns`);
  return real.map((row) => ({ name: String(row[nameIndex]), typeName: typeNameOf(String(row[typeIndex] ?? "")) }));
}

/** sqlite-jdbc's getColumnTypeName: the declared type up to the first `(`, in upper case. */
function typeNameOf(declared: string): string | null {
  return declared === "" ? null : (/^[^(]*/.exec(declared)![0]).toUpperCase();
}

/** sqlite-jdbc's getColumnTypeName for a column with no declared type: the type of the value. */
function valueTypeName(valueType: string): string {
  switch (valueType) {
    case "integer":
      return "INTEGER";
    case "real":
      return "FLOAT";
    case "blob":
      return "BLOB";
    case "null":
      return "NULL";
    default:
      return "TEXT";
  }
}

/**
 * Three result columns for each column: SQLite's `typeof`; the value, with an INTEGER as its exact digits (a JavaScript
 * number loses an integer over 2^53) and with a BLOB left out of an ignored column, so a large one is never copied; and
 * SQLite's own text for a REAL, which is what JDBC's getString gives a REAL that no case of the switch handles.
 */
function selectSql(tableName: string, columns: readonly Column[], ignoredBlobColumns: ReadonlySet<string>): string {
  const parts = columns.flatMap((column) => {
    const name = quoteIdentifier(column.name);
    const skipBlob = ignoredBlobColumns.has(column.name) ? "WHEN 'blob' THEN NULL " : "";
    return [
      `typeof(${name})`,
      `CASE typeof(${name}) WHEN 'integer' THEN CAST(${name} AS TEXT) ${skipBlob}ELSE ${name} END`,
      `CASE typeof(${name}) WHEN 'real' THEN CAST(${name} AS TEXT) END`,
    ];
  });
  return `SELECT ${parts.join(", ")} FROM ${quoteIdentifier(tableName)}`;
}

/**
 * JDBCTableReader.handleCell's switch, on the JDBC type sqlite-jdbc's getColumnType gives: it tries the integer cases for an
 * INTEGER or NULL value, then the real ones, the text ones and the blob ones, each by the type name.
 */
function cellKind(typeName: string, valueType: string): CellKind {
  const integerOrNull = valueType === "integer" || valueType === "null";
  const realOrNull = valueType === "real" || valueType === "null";
  const textOrNull = valueType === "text" || valueType === "null";
  if (integerOrNull && typeName === "BOOLEAN") return "boolean";
  if (realOrNull && typeName === "FLOAT") return "float";
  if (realOrNull && (typeName === "DOUBLE" || typeName === "DOUBLE PRECISION")) return "double";
  if (textOrNull && typeName === "CLOB") return "clob";
  if (valueType === "blob" || (valueType === "null" && typeName === "BLOB")) return "blob";
  return "string";
}

/** The characters JDBCTableReader writes for a cell that is not a blob, or null for none (a NULL, or a CLOB). */
function cellText(kind: CellKind, cell: Cell): string | null {
  if (cell.valueType === "null" || kind === "clob") return null;
  switch (kind) {
    case "boolean":
      // getBoolean is `getInt != 0`, and sqlite3_column_int keeps the low 32 bits
      return BigInt.asIntN(32, BigInt(String(cell.value))) === 0n ? "false" : "true";
    case "float":
      return javaFloatString(Number(cell.value));
    case "double":
      return javaDoubleString(Number(cell.value));
    default:
      return cell.valueType === "real" ? String(cell.realText) : String(cell.value);
  }
}

/** JDBCTableReader's name for an embedded blob: FilenameUtils.getName of `<column>_<row>`, so no directory in it. */
function resourceName(name: string): string {
  return name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
}

/** JDBCTableReader.handleBlob's parseEmbedded: a document that cannot be parsed is noted on its metadata, not fatal. */
async function parseEmbeddedBlob(
  bytes: Uint8Array,
  xhtml: XHTMLContentHandler,
  metadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  const extractor =
    (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
    new ParsingEmbeddedDocumentExtractor();
  if (!extractor.shouldParseEmbedded(metadata)) return;
  const stream = await RipstreamInputStream.from(bytes, { context: ctx });
  try {
    await extractor.parseEmbedded(stream, xhtml, metadata, ctx);
  } catch (error) {
    if (error instanceof LimitExceededError || ctx.signal.aborted) throw error;
    metadata.add("tk:exception:embedded-exception", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    await stream.close();
  }
}

/** Closing after a WASM trap can throw; that must not replace the error that caused it. */
function closeQuietly(database: SqlDatabase | null): void {
  try {
    database?.close();
  } catch {
    // the instance is discarded either way
  }
}
