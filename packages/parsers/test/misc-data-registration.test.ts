import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  MediaType,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { createDefaultParser } from "../src/index.ts";

/*
 * Registration of the single-format Tika parsers of tikajs-68os.21. The claims are read from the Tika 4.2.0 source
 * (PListParser, TNEFParser, ChmParser); none of this was run against a Tika, which is not available here.
 */

/** The parsers selectParsers picks for a type through the registry (aliases and supertypes), best match first. */
async function selected(type: string): Promise<{ name: string; kind: string }[]> {
  const matches = await createDefaultParser().selectParsers(MediaType.parseOrThrow(type), new ParseContext());
  return matches.map((match) => ({ name: match.parser.name, kind: match.kind }));
}

/**
 * Parses with the type named in the metadata and no detection, as Tika's CompositeParser does when a caller sets
 * Content-Type: this is how a claim-only type (one no detector produces) reaches its parser.
 */
async function parseAs(bytes: Uint8Array, type: string): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  metadata.set("Content-Type", type);
  try {
    await createDefaultParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

test("the binary plist variants BPListDetector names reach PListParser exactly", async () => {
  // Tika's PListParser claims all four; the three subtypes are not in its MIME database, only a detector or a forced
  // content type produces them (PListParser.SUPPORTED_TYPES).
  for (const type of [
    "application/x-bplist",
    "application/x-bplist-itunes",
    "application/x-bplist-memgraph",
    "application/x-bplist-webarchive",
  ]) {
    const [first] = await selected(type);
    assert.deepEqual(first, { name: "PListParser", kind: "exact" }, type);
  }
});

test("both TNEF aliases reach TNEFParser exactly", async () => {
  // TNEFParser.SUPPORTED_TYPES: application/vnd.ms-tnef, application/ms-tnef, application/x-tnef.
  for (const type of ["application/vnd.ms-tnef", "application/ms-tnef", "application/x-tnef"]) {
    const [first] = await selected(type);
    assert.deepEqual(first, { name: "TNEFParser", kind: "exact" }, type);
  }
});

test("both CHM aliases reach the parser that takes application/vnd.ms-htmlhelp", async () => {
  // ChmParser.SUPPORTED_TYPES: application/vnd.ms-htmlhelp, application/chm, application/x-chm. Here the CHM reader is
  // a section of LegacyFormatParser.
  const [reference] = await selected("application/vnd.ms-htmlhelp");
  assert.equal(reference?.kind, "exact");
  for (const type of ["application/chm", "application/x-chm"]) {
    const [first] = await selected(type);
    assert.deepEqual(first, reference, type);
  }
});

test("a CHM forced as application/x-chm is parsed and reports application/vnd.ms-htmlhelp, as ChmParser sets it", async () => {
  const bytes = new Uint8Array(512);
  bytes.set(new TextEncoder().encode("ITSF"), 0);
  bytes.set(new TextEncoder().encode("Quarterly report"), 64);
  for (const type of ["application/chm", "application/x-chm"]) {
    const result = await parseAs(bytes, type);
    assert.equal(result.metadata.get("Content-Type"), "application/vnd.ms-htmlhelp", type);
    assert.match(result.text, /Quarterly report/, type);
  }
});

test("a binary plist forced as each bplist variant is parsed", async () => {
  // bplist00, one ASCII string "Ada" (object 0), a one-entry offset table, then the 32-byte trailer.
  const header = new TextEncoder().encode("bplist00");
  const object = Uint8Array.from([0x53, 0x41, 0x64, 0x61]);
  const trailer = new Uint8Array(32);
  trailer[6] = 1; // offset size
  trailer[7] = 1; // object reference size
  new DataView(trailer.buffer).setBigUint64(8, 1n); // object count
  new DataView(trailer.buffer).setBigUint64(24, BigInt(header.length + object.length)); // offset table position
  const bytes = Uint8Array.from([...header, ...object, header.length, ...trailer]);
  for (const type of [
    "application/x-bplist-itunes",
    "application/x-bplist-memgraph",
    "application/x-bplist-webarchive",
  ]) {
    const result = await parseAs(bytes, type);
    assert.match(result.text, /Ada/, type);
    assert.equal(result.metadata.get("tk:parsed-by"), "PListParser", type);
  }
});
