import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError, MalformedDocumentError, Metadata, ParseContext, RipstreamInputStream, ToXMLContentHandler } from "@spikedpunch/ripstream-core";
import { DEFAULT_MAX_ISATAB_BYTES, DEFAULT_MAX_ISATAB_COLUMNS, ISArchiveParser } from "../src/isatab.ts";

/*
 * Behaviour of the ISA-Tab study parser that isatab.test.ts leaves open, found by mutation testing of src/isatab.ts (a changed
 * default, a dropped guard or a swapped string that left isatab.test.ts green). The expected values follow Tika's
 * ISArchiveParser.parseStudy and ISATabUtils.parseStudy (tika-parser-scientific-module) and commons-csv's TDF format.
 */

const encoder = new TextEncoder();

async function run(
  bytes: Uint8Array | string,
  metadata: Metadata = new Metadata(),
  parser: ISArchiveParser = new ISArchiveParser(),
): Promise<string> {
  const stream = await RipstreamInputStream.from(typeof bytes === "string" ? encoder.encode(bytes) : bytes);
  const handler = new ToXMLContentHandler();
  try {
    await parser.parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return handler.toString();
}

const cells = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<${tag}>(.*?)</${tag}>`, "gs"))].map((match) => match[1] ?? "");

test("the default limits are 32 MiB and 100000 cells per row", () => {
  assert.equal(DEFAULT_MAX_ISATAB_BYTES, 32 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_ISATAB_COLUMNS, 100_000);
});

test("a row of exactly the default number of cells is read and one more is a LimitExceededError", async () => {
  const atLimit = await run("a\t".repeat(99_999) + "a\n");
  assert.equal(cells(atLimit, "th").length, 100_000);
  await assert.rejects(run("a\t".repeat(100_000) + "a\n"), LimitExceededError);
});

test("the limit counts the cell a row ends with: a trailing delimiter makes one more", async () => {
  const parser = new ISArchiveParser({ maxColumns: 3 });
  assert.equal(cells(await run("a\tb\tc\n", new Metadata(), parser), "th").length, 3);
  await assert.rejects(run("a\tb\tc\t\n", new Metadata(), parser), LimitExceededError);
  await assert.rejects(run("a\tb\tc\t", new Metadata(), parser), LimitExceededError);
  // The cap holds for a later row too, not only the heading.
  await assert.rejects(run("a\n1\t2\t3\t4\n", new Metadata(), parser), LimitExceededError);
});

test("the study heading carries the study identifier that the metadata already holds, as Tika's parseStudy reads it back", async () => {
  const metadata = new Metadata();
  metadata.set("isatab:Study Identifier", "BII-S-1");
  assert.ok((await run("a\n", metadata)).includes("<h2>STUDY BII-S-1</h2>"));
  // The key is spelt with a capital S in Study and a capital I in Identifier.
  const other = new Metadata();
  other.set("isatab:study identifier", "x");
  assert.ok((await run("a\n", other)).includes("<h2>STUDY null</h2>"));
});

test("the character set is detected from more than the first bytes of the study file", async () => {
  // The first bytes are ASCII; the multi-byte UTF-8 letters that follow decide the set, and each must be one letter.
  const xml = await run(encoder.encode('"Source Name"\n"éèêë éèêë éèêë"\n'));
  assert.deepEqual(cells(xml, "td"), ["éèêë éèêë éèêë"]);
});

test("a bare CR is a line break and empty lines made of CRs are skipped like the ones made of LFs", async () => {
  const xml = await run("a\r\r\rb\r\r");
  assert.deepEqual(cells(xml, "th"), ["a"]);
  assert.deepEqual(cells(xml, "td"), ["b"]);
  const mixed = await run("a\r\n\r\n\rb\n\r\nc");
  assert.deepEqual(cells(mixed, "th"), ["a"]);
  assert.deepEqual(cells(mixed, "td"), ["b", "c"]);
});

test("the table is thead then tbody with one tr per record, a th per heading cell and a td per body cell", async () => {
  const xml = await run("h1\th2\na\tb\nc\td\n");
  assert.match(xml, /<thead>\s*<th>h1<\/th>\s*<th>h2<\/th><\/thead>/);
  assert.match(xml, /<tbody><tr>\s*<td>a<\/td>\s*<td>b<\/td><\/tr>\s*<tr>\s*<td>c<\/td>\s*<td>d<\/td><\/tr>\s*<\/tbody>/);
  // A table with no records is an empty head and an empty body.
  assert.match(await run(""), /<table><thead><\/thead><tbody><\/tbody><\/table>/);
});

test("a heading with only a single record has an empty body, and a study of one row is not repeated in the body", async () => {
  const xml = await run("only\n");
  assert.deepEqual(cells(xml, "th"), ["only"]);
  assert.deepEqual(cells(xml, "td"), []);
});

test("a quoted cell that ends the input, with or without a line break after its closing quote, is a cell", async () => {
  assert.deepEqual(cells(await run('a\n"b"'), "td"), ["b"]);
  assert.deepEqual(cells(await run('a\n"b"\n'), "td"), ["b"]);
  assert.deepEqual(cells(await run('a\n"b"  '), "td"), ["b"]);
  assert.deepEqual(cells(await run('a\t"b"\t"c"'), "th"), ["a", "b", "c"]);
  assert.deepEqual(cells(await run('a\n"b"\t'), "td"), ["b", ""]);
});

test("a whitespace-only unquoted cell is empty and an inner space is kept", async () => {
  assert.deepEqual(cells(await run("a\tb\n \t   \t x y \n"), "td"), ["", "", "x y"]);
});

test("a LimitExceededError is raised for a study over maxBytes, at the cap exactly accepted", async () => {
  const parser = new ISArchiveParser({ maxBytes: 8 });
  assert.deepEqual(cells(await run("a\tb\tc\n1\n", new Metadata(), parser), "th"), ["a", "b", "c"]);
  await assert.rejects(run("a\tb\tc\n1\n2", new Metadata(), parser), LimitExceededError);
});

/** The `(line N)` an error message ends with. */
async function errorLine(text: string): Promise<number> {
  try {
    await run(text);
  } catch (error) {
    assert.ok(error instanceof MalformedDocumentError, String(error));
    const match = /\(line (\d+)\)$/.exec(error.message);
    assert.ok(match !== null, error.message);
    return Number(match[1]);
  }
  throw new Error("the study was read");
}

test("a malformed table names the line it stopped at, counting LF, CR and CRLF as one break each", async () => {
  assert.equal(await errorLine('"abc'), 1);
  assert.equal(await errorLine('a\nb\n"c'), 3);
  assert.equal(await errorLine('a\r\nb\r\n"c'), 3);
  assert.equal(await errorLine('a\rb\r"c'), 3);
  assert.equal(await errorLine('a\r\rb\n\r\n"c'), 5);
  // Text after a closing quote: the position is just past the offending character, whatever follows it.
  assert.equal(await errorLine('a\n"b"x\nc'), 2);
  assert.equal(await errorLine('"b"x\r\nc'), 1);
});
