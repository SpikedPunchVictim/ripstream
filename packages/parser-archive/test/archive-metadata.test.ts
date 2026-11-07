import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { ArchiveMetadataParser } from "../src/index.ts";

test("reads RAR and 7z metadata", async () => {
  const rar = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
  const seven = new Uint8Array(32);
  seven.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]);
  for (const [bytes, format] of [[rar, "RAR5"], [seven, "7z"]] as const) {
    const stream = await RipstreamInputStream.from(bytes);
    const metadata = new Metadata();
    await new ArchiveMetadataParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
    await stream.close();
    assert.equal(metadata.get("archive:format"), format);
  }
});

test("reads ARJ signature metadata", async () => {
  const { ArchiveMetadataParser: Parser } = await import("../src/index.ts");
  const stream = await RipstreamInputStream.from(new Uint8Array([0x60, 0xea, 0, 0, 0, 0, 11]));
  const metadata = new Metadata();
  await new Parser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("archive:format"), "ARJ");
});

test("truncated 7z headers raise MalformedDocumentError", async () => {
  const seven = new Uint8Array(32);
  seven.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]);
  for (let length = 4; length < 32; length++) {
    const stream = await RipstreamInputStream.from(seven.slice(0, length));
    await assert.rejects(
      new ArchiveMetadataParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
      (error: Error) => error.name === "MalformedDocumentError",
    );
    await stream.close();
  }
});
