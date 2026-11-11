import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  ParserDeclinedError,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { Dgn8Parser } from "../src/dgn8.ts";
import { buildOle, buildPropertySet, SUMMARY_INFORMATION_FMTID } from "./ole-builder.ts";

/*
 * DGN8Parser (tikajs-68os.21). What Tika asserts on testDGN8.dgn is in fixtures/misc-data/dgn8.json; this file holds what
 * a fixture cannot say. Read from the Tika 4.2.0 source, not run against a Tika.
 */

const DGN8 = "image/vnd.dgn; version=8";

const SUMMARY = buildPropertySet(SUMMARY_INFORMATION_FMTID, { 8: "Ada Lovelace", 18: "MicroStation v8" });
const SMALL_DGN8 = buildOle([{ name: "\u0005SummaryInformation", data: SUMMARY }]);

async function parseAs(bytes: Uint8Array, type: string | undefined): Promise<Metadata> {
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  if (type !== undefined) metadata.set("Content-Type", type);
  try {
    await new Dgn8Parser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata;
}

test("called without a Content-Type the parser reads the file, as Tika does", async () => {
  const metadata = new Metadata();
  const stream = await RipstreamInputStream.from(SMALL_DGN8);
  await new Dgn8Parser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  assert.equal(metadata.get("meta:last-author"), "Ada Lovelace");
});

test("a small compound file with a summary stream gives the author and application", async () => {
  const metadata = await parseAs(SMALL_DGN8, DGN8);
  assert.equal(metadata.get("meta:last-author"), "Ada Lovelace");
  assert.equal(metadata.get("extended-properties:Application"), "MicroStation v8");
});

test("a compound file without a summary stream parses to no metadata, as SummaryExtractor does", async () => {
  const metadata = await parseAs(buildOle([{ name: "Other", data: new Uint8Array(10) }]), DGN8);
  assert.equal(metadata.get("meta:last-author"), null);
});

test("every prefix of a compound file is parsed or refused as malformed", async () => {
  for (let length = 0; length < SMALL_DGN8.length; length++) {
    try {
      await parseAs(SMALL_DGN8.subarray(0, length), DGN8);
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix ${length}: ${String(error)}`);
    }
  }
});

test("a prefix of the real file every 251 bytes is parsed or refused as malformed", async () => {
  const real = readFileSync(new URL("./fixtures/misc-data/testDGN8.dgn", import.meta.url));
  for (let length = 0; length < real.length; length += 251) {
    try {
      await parseAs(real.subarray(0, length), DGN8);
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix ${length}: ${String(error)}`);
    }
  }
});

test("a summary stream declaring 2 GB below a huge mini cutoff is refused without allocating it", async () => {
  const hostile = buildOle([{ name: "\u0005SummaryInformation", data: SUMMARY }], {
    miniCutoff: 0xffffffff,
    declaredSize: { "\u0005SummaryInformation": 0x7fffffff },
  });
  await assert.rejects(parseAs(hostile, DGN8), (error) => error instanceof MalformedDocumentError || error instanceof LimitExceededError);
});

test("bytes that are not a compound file are malformed under the exact type", async () => {
  await assert.rejects(parseAs(new TextEncoder().encode("not a compound file at all"), DGN8), MalformedDocumentError);
});

test("DGN7 and an unversioned image/vnd.dgn are declined by the version 8 parser", async () => {
  for (const type of ["image/vnd.dgn; version=7", "image/vnd.dgn"]) {
    await assert.rejects(parseAs(SMALL_DGN8, type), ParserDeclinedError, type);
  }
});
