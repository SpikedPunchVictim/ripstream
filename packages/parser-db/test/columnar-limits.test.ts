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
import type { FileMetaData, SchemaElement } from "hyparquet";
import { checkParquetFooter, checkParquetPages, type ParquetLimits } from "../src/parquet-limits.ts";
import {
  chunkOf,
  chunkSized,
  deepSchemaFooter,
  leaf,
  manyRowGroupsFooter,
  pageBomb,
  pagesFile,
  rowGroupOf,
  truncatedSchemaFooter,
  wideSchemaFooter,
  type PageSpec,
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

// ---- the checks called directly, on footers and page bytes put together by hand ---------------------------------------
// Every limit has a different value so a check that reads the wrong one is caught.

const LIMITS: ParquetLimits = { maxSchemaElements: 1_000, maxSchemaDepth: 50, maxRowGroups: 7, maxPageValues: 10 };

function footerOf(schema: SchemaElement[], rowGroups: FileMetaData["row_groups"] = []): FileMetaData {
  return { version: 1, schema, num_rows: 0n, row_groups: rowGroups, metadata_length: 0 };
}

function pagesAreChecked(pages: PageSpec[], chunkValues = 1_000_000n, trailing: number[] = []): void {
  const { file, chunkSize } = pagesFile(pages, trailing);
  const footer = footerOf([], [rowGroupOf(1, chunkSized(chunkSize, { numValues: chunkValues }))]);
  checkParquetPages(file, footer, LIMITS);
}

test("a footer with no schema is a MalformedDocumentError", () => {
  assert.throws(() => checkParquetFooter(footerOf([]), LIMITS), (error: unknown) => {
    assert.ok(error instanceof MalformedDocumentError);
    assert.match(error.message, /no schema/);
    return true;
  });
});

test("a schema element after a root that has no children is a MalformedDocumentError", () => {
  assert.throws(() => checkParquetFooter(footerOf([{ name: "root" }, leaf("a")]), LIMITS), /outside the root/);
});

test("a schema element after the children the root declared is a MalformedDocumentError", () => {
  const schema = [{ name: "root", num_children: 1 }, leaf("a"), leaf("b")];
  assert.throws(() => checkParquetFooter(footerOf(schema), LIMITS), /outside the root/);
});

test("a well-formed nested schema passes, and its depth is the level of its deepest leaf", () => {
  const schema: SchemaElement[] = [
    { name: "root", num_children: 2 },
    { name: "g", num_children: 2 },
    leaf("a"),
    leaf("b"),
    leaf("c"),
  ];
  checkParquetFooter(footerOf(schema), { ...LIMITS, maxSchemaDepth: 3 });
  assert.throws(() => checkParquetFooter(footerOf(schema), { ...LIMITS, maxSchemaDepth: 2 }), LimitExceededError);
});

test("a root with no children and nothing after it is a schema of depth one", () => {
  checkParquetFooter(footerOf([{ name: "root" }]), { ...LIMITS, maxSchemaDepth: 1 });
});

test("a data page of any version that claims more values than the limit is a LimitExceededError", () => {
  for (const kind of ["data", "data-v2", "dictionary"] as const) {
    assert.throws(() => pagesAreChecked([{ kind, values: 11 }]), LimitExceededError, kind);
    pagesAreChecked([{ kind, values: 10 }]);
  }
});

test("the page value limit read is maxPageValues, not another limit", () => {
  const { file, chunkSize } = pagesFile([{ kind: "data", values: 500 }]);
  const footer = footerOf([], [rowGroupOf(1, chunkSized(chunkSize))]);
  checkParquetPages(file, footer, { ...LIMITS, maxPageValues: 500 });
  assert.throws(() => checkParquetPages(file, footer, { ...LIMITS, maxPageValues: 499 }), LimitExceededError);
});

test("a dictionary may list more entries than its chunk has values, a data page may not", () => {
  pagesAreChecked([{ kind: "dictionary", values: 9 }, { kind: "data", values: 3 }], 3n);
  assert.throws(() => pagesAreChecked([{ kind: "data", values: 4 }], 3n), MalformedDocumentError);
  assert.throws(() => pagesAreChecked([{ kind: "data-v2", values: 4 }], 3n), MalformedDocumentError);
});

test("pages that add up to a whole chunk are walked to its end", () => {
  pagesAreChecked([{ kind: "dictionary", values: 2, body: 6 }, { kind: "data", values: 3, body: 5 }, { kind: "data", values: 3, body: 5 }], 6n);
  assert.throws(
    () => pagesAreChecked([{ kind: "data", values: 3, body: 5 }, { kind: "data", values: 11, body: 5 }], 6n),
    LimitExceededError,
  );
});

test("a page whose size runs past its column chunk is a MalformedDocumentError", () => {
  assert.throws(() => pagesAreChecked([{ kind: "data", values: 1, body: 4, claimedSize: 5 }]), /extends past its column chunk/);
  pagesAreChecked([{ kind: "data", values: 1, body: 4, claimedSize: 4 }]);
});

test("a page of no bytes is read and the walk goes on to the next one", () => {
  assert.throws(() => pagesAreChecked([{ kind: "data", values: 1 }, { kind: "data", values: 11 }]), LimitExceededError);
});

test("a page whose size is negative is a MalformedDocumentError, not a walk backwards", () => {
  assert.throws(() => pagesAreChecked([{ kind: "data", values: 1, claimedSize: -1 }]), /invalid size/);
});

test("one trailing byte of a chunk is ignored and two are read as a page header", () => {
  pagesAreChecked([{ kind: "data", values: 1 }], 1_000_000n, [0]);
  assert.throws(() => pagesAreChecked([{ kind: "data", values: 1 }], 1_000_000n, [0, 0]), MalformedDocumentError);
});

test("a page header that cannot be decoded is a MalformedDocumentError that keeps the decoder's error as its cause", () => {
  // A struct field header and then nothing: the thrift reader runs off the end of the chunk.
  assert.throws(() => pagesAreChecked([], 1n, [0x1c, 0x1c, 0x1c]), (error: unknown) => {
    assert.ok(error instanceof MalformedDocumentError);
    assert.match(error.message, /Invalid Parquet page header in column a/);
    assert.ok((error as Error).cause instanceof Error);
    return true;
  });
});

test("a column chunk with no metadata is skipped for hyparquet to report", () => {
  const { file } = pagesFile([]);
  checkParquetPages(file, footerOf([], [rowGroupOf(1, { file_offset: 0n })]), LIMITS);
});

test("a column chunk with a negative offset or size is a MalformedDocumentError naming the column", () => {
  const { file } = pagesFile([{ kind: "data", values: 1 }]);
  for (const chunk of [chunkSized(10, { dataPageOffset: -1n }), chunkSized(-5)]) {
    assert.throws(() => checkParquetPages(file, footerOf([], [rowGroupOf(1, chunk)]), LIMITS), /column a has an invalid byte range/);
  }
});

test("a column chunk of no bytes, or one that starts at offset 0, is a valid range", () => {
  const { file, chunkSize } = pagesFile([{ kind: "data", values: 1 }]);
  checkParquetPages(file, footerOf([], [rowGroupOf(1, chunkSized(0))]), LIMITS);
  // From offset 0 the PAR1 magic is read as a page header, which is not one.
  assert.throws(
    () => checkParquetPages(file, footerOf([], [rowGroupOf(1, chunkSized(chunkSize + 4, { dataPageOffset: 0n }))]), LIMITS),
    (error: unknown) => error instanceof MalformedDocumentError && !/byte range/.test(error.message),
  );
});

test("a chunk that ends past the end of the file is walked as far as the file goes", () => {
  const { file } = pagesFile([{ kind: "data", values: 11 }]);
  assert.throws(() => checkParquetPages(file, footerOf([], [rowGroupOf(1, chunkSized(10_000))]), LIMITS), LimitExceededError);
});

test("a chunk that starts past the end of the file has nothing to walk", () => {
  const { file } = pagesFile([{ kind: "data", values: 11 }]);
  checkParquetPages(file, footerOf([], [rowGroupOf(1, chunkSized(10, { dataPageOffset: 10_000n }))]), LIMITS);
});

test("a chunk of exactly 1 GiB is walked and a chunk of more than that is skipped, as hyparquet skips it", () => {
  const { file } = pagesFile([{ kind: "data", values: 11 }]);
  const gib = 1 << 30;
  assert.throws(() => checkParquetPages(file, footerOf([], [rowGroupOf(1, chunkSized(gib))]), LIMITS), LimitExceededError);
  checkParquetPages(file, footerOf([], [rowGroupOf(1, chunkSized(gib + 1))]), LIMITS);
});

test("a dictionary offset of 0 means there is no dictionary and the data page offset is used", () => {
  const { file, chunkSize } = pagesFile([{ kind: "data", values: 11 }]);
  const chunk = chunkSized(chunkSize, { dictionaryPageOffset: 0n });
  assert.throws(() => checkParquetPages(file, footerOf([], [rowGroupOf(1, chunk)]), LIMITS), LimitExceededError);
});

test("a dictionary offset starts the walk at the dictionary page", () => {
  const dictionary: PageSpec = { kind: "dictionary", values: 11, body: 3 };
  const { file, chunkSize } = pagesFile([dictionary, { kind: "data", values: 1 }]);
  // The data page header sits after the dictionary page; a walk from there alone would not see the dictionary.
  const dataOffset = BigInt(4 + pagesFile([dictionary]).chunkSize);
  const chunk = chunkSized(chunkSize, { dictionaryPageOffset: 4n, dataPageOffset: dataOffset });
  assert.throws(() => checkParquetPages(file, footerOf([], [rowGroupOf(1, chunk)]), LIMITS), LimitExceededError);
});

test("only the row groups that hold rows below the row the parser stops at are walked", () => {
  const { file, chunkSize } = pagesFile([{ kind: "data", values: 11 }]);
  const bomb = chunkSized(chunkSize);
  const harmless = chunkSized(0);
  // Rows 0..99 are the first group; the group that starts at row 100 is never read.
  checkParquetPages(file, footerOf([], [rowGroupOf(100, harmless), rowGroupOf(1, bomb)]), LIMITS);
  // The group that starts at row 99 holds row 99, which is read.
  assert.throws(
    () => checkParquetPages(file, footerOf([], [rowGroupOf(99, harmless), rowGroupOf(1, bomb)]), LIMITS),
    LimitExceededError,
  );
  // Rows are counted across groups.
  assert.throws(
    () => checkParquetPages(file, footerOf([], [rowGroupOf(40, harmless), rowGroupOf(40, harmless), rowGroupOf(40, bomb)]), LIMITS),
    LimitExceededError,
  );
  checkParquetPages(file, footerOf([], [rowGroupOf(60, harmless), rowGroupOf(60, harmless), rowGroupOf(1, bomb)]), LIMITS);
});

test("a failing chunk is named by its whole path in the schema", () => {
  const { file, chunkSize } = pagesFile([{ kind: "data", values: 11 }]);
  const chunk = chunkSized(chunkSize);
  chunk.meta_data!.path_in_schema = ["outer", "inner"];
  assert.throws(() => checkParquetPages(file, footerOf([], [rowGroupOf(1, chunk)]), LIMITS), /column outer\.inner/);
});

test("every column chunk of a row group is walked, not just the first", () => {
  const { file, chunkSize } = pagesFile([{ kind: "data", values: 11 }]);
  const group = rowGroupOf(1, chunkOf("ok", 1n, 4n), chunkSized(chunkSize));
  assert.throws(() => checkParquetPages(file, footerOf([], [group]), LIMITS), LimitExceededError);
});
