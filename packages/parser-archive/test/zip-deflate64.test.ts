import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  type Parser,
  XHTMLContentHandler,
} from "@spikedpunch/ripstream-core";
import { ZipParser } from "../src/index.ts";

const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const text = [...new TextEncoder().encode("payload.txt")];

/** A raw Deflate64 stream: one stored block, which Deflate and Deflate64 share. */
function storedDeflate64(data: Uint8Array): Uint8Array {
  const length = data.length;
  return new Uint8Array([0x01, ...le16(length), ...le16(~length & 0xffff), ...data]);
}

/** A one-entry ZIP whose entry is stored with method 9 (Deflate64). */
function deflate64Zip(data: Uint8Array): Uint8Array {
  const compressed = storedDeflate64(data);
  const local = [
    ...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(9), ...le16(0), ...le16(0),
    ...le32(0), ...le32(compressed.length), ...le32(data.length), ...le16(text.length), ...le16(0),
    ...text, ...compressed,
  ];
  const central = [
    ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(9), ...le16(0), ...le16(0),
    ...le32(0), ...le32(compressed.length), ...le32(data.length), ...le16(text.length), ...le16(0),
    ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(0), ...text,
  ];
  const eocd = [
    ...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(1), ...le16(1),
    ...le32(central.length), ...le32(local.length), ...le16(0),
  ];
  return new Uint8Array([...local, ...central, ...eocd]);
}

const plainTextParser: Parser = {
  getSupportedTypes: () => new Set(),
  async parse(stream, handler): Promise<void> {
    let value = "";
    for await (const chunk of stream) value += new TextDecoder().decode(chunk);
    const xhtml = new XHTMLContentHandler(handler, new Metadata());
    await xhtml.startDocument();
    await xhtml.element("p", value);
    await xhtml.endDocument();
  },
};

test("ZipParser decodes an entry stored with method 9 (Deflate64)", async () => {
  const stream = await RipstreamInputStream.from(deflate64Zip(new TextEncoder().encode("hello deflate64")));
  const handler = new BodyContentHandler();
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, plainTextParser);
  await new ZipParser().parse(stream, handler, new Metadata(), ctx);
  await stream.close();
  assert.match(handler.toString(), /hello deflate64/);
});

test("ZipParser decodes a real archive whose four entries are method 9 (Deflate64)", async () => {
  // brianhelba/zipfile-deflate64's archive, written by a real Deflate64 encoder (fixtures/deflate64/README.md).
  const data = new Uint8Array(readFileSync(new URL("./fixtures/deflate64/zipfile-deflate64.zip", import.meta.url)));
  const stream = await RipstreamInputStream.from(data);
  const handler = new BodyContentHandler();
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, plainTextParser);
  await new ZipParser().parse(stream, handler, new Metadata(), ctx);
  await stream.close();
  const text = handler.toString();
  for (const name of ["10_lines.txt", "100_lines.txt", "10k_lines.txt", "100k_lines.txt"]) {
    assert.ok(text.includes(name), name);
  }
  assert.match(text, /Sample content 99999\./);
});
