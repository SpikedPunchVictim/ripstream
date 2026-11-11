import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** What sql.js hands back for a cell: INTEGER and REAL as a number, TEXT as a string, BLOB as bytes, NULL as null. */
export type SqlValue = number | string | Uint8Array | null;

export interface SqlStatement {
  step(): boolean;
  get(): SqlValue[];
  free(): boolean;
}

export interface SqlDatabase {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface SqlModule {
  Database: new (data: Uint8Array) => SqlDatabase;
}

/**
 * A new sql.js (SQLite compiled to WASM, no native addon). One per document: a hostile file can trap the WASM instance,
 * and a trapped instance must not parse the next file.
 */
export async function loadSqlJs(): Promise<SqlModule> {
  const require = createRequire(import.meta.url);
  const init = (await import("sql.js")).default as (options?: Record<string, unknown>) => Promise<SqlModule>;
  return init({ locateFile: (file: string) => join(dirname(require.resolve("sql.js")), file) });
}

/** A SQL identifier as the quoted form SQLite reads back as the same name. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
