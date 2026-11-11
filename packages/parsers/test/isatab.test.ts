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
import { ISArchiveParser } from "../src/isatab.ts";

/*
 * Tika's ISArchiveParser (tika-parser-scientific-module): the study file of an ISA-Tab archive. The parser also reads the
 * investigation and assay files that sit beside the study file; a single stream has no neighbours, so what is ported and tested
 * here is what Tika writes for a study file alone: `<h2>STUDY null</h2>` and the study table, read as commons-csv's TDF format.
 * Read from Tika source, not run against a Tika; commons-csv's source is not in the Tika tree, so the TDF rules below are the
 * documented behaviour of CSVFormat.TDF (tab delimiter, double quote, surrounding spaces ignored, empty lines skipped).
 */

const fixture = (name: string): Uint8Array => readFileSync(fileURLToPath(new URL(`./fixtures/scientific/${name}`, import.meta.url)));
const encoder = new TextEncoder();

async function parseXml(
  bytes: Uint8Array | string,
  parser: ISArchiveParser = new ISArchiveParser(),
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

const unescapeXml = (text: string): string =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

/** The cells of `<thead>` and of each `<tr>` of `<tbody>`, as the parser wrote them. */
function tableOf(xml: string): { head: string[]; rows: string[][] } {
  const cells = (part: string, tag: string): string[] =>
    [...part.matchAll(new RegExp(`<${tag}(?:/>|>(.*?)</${tag}>)`, "gs"))].map((match) => unescapeXml(match[1] ?? ""));
  const head = /<thead>(.*?)<\/thead>/s.exec(xml)?.[1] ?? "";
  const body = /<tbody>(.*?)<\/tbody>/s.exec(xml)?.[1] ?? "";
  return {
    head: cells(head, "th"),
    rows: [...body.matchAll(/<tr>(.*?)<\/tr>/gs)].map((row) => cells(row[1] ?? "", "td")),
  };
}

const tableFor = async (text: string): Promise<{ head: string[]; rows: string[][] }> => tableOf((await parseXml(text)).xml);


test("the parser claims application/x-isatab", () => {
  assert.deepEqual([...new ISArchiveParser().getSupportedTypes()].map(String), ["application/x-isatab"]);
});

test("ISArchiveParserTest's study file alone (s_BII-S-1.txt): the study heading has no identifier, and the table is the file", async () => {
  const { xml, metadata } = await parseXml(fixture("s_BII-S-1.txt"));
  // No investigation file beside the stream, so isatab:Study Identifier is unset and Java's string concatenation writes "null".
  assert.ok(xml.includes("<h2>STUDY null</h2>"), xml.slice(0, 400));
  const { head, rows } = tableOf(xml);
  assert.equal(head.length, 19);
  assert.deepEqual(head.slice(0, 3), ["Source Name", "Characteristics[organism]", "Term Source REF"]);
  assert.equal(rows.length, 164);
  assert.ok(rows.every((row) => row.length === 19));
  assert.equal(rows[0]?.[0], "culture1");
  assert.equal(rows[0]?.[1], "Saccharomyces cerevisiae (Baker's yeast)");
  assert.equal(rows[0]?.[11], "C-0.07-aliquot1");
  assert.equal(rows[0]?.[18], "");
  // Without the investigation file nothing is written under isatab:.
  assert.deepEqual(metadata.names().filter((name) => name.startsWith("isatab:")), []);
});

test("ISArchiveParserTest's one-line study (Source Name and culture1)", async () => {
  assert.deepEqual(await tableFor('"Source Name"\n"culture1"\n'), { head: ["Source Name"], rows: [["culture1"]] });
});

test("the table is written head first, then the body, in the order of Tika's parseStudy", async () => {
  const { xml } = await parseXml("a\tb\n1\t2\n");
  const order = ["<h2>STUDY null</h2>", "<table>", "<thead>", "<th>a</th>", "</thead>", "<tbody>", "<td>1</td>", "</tbody>", "</table>"];
  let from = 0;
  for (const part of order) {
    const at = xml.indexOf(part, from);
    assert.ok(at >= from, `${part} after offset ${from} in ${xml}`);
    from = at;
  }
});

test("TDF: quotes hold tabs, newlines and doubled quotes, and spaces around a value are dropped", async () => {
  const table = await tableFor('h1\th2\n"x\ty"\t"line1\nline2"\n"say ""hi"""\t  spaced out  \n');
  assert.deepEqual(table, { head: ["h1", "h2"], rows: [["x\ty", "line1\nline2"], ['say "hi"', "spaced out"]] });
});

test("TDF: empty lines are skipped, and a line break is CRLF, CR or LF", async () => {
  assert.deepEqual(await tableFor("\n\na\n\n\nb\n\n"), { head: ["a"], rows: [["b"]] });
  assert.deepEqual(await tableFor("a\r\nb\rc\nd"), { head: ["a"], rows: [["b"], ["c"], ["d"]] });
  assert.deepEqual(await tableFor("\n\n"), { head: [], rows: [] });
  assert.deepEqual(await tableFor(""), { head: [], rows: [] });
});

test("TDF: a trailing tab makes a last empty cell, and a line of only spaces is one empty cell", async () => {
  assert.deepEqual(await tableFor("a\tb\t\n1\t\n"), { head: ["a", "b", ""], rows: [["1", ""]] });
  assert.deepEqual(await tableFor("a\t"), { head: ["a", ""], rows: [] });
  assert.deepEqual(await tableFor("a\n  \nb\n"), { head: ["a"], rows: [[""], ["b"]] });
  assert.deepEqual(await tableFor("\t\n"), { head: ["", ""], rows: [] });
  assert.deepEqual(await tableFor('""\n'), { head: [""], rows: [] });
});

test("TDF: a quote only opens a value at its start (after spaces), and spaces after the closing quote are allowed", async () => {
  assert.deepEqual(await tableFor('ab"c\td\n'), { head: ['ab"c', "d"], rows: [] });
  assert.deepEqual(await tableFor('  "q"\n'), { head: ["q"], rows: [] });
  assert.deepEqual(await tableFor('"abc"  \t1\n'), { head: ["abc", "1"], rows: [] });
  assert.deepEqual(await tableFor('"a"'), { head: ["a"], rows: [] });
});

test("TDF: only Java whitespace is trimmed (not the no-break space)", async () => {
  const nbsp = String.fromCharCode(0xa0);
  const ideographic = String.fromCharCode(0x3000);
  assert.deepEqual(await tableFor(`${ideographic}x${ideographic}\ny${nbsp}\n`), { head: ["x"], rows: [[`y${nbsp}`]] });
});

test("TDF: a quoted value that never ends, or has text after its closing quote, is malformed (commons-csv's CSVException)", async () => {
  await assert.rejects(parseXml('"abc\n1\t2\n'), MalformedDocumentError);
  await assert.rejects(parseXml('"abc"x\t1\n'), MalformedDocumentError);
  await assert.rejects(parseXml('a\t"b"c\n'), MalformedDocumentError);
});

test("a byte-order mark is not part of the first value", async () => {
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode('"Source Name"\n"culture1"\n')]);
  assert.deepEqual(tableOf((await parseXml(bom)).xml), { head: ["Source Name"], rows: [["culture1"]] });
});

test("every prefix of a valid study file parses or is refused as malformed", async () => {
  const bytes = fixture("s_BII-S-2.txt");
  const parser = new ISArchiveParser();
  let parsed = 0;
  let refused = 0;
  for (let length = 0; length <= bytes.length; length += length < 600 ? 1 : 5) {
    try {
      await parseXml(bytes.subarray(0, length), parser);
      parsed++;
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix of ${length} bytes: ${String(error)}`);
      refused++;
    }
  }
  // Every value in the file is quoted, so a cut inside one is refused, and a cut between two values is read.
  assert.ok(parsed > 100 && refused > 100, `parsed ${parsed}, refused ${refused}`);
});

test("a study over maxBytes is a LimitExceededError, and the input is read no further than the cap", async () => {
  const parser = new ISArchiveParser({ maxBytes: 64 });
  let pulled = 0;
  async function* endless(): AsyncGenerator<Uint8Array> {
    for (let chunks = 0; chunks < 1000; chunks++) {
      pulled += 1;
      yield encoder.encode('"a"\t"b"\n'.repeat(100));
    }
    throw new Error("the parser read an endless input to its end");
  }
  const stream = await RipstreamInputStream.from(endless());
  await assert.rejects(parser.parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()), LimitExceededError);
  await stream.close();
  assert.ok(pulled < 5, `pulled ${pulled} chunks`);
});

test("a row of more cells than maxColumns is a LimitExceededError, by the option and by the default", async () => {
  await assert.rejects(parseXml("a\t".repeat(100) + "a\n", new ISArchiveParser({ maxColumns: 100 })), LimitExceededError);
  const fits = await parseXml("a\t".repeat(99) + "a\n", new ISArchiveParser({ maxColumns: 100 }));
  assert.equal(tableOf(fits.xml).head.length, 100);
  await assert.rejects(parseXml("\t".repeat(200_000)), LimitExceededError);
});

test("the options are positive integers", () => {
  assert.throws(() => new ISArchiveParser({ maxBytes: 0 }), RangeError);
  assert.throws(() => new ISArchiveParser({ maxColumns: 1.5 }), RangeError);
});
