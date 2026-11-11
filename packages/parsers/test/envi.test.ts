import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BodyContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  ToXMLContentHandler,
} from "@spikedpunch/ripstream-core";
import { EnviHeaderParser } from "../src/envi.ts";

/*
 * Tika's EnviHeaderParser (tika-parser-scientific-module) and EnviHeaderParserTest. The expected values below are the ones that
 * test asserts, for the two ENVI headers it reads (copied to fixtures/scientific/); the rest is the Java source read line by
 * line. Read from Tika source, not run against a Tika.
 */

const fixture = (name: string): Uint8Array => readFileSync(fileURLToPath(new URL(`./fixtures/scientific/${name}`, import.meta.url)));
const encoder = new TextEncoder();

async function parseXml(
  bytes: Uint8Array | string,
  parser: EnviHeaderParser = new EnviHeaderParser(),
): Promise<{ xml: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(typeof bytes === "string" ? encoder.encode(bytes) : bytes);
  const handler = new ToXMLContentHandler();
  const metadata = new Metadata();
  try {
    await parser.parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { xml: handler.toString(), metadata };
}


test("the parser claims application/envi.hdr", () => {
  assert.deepEqual([...new EnviHeaderParser().getSupportedTypes()].map(String), ["application/envi.hdr"]);
});

test("EnviHeaderParserTest.testParseGlobalMetadata: envi_test_header.hdr", async () => {
  const { xml, metadata } = await parseXml(fixture("envi_test_header.hdr"));
  assert.ok(xml.includes("<body><p>ENVI</p>"), xml.slice(0, 600));
  assert.ok(xml.includes("<p>samples = 2400</p>"));
  assert.ok(xml.includes("<p>lines   = 2400</p>"));
  assert.ok(
    xml.includes(
      "<p>map info = {Sinusoidal, 1.5000, 1.5000, -10007091.3643, 5559289.2856, 4.6331271653e+02, 4.6331271653e+02, , units=Meters}</p>",
    ),
  );
  assert.ok(xml.includes('content="application/envi.hdr"'));
  assert.ok(xml.includes("projection info = {16, 6371007.2, 0.000000, 0.0, 0.0, Sinusoidal, units=Meters}"));
  // The key is the name before the first "=", trimmed, with every space turned into a dot.
  assert.equal(metadata.get("envi:samples"), "2400");
  assert.equal(metadata.get("envi:lines"), "2400");
  assert.equal(metadata.get("envi:header.offset"), "0");
  assert.equal(metadata.get("Content-Type"), "application/envi.hdr");
  // Not UTM: no latitude and longitude.
  assert.equal(metadata.get("envi:lat/lon"), null);
});

test("EnviHeaderParserTest.testParseGlobalMetadataMultiLineMetadataValues: the ang header, with a UTM map info", async () => {
  const expected = new TextDecoder("utf-8").decode(fixture("EnviHeaderGroundTruth.txt")).trim();
  const { xml, metadata } = await parseXml(fixture("ang20150420t182050_corr_v1e_img.hdr"));
  assert.ok(xml.includes("<body><p>ENVI</p>"));
  assert.ok(
    xml.includes(
      "<p>description = {  Georeferenced Image built from input GLT. [Wed Jun 10 04:37:54 2015] [Wed  Jun 10 04:48:52 2015]}</p>",
    ),
  );
  assert.ok(xml.includes("<p>samples = 739</p>"));
  assert.ok(xml.includes("<p>lat/lon = { 36.79077627261556, -108.48370867914815 }</p>"));
  assert.ok(
    xml.includes(
      "<p>map info = { UTM , 1.000 , 1.000 , 724522.127 , 4074620.759 , 1.1000000000e+00 , 1.1000000000e+00 , 12 , North , WGS-84 , units=Meters , rotation=75.00000000 }</p>",
    ),
  );
  assert.ok(xml.includes(expected), "the correction factors line of EnviHeaderGroundTruth.txt");
  assert.equal(metadata.get("envi:lat/lon"), "36.79077627261556, -108.48370867914815");
  assert.equal(
    metadata.get("envi:map.info"),
    "{ UTM , 1.000 , 1.000 , 724522.127 , 4074620.759 , 1.1000000000e+00 , 1.1000000000e+00 , 12 , North , WGS-84 , units=Meters , rotation=75.00000000 }",
  );
});

test("EnviHeaderParserTest.testMultiLineFieldsDoNotLeakAcrossParses", async () => {
  const parser = new EnviHeaderParser();
  await parseXml(fixture("envi_test_header.hdr"), parser);
  const second = await parseXml(fixture("ang20150420t182050_corr_v1e_img.hdr"), parser);
  assert.ok(!second.xml.includes("GEO-TIFF File Imported into ENVI"));
  assert.equal(
    second.metadata.get("envi:description"),
    "{  Georeferenced Image built from input GLT. [Wed Jun 10 04:37:54 2015] [Wed  Jun 10 04:48:52 2015]}",
  );
});

test("EnviHeaderParserTest.testSecondMultiLineFieldStartsEmpty", async () => {
  const { xml, metadata } = await parseXml("ENVI\ndescription = {\n  first}\nband names = {\n  Band 1,\n  Band 2}\n");
  assert.ok(xml.includes("<p>band names = {  Band 1,  Band 2}</p>"));
  assert.equal(metadata.get("envi:description"), "{  first}");
  assert.equal(metadata.get("envi:band.names"), "{  Band 1,  Band 2}");
});

test("a line is written whole even when it is too long to become metadata (300 characters or more)", async () => {
  const long = `x = ${"1".repeat(296)}`;
  assert.equal(long.length, 300);
  const { xml, metadata } = await parseXml(`ENVI\n${long}\nshort = ok\n`);
  assert.ok(xml.includes(`<p>${long}</p>`));
  assert.equal(metadata.get("envi:x"), null);
  assert.equal(metadata.get("envi:short"), "ok");
  const justUnder = `y = ${"1".repeat(295)}`;
  assert.equal((await parseXml(`${justUnder}\n`)).metadata.get("envi:y"), "1".repeat(295));
});

test("a line with no '=' is text only, and a repeated name accumulates its values", async () => {
  const { xml, metadata } = await parseXml("ENVI\nbands = 3\nbands = 4\n=bare\n");
  assert.ok(xml.includes("<p>ENVI</p>"));
  assert.deepEqual([...metadata.getAll("envi:bands")], ["3", "4"]);
  // A blank name (Metadata.add(KeyPrefix, ...) skips it) leaves no metadata, but the line is still text.
  assert.equal(metadata.has("envi:"), false);
  assert.ok(xml.includes("<p>=bare</p>"));
});

test("a header that ends inside a multi-line value drops that value, as Tika does (it never flushes the list at the end)", async () => {
  const { xml, metadata } = await parseXml("ENVI\nsamples = 5\ndescription = {\n  never closed\n");
  assert.ok(xml.includes("<p>samples = 5</p>"));
  assert.ok(!xml.includes("never closed"));
  assert.equal(metadata.get("envi:description"), null);
});

test("a UTM map info with too few values, or a value that is not a number, is a malformed document (Tika's runtime exception)", async () => {
  await assert.rejects(parseXml("map info = {UTM, 1, 1, 100, 200}\n"), MalformedDocumentError);
  await assert.rejects(parseXml("map info = {UTM, 1, 1, abc, 200, 1, 1, 12, North}\n"), MalformedDocumentError);
  await assert.rejects(parseXml("map info = {UTM, 1, 1, 100, 200, 1, 1, twelve, North}\n"), MalformedDocumentError);
  // Java's split drops trailing empty strings, so a zone left empty at the end is a missing value, not a blank one.
  await assert.rejects(parseXml("map info = {UTM, 1, 1, 100, 200, 1, 1,}\n"), MalformedDocumentError);
  // A blank zone in the middle is allowed: the central meridian is 3 degrees.
  const blank = await parseXml("map info = {UTM, 1, 1, 500000, 0, 1, 1, , North}\n");
  assert.equal(blank.metadata.get("envi:lat/lon"), "0.0, 3.0");
});

test("every prefix of a valid ENVI header parses or is refused as malformed", async () => {
  const bytes = fixture("ang20150420t182050_corr_v1e_img.hdr");
  const parser = new EnviHeaderParser();
  let parsed = 0;
  // The header is 20 KB; every 7th prefix keeps the run short while still cutting inside every line, number and the UTM line.
  // A prefix that ends inside a braced value never reaches the UTM arithmetic (the value is dropped), so none here is refused.
  for (let length = 0; length <= bytes.length; length += length < 700 ? 1 : 7) {
    try {
      await parseXml(bytes.subarray(0, length), parser);
      parsed++;
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix of ${length} bytes: ${String(error)}`);
    }
  }
  assert.ok(parsed > 3000, `parsed ${parsed}`);
});

test("a header over maxHeaderBytes is a LimitExceededError, and the input is read no further than the cap", async () => {
  const parser = new EnviHeaderParser({ maxHeaderBytes: 64 });
  let pulled = 0;
  async function* endless(): AsyncGenerator<Uint8Array> {
    for (let chunks = 0; chunks < 1000; chunks++) {
      pulled += 1;
      yield encoder.encode("a = b\n".repeat(100));
    }
    throw new Error("the parser read an endless input to its end");
  }
  const stream = await RipstreamInputStream.from(endless());
  await assert.rejects(parser.parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()), LimitExceededError);
  await stream.close();
  assert.ok(pulled < 5, `pulled ${pulled} chunks`);
});

test("a hostile header of many distinct names stops at the metadata caps, not at an unbounded map", async () => {
  // 20000 distinct names: Metadata.add(KeyPrefix, ...) keeps the first 10000 and skips the rest.
  const lines = Array.from({ length: 20_000 }, (_, index) => `name${index} = v`);
  const { metadata } = await parseXml(lines.join("\n"));
  const names = metadata.names().filter((name) => name.startsWith("envi:"));
  assert.equal(names.length, 10_000);
  assert.ok(metadata.has("envi:name0") && !metadata.has("envi:name19999"));
});

test("the character set is detected and recorded as Content-Encoding", async () => {
  const latin1 = Uint8Array.from([...encoder.encode("ENVI\ndescription = {caf"), 0xe9, ...encoder.encode("}\n")]);
  const { xml, metadata } = await parseXml(latin1);
  assert.ok(xml.includes("café"), xml);
  assert.notEqual(metadata.get("Content-Encoding"), null);
});
