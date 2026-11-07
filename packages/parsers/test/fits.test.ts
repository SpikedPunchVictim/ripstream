import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, MalformedDocumentError, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { FitsParser } from "../src/index.ts";

function card(keyword: string, value: string): string {
  return (keyword.padEnd(8) + "= " + value.padEnd(20) + "/ comment").padEnd(80).slice(0, 80);
}

test("reads FITS header cards", async () => {
  const header = [
    card("SIMPLE", "T"),
    card("BITPIX", "16"),
    card("NAXIS", "2"),
    card("OBJECT", "'M42'"),
    "END".padEnd(80),
  ].join("");
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(header));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new FitsParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("fits:BITPIX"), "16");
  assert.equal(metadata.get("fits:OBJECT"), "M42");
});

test("rejects non-FITS data", async () => {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("x".repeat(80)));
  await assert.rejects(
    new FitsParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
});
