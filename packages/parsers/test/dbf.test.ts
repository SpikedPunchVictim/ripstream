import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DbfParser } from "../src/index.ts";

function dbf(): Uint8Array {
  const headerLength = 32 + 32 + 1;
  const recordLength = 1 + 10;
  const data = new Uint8Array(headerLength + recordLength + 1);
  const view = new DataView(data.buffer);
  data[0] = 0x03;
  view.setUint32(4, 1, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  const name = "NAME";
  for (let index = 0; index < name.length; index++) data[32 + index] = name.charCodeAt(index);
  data[32 + 11] = "C".charCodeAt(0);
  data[32 + 16] = 10;
  data[headerLength - 1] = 0x0d;
  data[headerLength] = 0x20;
  const value = "Ada";
  for (let index = 0; index < value.length; index++) data[headerLength + 1 + index] = value.charCodeAt(index);
  return data;
}

test("extracts DBF fields and records", async () => {
  const stream = await RipstreamInputStream.from(dbf());
  const handler = new BodyContentHandler();
  await new DbfParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /NAME/);
  assert.match(handler.toString(), /Ada/);
});

test("DBF parse honors an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const data = dbf();
  new DataView(data.buffer).setUint32(4, 1000, true);
  const big = new Uint8Array(data.length + 11 * 999);
  big.set(data);
  const stream = await RipstreamInputStream.from(big);
  await assert.rejects(
    new DbfParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext({ signal: controller.signal })),
  );
  await stream.close();
});
