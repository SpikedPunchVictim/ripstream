import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import initSqlJs from "sql.js";
import { SqliteParser } from "../src/index.ts";

const require = createRequire(import.meta.url);

test("reads SQLite tables", async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => join(dirname(require.resolve("sql.js")), file),
  });
  const database = new SQL.Database();
  database.run("CREATE TABLE people (name TEXT, age INTEGER)");
  database.run("INSERT INTO people VALUES ('Ada', 36), ('Grace', 45)");
  const bytes = database.export();
  database.close();

  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new SqliteParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("sqlite:table-count"), "1");
  assert.match(handler.toString(), /Ada/);
  assert.match(handler.toString(), /Grace/);
});

test("drops generated columns instead of materializing them", async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => join(dirname(require.resolve("sql.js")), file),
  });
  const database = new SQL.Database();
  database.run(
    "CREATE TABLE t (a INTEGER, g TEXT GENERATED ALWAYS AS (hex(zeroblob(3000000 + a))) VIRTUAL)",
  );
  database.run("INSERT INTO t (a) VALUES (1), (2), (3)");
  const bytes = database.export();
  database.close();

  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  await new SqliteParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  const output = handler.toString();
  // The generated column g = hex(zeroblob(~6MB)) must never be materialized inside WASM:
  // it is dropped entirely rather than SELECTed and truncated as a result string.
  assert.ok(output.length < 20_000);
  assert.doesNotMatch(output, /0000/); // generated column absent from output
  assert.match(output, /\b1\b/); // real column `a` still emitted
});
