import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  MediaType,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  UnsupportedFormatError,
} from "@spikedpunch/ripstream-core";
import { createDefaultParser } from "../src/index.ts";
import { buildOle, buildPropertySet, SUMMARY_INFORMATION_FMTID } from "./ole-builder.ts";

/* DGN8Parser as the default parser list sees it (tikajs-68os.21); split from dgn8.test.ts, see tsd-facade.test.ts. */

const DGN8 = "image/vnd.dgn; version=8";
const SUMMARY = buildPropertySet(SUMMARY_INFORMATION_FMTID, { 8: "Ada Lovelace", 18: "MicroStation v8" });
const SMALL_DGN8 = buildOle([{ name: "\u0005SummaryInformation", data: SUMMARY }]);

async function parseAs(bytes: Uint8Array, type: string): Promise<Metadata> {
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  metadata.set("Content-Type", type);
  try {
    await createDefaultParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata;
}

test("DGN8Parser is the exact match for image/vnd.dgn; version=8", async () => {
  const matches = await createDefaultParser().selectParsers(MediaType.parseOrThrow(DGN8), new ParseContext());
  assert.deepEqual(
    matches.slice(0, 1).map((match) => ({ name: match.parser.name, kind: match.kind })),
    [{ name: "DGN8Parser", kind: "exact" }],
  );
});

test("a small compound file is parsed by DGN8Parser under the exact type", async () => {
  const metadata = await parseAs(SMALL_DGN8, DGN8);
  assert.equal(metadata.get("tk:parsed-by"), "DGN8Parser");
});

test("DGN7 and an unversioned image/vnd.dgn are not claimed by the version 8 parser", async () => {
  // The core selection keys a parameterized claim by its base type, so both would otherwise reach DGN8Parser, which
  // reads only the OLE2 form (Tika keys by the full type and never offers a version 7 file to it).
  for (const type of ["image/vnd.dgn; version=7", "image/vnd.dgn"]) {
    await assert.rejects(parseAs(SMALL_DGN8, type), UnsupportedFormatError, type);
  }
});
