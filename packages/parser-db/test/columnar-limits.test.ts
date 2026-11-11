import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, LimitExceededError, MalformedDocumentError, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { parquetWriteBuffer } from "hyparquet-writer";
import {
  ColumnarParser,
  DEFAULT_MAX_PARQUET_PAGE_VALUES,
  DEFAULT_MAX_PARQUET_ROW_GROUPS,
  DEFAULT_MAX_PARQUET_SCHEMA_DEPTH,
  DEFAULT_MAX_PARQUET_SCHEMA_ELEMENTS,
  type ColumnarParserOptions,
} from "../src/index.ts";
import {
  deepSchemaFooter,
  manyRowGroupsFooter,
  pageBomb,
  truncatedSchemaFooter,
  wideSchemaFooter,
} from "./parquet-hostile.ts";

async function parse(bytes: Uint8Array, options?: ColumnarParserOptions): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(bytes);
  try {
    const handler = new BodyContentHandler();
    const metadata = new Metadata();
    await new ColumnarParser(options).parse(stream, handler, metadata, new ParseContext());
    return { text: handler.toString(), metadata };
  } finally {
    await stream.close();
  }
}

function wideFile(columns: number): Uint8Array {
  const columnData = Array.from({ length: columns }, (_, i) => ({ name: `c${i}`, data: [i], type: "INT32" as const }));
  return new Uint8Array(parquetWriteBuffer({ columnData }));
}

test("a schema with more elements than the limit is a LimitExceededError before any column is read", async () => {
  // 11 columns and the root make 12 schema elements.
  await assert.rejects(parse(wideFile(11), { maxSchemaElements: 11 }), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.match(error.message, /12 schema elements/);
    return true;
  });
});

test("a schema with exactly the limit's elements is read", async () => {
  const { text } = await parse(wideFile(11), { maxSchemaElements: 12 });
  assert.match(text, /"c10":10/);
});

test("the default schema limit stops a footer that lists one column too many", async () => {
  const columns = DEFAULT_MAX_PARQUET_SCHEMA_ELEMENTS; // plus the root: one element over
  await assert.rejects(parse(wideSchemaFooter(columns)), LimitExceededError);
});

test("a schema nested deeper than the limit is a LimitExceededError", async () => {
  // root, three groups and a leaf: the leaf is at depth 5, the root being 1.
  await assert.rejects(parse(deepSchemaFooter(3), { maxSchemaDepth: 4 }), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.match(error.message, /nested deeper than 4/);
    return true;
  });
});

test("a schema whose depth is the limit is read", async () => {
  const { metadata } = await parse(deepSchemaFooter(3), { maxSchemaDepth: 5 });
  assert.equal(metadata.get("parquet:row-count"), "0");
});

test("a schema nested far past the default depth is a LimitExceededError, not a stack overflow", async () => {
  for (const depth of [DEFAULT_MAX_PARQUET_SCHEMA_DEPTH, 3_000, 10_000]) {
    await assert.rejects(parse(deepSchemaFooter(depth)), LimitExceededError, `depth ${depth}`);
  }
});

test("a schema whose root claims children it does not have is a MalformedDocumentError", async () => {
  await assert.rejects(parse(truncatedSchemaFooter()), MalformedDocumentError);
});

test("more row groups than the limit is a LimitExceededError", async () => {
  await assert.rejects(parse(manyRowGroupsFooter(4), { maxRowGroups: 3 }), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.match(error.message, /4 row groups/);
    return true;
  });
});

test("exactly the limit's row groups are read", async () => {
  const buffer = parquetWriteBuffer({ columnData: [{ name: "a", data: [1, 2, 3], type: "INT32" }], rowGroupSize: 1 });
  const { text } = await parse(new Uint8Array(buffer), { maxRowGroups: 3 });
  assert.match(text, /"a":3/);
});

test("the default row group limit stops a footer that lists one group too many", async () => {
  await assert.rejects(parse(manyRowGroupsFooter(DEFAULT_MAX_PARQUET_ROW_GROUPS + 1)), LimitExceededError);
});

test("a data page that claims more values than the limit is a LimitExceededError from a few bytes", async () => {
  const bomb = pageBomb({ pageValues: DEFAULT_MAX_PARQUET_PAGE_VALUES * 16 });
  assert.ok(bomb.byteLength < 200, `the file is ${bomb.byteLength} bytes`);
  await assert.rejects(parse(bomb), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.match(error.message, /values/);
    return true;
  });
});

test("a data page at the limit's values is read", async () => {
  const { text } = await parse(pageBomb({ pageValues: 1_000 }), { maxPageValues: 1_000 });
  assert.match(text, /Rows: 1000/);
});

test("a data page that claims more values than its column chunk is a MalformedDocumentError", async () => {
  await assert.rejects(parse(pageBomb({ pageValues: 5, chunkValues: 2 })), MalformedDocumentError);
});

test("an honest file with dictionary pages, nulls, compression and several row groups reads under the default limits", async () => {
  const colors = Array.from({ length: 300 }, (_, i) => (i % 7 === 0 ? null : ["red", "green", "blue"][i % 3]!));
  const numbers = Array.from({ length: 300 }, (_, i) => i);
  const buffer = parquetWriteBuffer({
    columnData: [
      { name: "color", data: colors, type: "STRING" },
      { name: "n", data: numbers, type: "INT32" },
    ],
    rowGroupSize: 120,
  });
  const { text, metadata } = await parse(new Uint8Array(buffer));
  assert.equal(metadata.get("parquet:row-count"), "300");
  assert.match(text, /"color":null,"n":0/);
  assert.match(text, /"color":"red","n":99/);
});

test("a limit that is not a positive integer is refused when the parser is built", () => {
  assert.throws(() => new ColumnarParser({ maxRowGroups: 0 }), RangeError);
  assert.throws(() => new ColumnarParser({ maxSchemaElements: 1.5 }), RangeError);
});
