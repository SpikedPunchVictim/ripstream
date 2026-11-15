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
 * A new sql.js (SQLite compiled to WASM, no native addon) for each call, so one per document: a hostile file can trap
 * the WASM instance, and what a document leaves in the instance's memory file system (the bytes it was opened from)
 * must not be there for the next one.
 *
 * sql.js keeps the promise of its first init in the module and answers every later call with it, whatever the config,
 * so the module is taken out of the require cache and loaded again for each call: a new module is a new WASM instance
 * with an empty file system, and a rejected init is not carried forward. Measured at about 6 ms a document.
 */
export async function loadSqlJs(): Promise<SqlModule> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("sql.js");
  delete require.cache[entry];
  try {
    const init = require("sql.js") as (options?: Record<string, unknown>) => Promise<SqlModule>;
    return await init({ locateFile: (file: string) => join(dirname(entry), file) });
  } finally {
    // Not kept for the next call, and not kept alive by the cache either.
    delete require.cache[entry];
  }
}

/** A SQL identifier as the quoted form SQLite reads back as the same name. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
