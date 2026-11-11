import assert from "node:assert/strict";
import { test } from "node:test";
import { MalformedDocumentError, Metadata, ParseContext, RipstreamInputStream, createOutputHandler } from "@spikedpunch/ripstream-core";
import { QuattroProParser } from "../src/quattro-pro.ts";
import { buildOle } from "./ole-builder.ts";

/*
 * The counts that are too big for the stream (tikajs-68os.21). They live apart from quattro-pro-mutation.test.ts because a
 * reader that stopped checking the end of the stream would loop a billion times on them rather than fail: the mutation runs
 * that remove that check leave this file out, and the other tests there fail fast.
 */

const short = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const long = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const latin1 = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const qstr = (text: string): number[] => [...short(text.length - 1), 0, ...latin1(text)];
const record = (type: number, body: number[]): number[] => [...short(type), ...short(body.length), ...body];
const label = (text: string): number[] => record(0x0c72, [...short(0), ...long(0), ...short(0), ...qstr(text)]);

async function text(records: readonly number[][]): Promise<string> {
  const bytes = buildOle([{ name: "NativeContent_MAIN", data: Uint8Array.from(records.flat()) }]);
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  metadata.set("Content-Type", "application/x-quattro-pro; version=9");
  const handler = createOutputHandler("text");
  try {
    await new QuattroProParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return handler.toString();
}

const table = (count: number[]): number[][] => [record(0x0407, [...count, ...long(0), ...long(0)]), label("kept")];

test("a count with the top bit clear is a count the stream does not hold, whatever its high byte", async () => {
  await assert.rejects(text(table([0, 0, 0, 0x40])), MalformedDocumentError);
  await assert.rejects(text(table([0, 0, 0, 0x7f])), MalformedDocumentError);
});
