import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Metadata,
  coerceMetadataValue,
  metadataToCsv,
  metadataToXml,
  parseXmpPacket,
  writeXmpPacket,
} from "../src/index.ts";

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
