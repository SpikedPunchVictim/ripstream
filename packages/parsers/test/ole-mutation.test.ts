import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MalformedDocumentError,
  Metadata,
  ParseContext,
  ParserDeclinedError,
  RipstreamInputStream,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { Dgn8Parser } from "../src/dgn8.ts";
import { declineUnlessVersion } from "../src/exact-version.ts";
import { OleFile } from "../src/ole-stream.ts";
import {
  buildOle,
  buildPropertySet,
  DOCUMENT_SUMMARY_INFORMATION_FMTID,
  SUMMARY_INFORMATION_FMTID,
} from "./ole-builder.ts";

/*
 * Mutation tests for the DGN8 parser, the compound file reader it and the Quattro Pro parser share (ole-stream.ts) and the
 * version check they share (exact-version.ts), for what dgn8.test.ts and quattro-pro.test.ts leave open (tikajs-68os.21). The
 * parsers are constructed directly, so nothing here loads another parser's registration.
 */

const SUMMARY_NAME = "\u0005SummaryInformation";
const DOCUMENT_SUMMARY_NAME = "\u0005DocumentSummaryInformation";
const summary = (values: Record<number, string | number>): Uint8Array => buildPropertySet(SUMMARY_INFORMATION_FMTID, values);
const documentSummary = (values: Record<number, string | number>): Uint8Array =>
  buildPropertySet(DOCUMENT_SUMMARY_INFORMATION_FMTID, values);

async function parseDgn(bytes: Uint8Array, type?: string): Promise<{ metadata: Metadata; xml: string }> {
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  if (type !== undefined) metadata.set("Content-Type", type);
  const handler = createOutputHandler("xml");
  try {
    await new Dgn8Parser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { metadata, xml: handler.toString() };
}

const SMALL = buildOle([{ name: SUMMARY_NAME, data: summary({ 8: "Ada" }) }]);

// ---- the DGN8 parser ----

test("the parser names itself and the type it reads", () => {
  const parser = new Dgn8Parser();
  assert.equal(parser.name, "DGN8Parser");
  assert.deepEqual([...parser.getSupportedTypes()].map(String), ["image/vnd.dgn; version=8"]);
});

test("the document is an html page whose metadata is the summaries", async () => {
  const { xml, metadata } = await parseDgn(SMALL, "image/vnd.dgn; version=8");
  assert.ok(xml.startsWith("<html>"), xml);
  assert.ok(xml.endsWith("</html>"), xml);
  assert.ok(xml.includes('<meta name="meta:last-author" content="Ada"></meta>'), xml);
  assert.equal(metadata.get("meta:last-author"), "Ada");
});

test("version 8 is accepted under either parameter name, whichever comes first", async () => {
  for (const type of ["image/vnd.dgn; version=8", "image/vnd.dgn; ver=8", "image/vnd.dgn; version=7; ver=8", "image/vnd.dgn; ver=7; version=8"]) {
    assert.equal((await parseDgn(SMALL, type)).metadata.get("meta:last-author"), "Ada", type);
  }
});

test("another version, another type with the version, and a type that is not one are declined with the reason", async () => {
  const declined = async (type: string): Promise<string> => {
    try {
      await parseDgn(SMALL, type);
    } catch (error) {
      assert.ok(error instanceof ParserDeclinedError, `${type}: ${String(error)}`);
      return error.message;
    }
    return "accepted";
  };
  assert.equal(await declined("image/vnd.dgn; version=7"), "image/vnd.dgn; version=7 is not image/vnd.dgn version 8");
  assert.equal(await declined("image/vnd.dgn"), "image/vnd.dgn is not image/vnd.dgn version 8");
  assert.equal(await declined("image/vnd.dgn; version=88"), "image/vnd.dgn; version=88 is not image/vnd.dgn version 8");
  assert.equal(await declined("image/vnd.dgn; ver=7; version=9"), "image/vnd.dgn; ver=7; version=9 is not image/vnd.dgn version 8");
  assert.equal(await declined("application/octet-stream; version=8"), "application/octet-stream; version=8 is not image/vnd.dgn version 8");
  assert.equal(await declined("image/vnd.dgn-x; ver=8"), "image/vnd.dgn-x; ver=8 is not image/vnd.dgn version 8");
  assert.equal(await declined("not a media type"), "not a media type is not image/vnd.dgn version 8");
});

test("a version check lists the versions it accepts, and takes the first parameter that names one", () => {
  const check = (type: string): void => {
    const metadata = new Metadata();
    metadata.set("Content-Type", type);
    declineUnlessVersion(metadata, "x/y", ["a", "b"], ["1", "2"]);
  };
  assert.throws(() => check("x/y; a=3"), { message: "x/y; a=3 is not x/y version 1 or 2" });
  assert.doesNotThrow(() => check("x/y; a=1"));
  assert.doesNotThrow(() => check("x/y; a=2"));
  assert.doesNotThrow(() => check("x/y; b=2"));
  assert.doesNotThrow(() => check("x/y; a=3; b=1"));
  assert.throws(() => check("x/y; c=1"), ParserDeclinedError);
  // No Content-Type: nothing chose the parser by type, so it goes ahead.
  assert.doesNotThrow(() => declineUnlessVersion(new Metadata(), "x/y", ["a"], ["1"]));
});

// ---- the compound file reader ----

test("bytes without the signature are not a compound file", () => {
  assert.throws(() => OleFile.open(new TextEncoder().encode("this is not an OLE2 file")), { message: "Not a compound file" });
});

test("a file with the signature that is cut short says how, as the compound file reader does", () => {
  assert.throws(
    () => OleFile.open(SMALL.subarray(0, 100)),
    (error: unknown) => error instanceof MalformedDocumentError && error.message === "Truncated compound file header" && error.cause === undefined,
  );
});

test("a failure that is not the document's own is wrapped as malformed, with the failure as its cause", () => {
  class Unreadable extends Uint8Array {
    override subarray(): never {
      throw new RangeError("unreadable");
    }
    override slice(): never {
      throw new RangeError("unreadable");
    }
  }
  const data = new Unreadable(SMALL.buffer, SMALL.byteOffset, SMALL.length);
  assert.throws(
    () => OleFile.open(data),
    (error: unknown) =>
      error instanceof MalformedDocumentError &&
      error.message === "Invalid compound file" &&
      error.cause instanceof RangeError &&
      error.cause.message === "unreadable",
  );
});

test("only a stream counts as a stream: a storage is neither there nor readable", () => {
  const file = OleFile.open(buildOle([{ name: "Dir", data: new Uint8Array(0), storage: true }, { name: "Data", data: Uint8Array.of(1, 2, 3) }]));
  assert.equal(file.has("Data"), true);
  assert.equal(file.has("Dir"), false);
  assert.equal(file.has("Missing"), false);
  assert.deepEqual(file.read("Data")?.subarray(0, 3), Uint8Array.of(1, 2, 3));
  assert.equal(file.read("Dir"), undefined);
  assert.equal(file.read("Missing"), undefined);
});

test("a stream may declare up to the length of the file, and not more", () => {
  const stream = { name: "Data", data: new Uint8Array(600).fill(7) };
  const length = buildOle([stream]).length;
  const declaring = (size: number): OleFile => OleFile.open(buildOle([stream], { declaredSize: { Data: size } }));
  assert.equal(declaring(600).read("Data")?.length, 600);
  // At the length of the file the declared size passes the bound; what is read is up to the sectors of the stream.
  assert.doesNotThrow(() => {
    try {
      declaring(length).read("Data");
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError);
      assert.ok(!/declares/.test(error.message), error.message);
    }
  });
  assert.throws(() => declaring(length + 1).read("Data"), { message: `Compound file stream "Data" declares ${length + 1} bytes` });
});

// ---- the summaries ----

test("the document summary alone gives its properties, and a missing first stream does not end the search", () => {
  const metadata = new Metadata();
  OleFile.open(buildOle([{ name: DOCUMENT_SUMMARY_NAME, data: documentSummary({ 15: "ACME" }) }])).applySummaries(metadata);
  assert.equal(metadata.get("extended-properties:Company"), "ACME");
});

test("both summaries are read, the second over the first where they name the same property", () => {
  const metadata = new Metadata();
  const file = OleFile.open(
    buildOle([
      { name: DOCUMENT_SUMMARY_NAME, data: summary({ 8: "from the document summary", 4: "Creator" }) },
      { name: SUMMARY_NAME, data: summary({ 8: "from the summary" }) },
    ]),
  );
  file.applySummaries(metadata);
  assert.equal(metadata.get("dc:creator"), "Creator");
  assert.equal(metadata.get("meta:last-author"), "from the document summary");
});

test("a summary that is not a property set is skipped, and the other is still read", () => {
  const metadata = new Metadata();
  const file = OleFile.open(
    buildOle([
      { name: SUMMARY_NAME, data: new Uint8Array(10) },
      { name: DOCUMENT_SUMMARY_NAME, data: documentSummary({ 15: "ACME" }) },
    ]),
  );
  file.applySummaries(metadata);
  assert.equal(metadata.get("extended-properties:Company"), "ACME");
});

test("a failure that is not the document's own is not swallowed with the summaries that are not property sets", () => {
  class Refusing extends Metadata {
    override set(): void {
      throw new Error("the metadata refuses");
    }
    override add(): void {
      throw new Error("the metadata refuses");
    }
  }
  const file = OleFile.open(buildOle([{ name: SUMMARY_NAME, data: summary({ 8: "Ada" }) }]));
  assert.throws(() => file.applySummaries(new Refusing()), { message: "the metadata refuses" });
});
