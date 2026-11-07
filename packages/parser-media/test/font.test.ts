import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { FontParser } from "../src/index.ts";

function ttf(): Uint8Array {
  const name = "TestFont";
  const utf16 = [...name].flatMap((char) => [0, char.charCodeAt(0)]);
  const nameTable = new Uint8Array(18 + utf16.length);
  const nameView = new DataView(nameTable.buffer);
  nameView.setUint16(2, 1);
  nameView.setUint16(4, 18);
  nameView.setUint16(6, 3);
  nameView.setUint16(8, 1);
  nameView.setUint16(10, 0x0409);
  nameView.setUint16(12, 1);
  nameView.setUint16(14, utf16.length);
  nameView.setUint16(16, 0);
  nameTable.set(utf16, 18);
  const data = new Uint8Array(28 + nameTable.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, 1);
  data.set([0x6e, 0x61, 0x6d, 0x65], 12);
  view.setUint32(20, 28);
  view.setUint32(24, nameTable.length);
  data.set(nameTable, 28);
  return data;
}

test("extracts TrueType family names", async () => {
  const stream = await RipstreamInputStream.from(ttf());
  const metadata = new Metadata();
  await new FontParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("font:family"), "TestFont");
});

test("AFM metrics with long whitespace/CR lines parse in linear time", { timeout: 30_000 }, async () => {
  const text = `StartFontMetrics 4.1\nFontName Demo\nA${" ".repeat(100_000)}\rx\n`;
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(text));
  const metadata = new Metadata();
  const start = performance.now();
  await new FontParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.ok(performance.now() - start < 5000);
  assert.equal(metadata.get("font:postscript-name"), "Demo");
});

test("non-font text containing 'FontName ' is rejected, not accepted as empty AFM", async () => {
  const text = "this is just a document that mentions FontName  somewhere\nand nothing else useful\n";
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(text));
  await assert.rejects(
    new FontParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    (error: Error) => error.name === "MalformedDocumentError",
  );
  await stream.close();
});

test("StartFontMetrics with no recognised metric fields is rejected", async () => {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("StartFontMetrics 4.1\nEndFontMetrics\n"));
  await assert.rejects(
    new FontParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    (error: Error) => error.name === "MalformedDocumentError",
  );
  await stream.close();
});
