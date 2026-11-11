import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { loadSqlJs, quoteIdentifier, type SqlDatabase } from "./sql-js.ts";

const MAX_CELL_CHARS = 4_096;
const MAX_TOTAL_CHARS = 1_000_000;
const MAX_ROWS = 100;

/** SQLite parser backed by optional sql.js (WASM, no native addon). */
export class SqliteParser implements Parser {
  readonly name = "SQLite3Parser";
  readonly capabilities = { requiresRandomAccess: true, unsafe: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([
      MediaType.parse("application/vnd.sqlite3")!,
      MediaType.parse("application/x-sqlite3")!,
      MediaType.parse("application/x-sqlite")!,
    ]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (new TextDecoder("latin1").decode(data.subarray(0, 16)) !== "SQLite format 3\u0000") {
      throw new MalformedDocumentError("Not a SQLite database");
    }
    let database: SqlDatabase | null = null;
    try {
      const SQL = await loadSqlJs();
      database = new SQL.Database(data);
      const tables = database.exec(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      );
      const names = (tables[0]?.values ?? []).map((row) => String(row[0]));
      metadata.set("sqlite:table-count", String(names.length));
      const xhtml = new XHTMLContentHandler(handler, metadata);
      await xhtml.startDocument();
      let totalChars = 0;
      for (const table of names) {
        await xhtml.element("h1", table);
        // table_xinfo hidden flag: 0 normal, 1 hidden, 2 VIRTUAL generated, 3 STORED generated.
        // Select only real columns. substr(...) below caps a real cell's length, but a generated
        // column's expression (e.g. hex(zeroblob(N))) is fully materialized inside WASM *before*
        // substr truncates the result, so generated columns must be excluded entirely.
        const columns = database.exec(
          `PRAGMA table_xinfo(${quoteIdentifier(table)})`,
        )[0];
        const nameIndex = columns?.columns.indexOf("name") ?? -1;
        const hiddenIndex = columns?.columns.indexOf("hidden") ?? -1;
        const selected = (columns?.values ?? [])
          .filter((column) => column[hiddenIndex] === 0)
          .map(
            (column) =>
              `substr(${quoteIdentifier(String(column[nameIndex]))}, 1, ${MAX_CELL_CHARS})`,
          );
        if (selected.length === 0) continue;
        const rows = database.exec(
          `SELECT ${selected.join(", ")} FROM ${quoteIdentifier(table)} LIMIT ${MAX_ROWS}`,
        );
        for (const row of rows[0]?.values ?? []) {
          const line = row.map((value) => String(value ?? "")).join("\t");
          totalChars += line.length;
          if (totalChars > MAX_TOTAL_CHARS) {
            throw new LimitExceededError(
              `SQLite content exceeds ${MAX_TOTAL_CHARS} characters`,
            );
          }
          await xhtml.element("p", line);
        }
      }
      await xhtml.endDocument();
    } catch (error) {
      if (error instanceof LimitExceededError) throw error;
      throw new MalformedDocumentError("Unable to read SQLite database", { cause: error });
    } finally {
      database?.close();
    }
  }
}

export { OpenPgpParser } from "./openpgp.ts";
export { ColumnarParser } from "./columnar.ts";
export {
  GeoPkgParser,
  DEFAULT_MAX_GEOPKG_BYTES,
  DEFAULT_MAX_GEOPKG_CHARS,
  DEFAULT_MAX_GEOPKG_COLUMNS,
  DEFAULT_MAX_GEOPKG_ROWS,
  DEFAULT_MAX_GEOPKG_TABLES,
  type GeoPkgParserOptions,
} from "./geopkg.ts";
