import {
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { createSqliteTablesParser, type SqliteTables } from "./sqlite-tables.ts";

const GEOPACKAGE_MIME_TYPE = "application/x-geopackage";

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
  readonly #tables: SqliteTables;

  constructor(options: GeoPkgParserOptions = {}) {
    const ignored = options.ignoreBlobColumns ?? DEFAULT_IGNORE_BLOB_COLUMNS;
    if (!Array.isArray(ignored)) throw new TypeError("ignoreBlobColumns must be an array of column names");
    this.#tables = createSqliteTablesParser({
      name: this.name,
      mediaTypes: [GEOPACKAGE_MIME_TYPE],
      noun: "GeoPackage",
      maxBytes: positiveInteger("maxBytes", options.maxBytes ?? DEFAULT_MAX_GEOPKG_BYTES),
      maxTables: positiveInteger("maxTables", options.maxTables ?? DEFAULT_MAX_GEOPKG_TABLES),
      maxColumns: positiveInteger("maxColumns", options.maxColumns ?? DEFAULT_MAX_GEOPKG_COLUMNS),
      maxRows: positiveInteger("maxRows", options.maxRows ?? DEFAULT_MAX_GEOPKG_ROWS),
      maxChars: positiveInteger("maxChars", options.maxChars ?? DEFAULT_MAX_GEOPKG_CHARS),
      ignoreBlobColumns: new Set(ignored),
    });
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return this.#tables.getSupportedTypes();
  }

  parse(stream: RipstreamInputStream, handler: ContentHandler, metadata: Metadata, ctx: ParseContext): Promise<void> {
    return this.#tables.parse(stream, handler, metadata, ctx);
  }
}
