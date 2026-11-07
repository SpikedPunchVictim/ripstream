import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IncludeExcludeFilter,
  Metadata,
  MetadataWriteLimitFilter,
  coerceMetadataValue,
  metadataToCsv,
  metadataToXml,
  parseXmpPacket,
  writeXmpPacket,
} from "../src/index.ts";

test("include/exclude filters select keys", () => {
  const metadata = new Metadata();
  metadata.set("dc:title", "Doc");
  metadata.set("pdf:producer", "Tool");
  new IncludeExcludeFilter({ include: ["dc:*"], exclude: ["pdf:*"] }).filter(metadata);
  assert.equal(metadata.get("dc:title"), "Doc");
  assert.equal(metadata.get("pdf:producer"), null);
});

test("write limits cap values and counts", () => {
  const metadata = new Metadata();
  metadata.add("dc:subject", "one");
  metadata.add("dc:subject", "two");
  metadata.add("dc:title", "abcdefgh");
  new MetadataWriteLimitFilter({ maxValues: 1, maxValueChars: 3 }).filter(metadata);
  assert.deepEqual(metadata.getAll("dc:subject"), ["one"]);
  assert.equal(metadata.get("dc:title"), "abc");
});

test("coerces schema-typed values", () => {
  assert.equal(coerceMetadataValue("meta:page-count", "3"), 3);
  assert.equal(coerceMetadataValue("pdf:pdf-version", "1.7"), 1.7);
  assert.equal(coerceMetadataValue("pdf:encrypted", "true"), true);
  assert.equal(coerceMetadataValue("unknown:key", "x"), "x");
});

test("serializes metadata to CSV and XML", () => {
  const metadata = new Metadata();
  metadata.set("dc:title", 'A, "quoted" title');
  metadata.add("dc:subject", "a<b");
  assert.match(metadataToCsv(metadata), /"A, ""quoted"" title"/);
  assert.match(metadataToXml(metadata), /a&lt;b/);
  assert.match(metadataToXml(metadata), /name="dc:title"/);
});

test("parses and writes XMP packets", () => {
  const metadata = new Metadata();
  metadata.set("dc:title", "Doc <A>");
  metadata.set("xmp:CreatorTool", "Tool");
  const packet = writeXmpPacket(metadata);
  assert.match(packet, /xpacket begin/);
  const parsed = parseXmpPacket(packet);
  assert.equal(parsed.get("dc:title"), "Doc <A>");
  assert.equal(parsed.get("xmp:CreatorTool"), "Tool");
});
