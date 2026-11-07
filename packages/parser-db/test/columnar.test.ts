import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { parquetWriteBuffer } from "hyparquet-writer";
import { ColumnarParser } from "../src/index.ts";

test("reads Parquet rows and schema", async () => {
  const buffer = parquetWriteBuffer({
    columnData: [
      { name: "name", data: ["Ada", "Grace"] },
      { name: "age", data: [36, 45] },
    ],
  });
  const stream = await RipstreamInputStream.from(new Uint8Array(buffer));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new ColumnarParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("parquet:row-count"), "2");
  assert.match(handler.toString(), /Ada/);
  assert.match(handler.toString(), /Grace/);
});

test("serializes Parquet INT64 columns without BigInt errors", async () => {
  const buffer = parquetWriteBuffer({
    columnData: [{ name: "id", data: [1n, 9007199254740993n], type: "INT64" }],
  });
  const stream = await RipstreamInputStream.from(new Uint8Array(buffer));
  const handler = new BodyContentHandler();
  await new ColumnarParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /9007199254740993/);
});

test("ColumnarParser lists application/x-parquet", () => {
  const types = [...new ColumnarParser().getSupportedTypes()].map(String);
  assert.ok(types.includes("application/x-parquet"));
});
