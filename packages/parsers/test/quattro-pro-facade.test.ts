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
import { buildOle } from "./ole-builder.ts";

/* QuattroProParser as the default parser list sees it (tikajs-68os.21); split from quattro-pro.test.ts, see tsd-facade.test.ts. */

const QP9 = "application/x-quattro-pro; version=9";

const short = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const bof = (): number[] => [...short(1), ...short(14), ...[..."QPW9"].map((c) => c.charCodeAt(0)), ...short(7), ...short(8), ...short(0xffff), ...short(3), ...short(4)];
const notebook = (): Uint8Array => buildOle([{ name: "NativeContent_MAIN", data: Uint8Array.from(bof()) }]);

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

test("QuattroProParser is the exact match for application/x-quattro-pro; version=9", async () => {
  const matches = await createDefaultParser().selectParsers(MediaType.parseOrThrow(QP9), new ParseContext());
  assert.deepEqual(
    matches.slice(0, 1).map((match) => ({ name: match.parser.name, kind: match.kind })),
    [{ name: "QuattroProParser", kind: "exact" }],
  );
});

test("a notebook under version 9 is parsed by QuattroProParser", async () => {
  assert.equal((await parseAs(notebook(), QP9)).get("tk:parsed-by"), "QuattroProParser");
});

test("the other Quattro Pro versions are not claimed by the version 9 parser", async () => {
  // The core selection keys a parameterized claim by its base type, so version 7-8 and a bare type would reach this
  // parser; Tika keys by the full type and sends them elsewhere (testQUATTRO.wb3 goes to EmptyParser). What else takes
  // them is not this parser's concern (the generic OLE parser, a supertype of the type, parses a compound file), so the
  // test is that this one did not: they are refused, or parsed by another.
  for (const type of ["application/x-quattro-pro; version=7-8", "application/x-quattro-pro"]) {
    try {
      const metadata = await parseAs(notebook(), type);
      assert.ok(!metadata.getAll("tk:parsed-by").includes("QuattroProParser"), type);
    } catch (error) {
      assert.ok(error instanceof UnsupportedFormatError, `${type}: ${String(error)}`);
    }
  }
});
