import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  ToXMLContentHandler,
} from "@spikedpunch/ripstream-core";
import { DEFAULT_MAX_ENVI_HEADER_BYTES, EnviHeaderParser } from "../src/envi.ts";

/*
 * Behaviour of the ENVI header parser that the fixture-driven tests in envi.test.ts do not pin: found by mutation testing (a
 * changed bound, a dropped guard or a swapped string in src/envi.ts that left envi.test.ts green). The expected values are read
 * from Tika's EnviHeaderParser.java (tika-parser-scientific-module), cited where a test turns on one of its lines.
 */

const encoder = new TextEncoder();

async function run(
  bytes: Uint8Array | string,
  metadata: Metadata = new Metadata(),
  parser: EnviHeaderParser = new EnviHeaderParser(),
): Promise<{ xml: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(typeof bytes === "string" ? encoder.encode(bytes) : bytes);
  const handler = new ToXMLContentHandler();
  try {
    await parser.parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { xml: handler.toString(), metadata };
}

/** The text of every `<p>` of the output, in order. */
const paragraphs = (xml: string): string[] => [...xml.matchAll(/<p>(.*?)<\/p>/gs)].map((match) => match[1] ?? "");

const chars = (...codes: number[]): string => String.fromCharCode(...codes);

test("the default header cap is 4 MiB: that many bytes parse, one more is a LimitExceededError", async () => {
  assert.equal(DEFAULT_MAX_ENVI_HEADER_BYTES, 4 * 1024 * 1024);
  // One long line has no metadata (300 characters or more), so this is only the read that the cap bounds.
  const atCap = "x".repeat(DEFAULT_MAX_ENVI_HEADER_BYTES);
  assert.equal(paragraphs((await run(atCap)).xml).length, 1);
  await assert.rejects(run(`${atCap}x`), LimitExceededError);
});

test("maxHeaderBytes must be a positive integer", () => {
  assert.throws(() => new EnviHeaderParser({ maxHeaderBytes: 0 }), RangeError);
  assert.throws(() => new EnviHeaderParser({ maxHeaderBytes: -5 }), RangeError);
  assert.throws(() => new EnviHeaderParser({ maxHeaderBytes: 1.5 }), RangeError);
  assert.throws(() => new EnviHeaderParser({ maxHeaderBytes: Number.NaN }), RangeError);
  assert.doesNotThrow(() => new EnviHeaderParser({ maxHeaderBytes: 1 }));
});

test("Content-Encoding is the detected character set: UTF-8 for a header with a byte-order mark", async () => {
  const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode("ENVI\nsamples = 1\n")]);
  assert.equal((await run(withBom)).metadata.get("Content-Encoding"), "UTF-8");
});

test("the character set is detected from more than the first few bytes (a header whose first non-ASCII byte comes late)", async () => {
  // Four ASCII bytes are no evidence; the multi-byte UTF-8 letters after them decide, and must come out as one letter each.
  const text = `ENVI\ndescription = {${"éèêë ".repeat(20)}}\n`;
  const { xml } = await run(encoder.encode(text));
  assert.ok(xml.includes("éèêë"), xml.slice(0, 200));
  assert.ok(!xml.includes("Ã"), "decoded as a single-byte set");
});

test("a line ends at CRLF, CR or LF (BufferedReader.readLine), and the end of the text does not start another line", async () => {
  assert.deepEqual(paragraphs((await run("a = 1\r\nb = 2\r\n")).xml), ["a = 1", "b = 2"]);
  assert.deepEqual(paragraphs((await run("a = 1\rb = 2\rc = 3")).xml), ["a = 1", "b = 2", "c = 3"]);
  assert.deepEqual(paragraphs((await run("a = 1\nb = 2\n")).xml), ["a = 1", "b = 2"]);
  // A blank line in the middle is a line: an empty paragraph.
  assert.deepEqual(paragraphs((await run("a = 1\n\nb = 2")).xml), ["a = 1", "", "b = 2"]);
  const cr = await run("a = 1\rb = 2\r");
  assert.equal(cr.metadata.get("envi:a"), "1");
  assert.equal(cr.metadata.get("envi:b"), "2");
});

test("every space of a name becomes a dot, not only the first", async () => {
  const { metadata } = await run("a b c = 1\npadded name  = 2\n");
  assert.equal(metadata.get("envi:a.b.c"), "1");
  // The name is trimmed first, so the spaces before '=' do not become dots.
  assert.equal(metadata.get("envi:padded.name"), "2");
});

test("a line with { and } at its ends is a whole line that leaves an open multi-line value open (Tika's first condition)", async () => {
  // EnviHeaderParser.readLines: `line.contains("{") && !line.endsWith("}") || line.startsWith(" ")`. `x = {a}` fails the
  // first test, so it is written alone and the list the `d = {` line began is still waiting for its closing brace.
  const { xml, metadata } = await run("d = {\nx = {a}\n  tail}\n");
  assert.equal(metadata.get("envi:x"), "{a}");
  assert.equal(metadata.get("envi:d"), "{  tail}");
  assert.deepEqual(paragraphs(xml), ["x = {a}", "d = {  tail}"]);
});

test("a multi-line value is closed by a line that ends in }, and only by that character", async () => {
  const { metadata } = await run("d = {\n  a]\n  b}\n");
  assert.equal(metadata.get("envi:d"), "{  a]  b}");
});

test("a multi-line value joins its lines with nothing between them", async () => {
  const { metadata } = await run("d = {a,\n b,\n c}\n");
  assert.equal(metadata.get("envi:d"), "{a, b, c}");
});

test("a line that starts with a space is held as a continuation and is lost unless a later line ends the value with }", async () => {
  const lost = await run("a = 1\n b = 2\nc = 3\n");
  assert.deepEqual(paragraphs(lost.xml), ["a = 1", "c = 3"]);
  assert.equal(lost.metadata.get("envi:b"), null);
  const closed = await run("a = 1\n b = 2\n c = {3}\n");
  assert.deepEqual(paragraphs(closed.xml), ["a = 1", " b = 2 c = {3}"]);
  assert.equal(closed.metadata.get("envi:b"), "2 c = {3}");
});

test("a value is everything after the first '=', trimmed, and a name is everything before it", async () => {
  const { metadata } = await run("a = b = c\nk =\t v \t\nz=\n");
  assert.equal(metadata.get("envi:a"), "b = c");
  assert.equal(metadata.get("envi:k"), "v");
  assert.equal(metadata.get("envi:z"), "");
});

test("map info: not UTM is only the map.info key, with no latitude and longitude, and a lower-case utm is not UTM", async () => {
  const lower = await run("map info = {utm, 1, 1, 500000, 0, 1, 1, 12, North}\n");
  assert.equal(lower.metadata.get("envi:lat/lon"), null);
  assert.equal(lower.metadata.get("envi:map.info"), "{utm, 1, 1, 500000, 0, 1, 1, 12, North}");
  const empty = await run("map info = \n");
  assert.equal(empty.metadata.get("envi:map.info"), "");
  assert.equal(empty.metadata.get("envi:lat/lon"), null);
  const braces = await run("map info = {}\n");
  assert.equal(braces.metadata.get("envi:map.info"), "{}");
});

test("map info splits the value Tika passes it, not the trimmed one: a tab before the braces is part of the first field", async () => {
  // parseMapInfoContents(keyValue[1]) takes the raw text after '=', which drops only '{', '}' and ' ' (Tika, lines 133-142).
  const { metadata } = await run("map info =\t{UTM, 1, 1, 500000, 0, 1, 1, 12, North}\n");
  assert.equal(metadata.get("envi:map.info"), "{UTM, 1, 1, 500000, 0, 1, 1, 12, North}");
  assert.equal(metadata.get("envi:lat/lon"), null);
});

test("map info with no fields at all is a malformed document: Tika reads values[0] of an empty array", async () => {
  await assert.rejects(run("map info = ,,,\n"), MalformedDocumentError);
  await assert.rejects(run("map info = { , }\n"), MalformedDocumentError);
});

test("a UTM map info short of the map point is a malformed document, not a crash of another kind", async () => {
  await assert.rejects(run("map info = {UTM}\n"), MalformedDocumentError);
  await assert.rejects(run("map info = {UTM, 1, 1}\n"), MalformedDocumentError);
  await assert.rejects(run("map info = {UTM, 1, 1, 100}\n"), MalformedDocumentError);
});

test("map info is added to the metadata before its arithmetic runs, so a bad zone leaves it there (Tika adds, then converts)", async () => {
  const metadata = new Metadata();
  await assert.rejects(run("map info = {UTM, 1, 1, 100, 200, 1, 1, twelve}\n", metadata), MalformedDocumentError);
  assert.equal(metadata.get("envi:map.info"), "{UTM, 1, 1, 100, 200, 1, 1, twelve}");
  assert.equal(metadata.get("envi:lat/lon"), null);
});

test("the zone is value 8: a zone with a tab in front is trimmed (Integer.parseInt(value.trim())), and gives that central meridian", async () => {
  // On the central meridian (easting 500000) at the equator (northing 0) the longitude is the zone's central meridian itself.
  const tab = await run("map info = {UTM, 1, 1, 500000, 0, 1, 1,\t12, North}\n");
  assert.equal(tab.metadata.get("envi:lat/lon"), "0.0, -111.0");
  const plain = await run("map info = {UTM, 1, 1, 500000, 0, 1, 1, 30, North}\n");
  assert.equal(plain.metadata.get("envi:lat/lon"), "0.0, -3.0");
  const blank = await run("map info = {UTM, 1, 1, 500000, 0, 1, 1, , North}\n");
  assert.equal(blank.metadata.get("envi:lat/lon"), "0.0, 3.0");
});

test("a zone of control characters that are not whitespace is not blank, and is not an integer (isBlank, then parseInt of the trim)", async () => {
  // U+0001 is below U+0020, so trim() empties it, but Character.isWhitespace is false for it: Tika throws NumberFormatException.
  await assert.rejects(run(`map info = {UTM, 1, 1, 500000, 0, 1, 1,${chars(1)}, North}\n`), MalformedDocumentError);
  // U+000B (vertical tab) is whitespace: a blank zone, zone 0.
  const blank = await run(`map info = {UTM, 1, 1, 500000, 0, 1, 1,${chars(0x0b)}, North}\n`);
  assert.equal(blank.metadata.get("envi:lat/lon"), "0.0, 3.0");
});

test("the zone is an int: out of range or with a fraction is malformed, a leading + or - is read", async () => {
  await assert.rejects(run("map info = {UTM, 1, 1, 500000, 0, 1, 1, 2147483648, North}\n"), MalformedDocumentError);
  await assert.rejects(run("map info = {UTM, 1, 1, 500000, 0, 1, 1, 12.5, North}\n"), MalformedDocumentError);
  assert.equal((await run("map info = {UTM, 1, 1, 500000, 0, 1, 1, +30, North}\n")).metadata.get("envi:lat/lon"), "0.0, -3.0");
  // A negative zone is not > 0: the central meridian is 3 degrees.
  assert.equal((await run("map info = {UTM, 1, 1, 500000, 0, 1, 1, -5, North}\n")).metadata.get("envi:lat/lon"), "0.0, 3.0");
  // Zone -0 is zone 0.
  assert.equal((await run("map info = {UTM, 1, 1, 500000, 0, 1, 1, -0, North}\n")).metadata.get("envi:lat/lon"), "0.0, 3.0");
});

test("the map point is values 4 and 5 (easting, northing): a point east of the meridian is east of it, and one north of the equator is north of it", async () => {
  // 100 km east of the central meridian at the equator: about 0.9 degrees east of it; 100 km north: about 0.9 degrees north.
  const east = await run("map info = {UTM, 1, 1, 600000, 0, 1, 1, 30, North}\n");
  const [eastLat, eastLon] = (east.metadata.get("envi:lat/lon") ?? "").split(", ").map(Number) as [number, number];
  assert.ok(Math.abs(eastLat) < 1e-9, String(eastLat));
  assert.ok(eastLon > -3 && eastLon < -2, String(eastLon));
  // Tika's longitude is cm - a3 with a1 = 500000 - easting, so an easting above 500000 gives a longitude above the meridian's.
  const north = await run("map info = {UTM, 1, 1, 500000, 100000, 1, 1, 30, North}\n");
  const [northLat, northLon] = (north.metadata.get("envi:lat/lon") ?? "").split(", ").map(Number) as [number, number];
  assert.ok(northLat > 0.8 && northLat < 1, String(northLat));
  assert.equal(northLon, -3);
});

test("the UTM arithmetic for a point off both axes, and the lat/lon paragraph comes before the map info line", async () => {
  // Easting 400000, northing 4500000, zone 33. The digits are this port's own evaluation of Tika's constants and order of
  // operations (not run against a Java VM, whose Math.pow may differ in the last digit); the ang fixture in envi.test.ts is
  // Tika's own ground truth for a second point. This one guards the terms that the fixture's point leaves nearly flat.
  const { xml, metadata } = await run("map info = {UTM, 1, 1, 400000, 4500000, 1, 1, 33, North}\n");
  assert.equal(metadata.get("envi:lat/lon"), "40.64479786869578, 13.817300377345509");
  assert.deepEqual(paragraphs(xml), [
    "lat/lon = { 40.64479786869578, 13.817300377345509 }",
    "map info = {UTM, 1, 1, 400000, 4500000, 1, 1, 33, North}",
  ]);
});
