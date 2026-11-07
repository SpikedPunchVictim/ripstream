import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { LegacyOfficeParser } from "../src/index.ts";

test("extracts best-effort OneNote strings", async () => {
  const text = "OneNote sample text";
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++) {
    bytes[index * 2] = text.charCodeAt(index);
  }
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  metadata.set("Content-Type", "application/onenote");
  await new LegacyOfficeParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /OneNote sample/);
});

test("reads Access engine signature", async () => {
  const bytes = new Uint8Array(64);
  bytes.set([...new TextEncoder().encode("Standard Jet DB")], 4);
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  metadata.set("Content-Type", "application/x-msaccess");
  await new LegacyOfficeParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.match(metadata.get("access:engine") ?? "", /Standard Jet DB/);
});

test("extracts legacy BIFF2 labels", async () => {
  const { ExcelBinaryParser } = await import("../src/index.ts");
  const label = "BIFF2 text";
  const payload = [0, 0, 0, 0, 0, 0, label.length, ...new TextEncoder().encode(label)];
  const data = new Uint8Array([0x09, 0x00, 0, 0, 0x04, 0x00, payload.length, 0, ...payload]);
  const stream = await RipstreamInputStream.from(data);
  const handler = new BodyContentHandler();
  await new ExcelBinaryParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /BIFF2 text/);
});

test("extracts legacy HWP printable text", async () => {
  const { LegacyFormatParser } = await import("../src/index.ts");
  const data = new Uint8Array([...new TextEncoder().encode("HWP Document File"), 0, 0, 0, ...new TextEncoder().encode("Hangul body text")]);
  const stream = await RipstreamInputStream.from(data);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  metadata.set("Content-Type", "application/x-hwp");
  await new LegacyFormatParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /Hangul body text/);
});
