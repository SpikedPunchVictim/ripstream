import {
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { createSqliteTablesParser, type SqliteTables } from "./sqlite-tables.ts";

/** Rows read from each table; the ones after them are left out. The limit this parser had before it followed Tika. */
const MAX_ROWS_PER_TABLE = 100;
/** Characters kept of a TEXT cell. Also from before. */
const MAX_CELL_CHARS = 4_096;
/** Characters of cell text across all tables, above which the parse is a LimitExceededError. Also from before. */
const MAX_TOTAL_CHARS = 1_000_000;
/** sql.js copies the whole file into WASM memory, so this is also what the parse can cost. */
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_TABLES = 10_000;
/** Each column is read through three result columns, and SQLite allows 2,000 of those in one query. */
const MAX_COLUMNS = 500;
/** Rows across all tables: the 100 of each table, for as many tables as there may be. */
const MAX_ROWS = MAX_ROWS_PER_TABLE * MAX_TABLES;

/**
 * Port of Tika's SQLite3Parser (tika-parser-sqlite3-module), by the same code as GeoPkgParser (sqlite-tables.ts), which
 * is SQLite3Parser with two BLOB columns not parsed. Read from AbstractDBParser, SQLite3DBParser, SQLite3TableReader,
 * JDBCTableReader and SQLite3ParserTest, not run against a Tika or sqlite-jdbc.
 *
 * What it writes (tikajs-68os.64; before, `sqlite:table-count` and an h1 and a p for each table and row):
 *  - `database:table-name` for each table, in the order of `sqlite_master`; `sqlite3:application_id` and
 *    `sqlite3:user_version`, as `Integer.toString(value, 16)`;
 *  - a `<table name>` for each table, with a header row of the column names and a row for each record, a cell as the text
 *    JDBCTableReader gives its JDBC type (see GeoPkgParser for the types), a NULL as an empty cell;
 *  - every BLOB cell as an embedded document, parsed by whatever parser its bytes are detected as.
 *
 * Differences from Tika:
 *  - At most 100 rows are read from each table, the rest being left out without an error, and a TEXT cell is cut to 4,096
 *    characters; Tika reads everything. Both are the limits this parser had before, kept. More than 1,000,000 characters
 *    of cell text in all is a LimitExceededError. A file over 256 MiB, or one with over 10,000 tables or a table with
 *    over 500 columns, is a LimitExceededError (new: there was no limit on the size before).
 *  - Everything GeoPkgParser lists: sql.js reads the database from memory, a generated column is not read, a table name
 *    is quoted, an embedded blob is named `<column>_<row>` without an extension, and a corrupt file is a
 *    MalformedDocumentError.
 */
export class SqliteParser implements Parser {
  readonly name = "SQLite3Parser";
  readonly capabilities = { requiresRandomAccess: true, unsafe: true } as const;
  readonly #tables = createSqliteTablesParser({
    name: this.name,
    // Tika claims application/x-sqlite3 only; the other two spellings were claimed here before and still are.
    mediaTypes: ["application/vnd.sqlite3", "application/x-sqlite3", "application/x-sqlite"],
    noun: "SQLite database",
    maxBytes: MAX_BYTES,
    maxTables: MAX_TABLES,
    maxColumns: MAX_COLUMNS,
    maxRows: MAX_ROWS,
    maxChars: MAX_TOTAL_CHARS,
    // SQLite3Parser has no ignored BLOB columns: every one is an embedded document.
    ignoreBlobColumns: new Set(),
    maxRowsPerTable: MAX_ROWS_PER_TABLE,
    maxCellChars: MAX_CELL_CHARS,
  });

  getSupportedTypes(): ReadonlySet<MediaType> {
    return this.#tables.getSupportedTypes();
  }

  parse(stream: RipstreamInputStream, handler: ContentHandler, metadata: Metadata, ctx: ParseContext): Promise<void> {
    return this.#tables.parse(stream, handler, metadata, ctx);
  }
}
