import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  UnsupportedFormatError,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { Sas7bdatParser } from "../src/sas7bdat.ts";
import { formatCell } from "../src/sas-format.ts";
import { readSasFile, type SasColumn, type SasValue } from "../src/sas7bdat-file.ts";
import { buildSas7bdat, HEADER_LENGTH, type BuiltColumn } from "./sas7bdat-builder.ts";

/*
 * SAS7BDATParser (tikajs-68os.21), from Tika 4.2.0's SAS7BDATParserTest. Tika reads the file with parso, whose source was not
 * available: what this reader does is the published format as the two files of that test show it, 32-bit and
 * little-endian and uncompressed, both on one page. What the fixtures in fixtures/misc-data/sas7bdat-*.json say is not
 * repeated. Read from the Tika source, not run against a Tika.
 */

const file = (name: string): Uint8Array => readFileSync(new URL(`./fixtures/misc-data/${name}`, import.meta.url));
const SIMPLE = (): Uint8Array => file("testSAS.sas7bdat");
const COLUMNAR = (): Uint8Array => file("test-columnar.sas7bdat");

async function parseSas(data: Uint8Array): Promise<{ metadata: Metadata; xml: string }> {
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  const handler = createOutputHandler("xml");
  try {
    await new Sas7bdatParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { metadata, xml: handler.toString() };
}

const rowsOf = (data: Uint8Array): SasValue[][] => [...readSasFile(data).rows()];

// ---- what Tika asserts ----

test("testSAS.sas7bdat: the columns are recnum and label, and the markup is a table under the name (testSimpleFile, testHTML)", async () => {
  const { metadata, xml } = await parseSas(SIMPLE());
  assert.deepEqual(metadata.getAll("database:column-name"), ["recnum", "label"]);
  assert.ok(xml.includes("<h1>TESTING</h1>"));
  assert.ok(xml.includes('<th title="recnum">recnum</th>'));
  assert.ok(xml.includes('<th title="label">label</th>'));
  assert.ok(xml.includes("<td>3</td>"));
  assert.ok(xml.includes("<td>This is row"));
  assert.ok(xml.includes("10</td>"));
});

test("test-columnar.sas7bdat: eight columns named by their labels where they have one (testMultiColumns, testHTML2)", async () => {
  const { metadata, xml } = await parseSas(COLUMNAR());
  assert.deepEqual(metadata.getAll("database:column-name"), [
    "Record Number",
    "Square of the Record Number",
    "Description of the Row",
    "Percent Done",
    "Percent Increment",
    "date",
    "datetime",
    "time",
  ]);
  assert.ok(xml.includes("<h1>TESTING</h1>"));
  assert.ok(xml.includes('<th title="recnum">Record Number</th>'));
  assert.ok(xml.includes('<th title="square">Square of the Record Number</th>'));
  assert.ok(xml.includes('<th title="date">date</th>'));
  assert.ok(xml.includes("<td>01-01-1960</td>"));
  assert.ok(xml.includes("<td>01Jan1960:00:00:10.00</td>"));
});

// ---- checked against SAS's own export of the same data ----

/** test-columnar.sas.xml is SAS's XML export of test-columnar.sas7bdat: a source of truth that is neither parso nor this reader. */
function exported(): Array<Record<string, string | null>> {
  const xml = new TextDecoder("windows-1252").decode(file("test-columnar.sas.xml"));
  return [...xml.matchAll(/<TESTXML>([\s\S]*?)<\/TESTXML>/g)].map((row) => {
    const fields: Record<string, string | null> = {};
    for (const field of row[1]!.matchAll(/<(\w+)(?: missing="M" \/>|>([^<]*)<\/\1>)/g)) fields[field[1]!] = field[2] ?? null;
    return fields;
  });
}

const SAS_EPOCH = Date.UTC(1960, 0, 1);

test("every value of test-columnar.sas7bdat is the value SAS exported", () => {
  const expected = exported();
  const rows = rowsOf(COLUMNAR());
  assert.equal(expected.length, 11);
  assert.equal(rows.length, expected.length);
  rows.forEach((row, index) => {
    const want = expected[index]!;
    const [recnum, square, desc, pctdone, pctincr, date, datetime, time] = row;
    assert.equal(recnum, Number(want.recnum));
    assert.equal(square, Number(want.square));
    assert.equal(desc, want.desc);
    assert.equal(pctdone, Number(want.pctdone));
    if (want.pctincr === null) assert.equal(pctincr, null);
    else assert.ok(Math.abs((pctincr as number) - Number(want.pctincr)) < 1e-9, `pctincr of row ${index}`);
    assert.equal(date, Number(want.date));
    assert.equal(new Date(SAS_EPOCH + (datetime as number) * 1000).toISOString().slice(0, 19), want.datetime);
    const seconds = time as number;
    const clock = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((part) => String(part).padStart(2, "0"));
    assert.equal(clock.join(":"), want.time);
  });
});

test("the columns of test-columnar.sas7bdat carry the formats the file names", () => {
  const sas = readSasFile(COLUMNAR());
  assert.deepEqual(
    sas.columns.map((column) => column.format?.name ?? null),
    [null, null, null, "PERCENT", "PERCENT", "DDMMYYD", "DATETIME", "TIME"],
  );
  assert.deepEqual(
    sas.columns.map((column) => column.type),
    ["numeric", "numeric", "character", "numeric", "numeric", "numeric", "numeric", "numeric"],
  );
});

// ---- the cell text ----

const numeric = (format: string | null, precision = 0): SasColumn => ({
  name: "x",
  label: "",
  type: "numeric",
  offset: 0,
  width: 8,
  format: format === null ? null : { name: format, width: 0, precision },
});

test("a number without a format is written without a decimal point when it is whole", () => {
  assert.equal(formatCell(numeric(null), 3), "3");
  assert.equal(formatCell(numeric(null), 10), "10");
  assert.equal(formatCell(numeric(null), -4), "-4");
  assert.equal(formatCell(numeric(null), 0.6), "0.6");
});

test("a number is rounded to fifteen significant digits, so the noise of a double does not show", () => {
  assert.equal(formatCell(numeric(null), 1 / 3), "0.333333333333333");
  assert.equal(formatCell(numeric(null), 0.1 + 0.2), "0.3");
});

test("a missing number is an empty cell", () => {
  assert.equal(formatCell(numeric(null), null), "");
  assert.equal(formatCell(numeric("DATE"), null), "");
});

test("dates are written in the patterns parso uses, in UTC", () => {
  assert.equal(formatCell(numeric("DDMMYYD"), 0), "01-01-1960");
  assert.equal(formatCell(numeric("DDMMYY"), 366), "01/01/1961");
  assert.equal(formatCell(numeric("MMDDYYS"), 59), "02/29/1960");
  assert.equal(formatCell(numeric("YYMMDD"), 365), "1960-12-31");
  assert.equal(formatCell(numeric("YYMMDDN"), 0), "19600101");
  assert.equal(formatCell(numeric("DATE"), 0), "01Jan1960");
});

test("datetimes and times follow the pattern of the test, with the milliseconds in two digits at least", () => {
  assert.equal(formatCell(numeric("DATETIME"), 10), "01Jan1960:00:00:10.00");
  assert.equal(formatCell(numeric("DATETIME"), 86400 + 3661.5), "02Jan1960:01:01:01.500");
  assert.equal(formatCell(numeric("TIME"), 3), "00:00:03");
  assert.equal(formatCell(numeric("TIME"), 3661), "01:01:01");
});

test("a date out of the range of dates is written as the number it is", () => {
  assert.equal(formatCell(numeric("DATE"), 1e300), "1e+300");
  assert.equal(formatCell(numeric("DATETIME"), Infinity), "Infinity");
});

test("a format this reader has no pattern for leaves the number as it is", () => {
  assert.equal(formatCell(numeric("COMMA"), 1234), "1234");
});

test("a percent is the number times a hundred, to the precision of the format (this reader's choice, not parso's)", () => {
  assert.equal(formatCell(numeric("PERCENT", 0), 0.6), "60%");
  assert.equal(formatCell(numeric("PERCENT", 1), 0.8333333333), "83.3%");
});

test("text is written as it is", () => {
  const column: SasColumn = { name: "c", label: "", type: "character", offset: 0, width: 4, format: null };
  assert.equal(formatCell(column, "abc"), "abc");
});

// ---- variants this reader does not read ----

const COLUMNS: BuiltColumn[] = [
  { name: "n", type: "numeric", width: 8 },
  { name: "short", type: "numeric", width: 4 },
  { name: "text", type: "character", width: 10, label: "A text" },
];
const ROWS: Array<Array<number | string | null>> = [
  [1, 3, "one"],
  [2, 2.5, "two"],
  [null, null, ""],
];
const small = (): Uint8Array => buildSas7bdat({ columns: COLUMNS, rows: ROWS, created: 86400, name: "SMALL" });

const patched = (data: Uint8Array, change: (view: DataView, bytes: Uint8Array) => void): Uint8Array => {
  const copy = Uint8Array.from(data);
  change(new DataView(copy.buffer), copy);
  return copy;
};

/** Absolute offset of the row size subheader of a built file: the first subheader sits at the end of the first page. */
const ROW_SIZE_AT = (pageLength = 4096): number => HEADER_LENGTH + pageLength - 480;

test("a 64-bit file is refused as unsupported, since no file of that kind was available to read it against", async () => {
  await assert.rejects(parseSas(patched(small(), (_view, bytes) => (bytes[32] = 0x33))), UnsupportedFormatError);
});

test("a big-endian file is refused as unsupported, for the same reason", async () => {
  await assert.rejects(parseSas(patched(small(), (_view, bytes) => (bytes[37] = 0))), UnsupportedFormatError);
});

test("a file whose columns are compressed is refused as unsupported", async () => {
  const compressed = buildSas7bdat({ columns: [{ name: "SASYZCRL", type: "numeric", width: 8 }], rows: [[1]] });
  await assert.rejects(parseSas(compressed), UnsupportedFormatError);
});

test("text and an empty file are not SAS files", async () => {
  await assert.rejects(parseSas(new TextEncoder().encode("not a SAS file ".repeat(40))), MalformedDocumentError);
  await assert.rejects(parseSas(new Uint8Array(0)), MalformedDocumentError);
});

// ---- built files ----

test("a built file gives its columns, its labels and its values, with a narrow number read from its high bytes", async () => {
  const sas = readSasFile(small());
  assert.deepEqual(
    sas.columns.map((column) => [column.name, column.label, column.type, column.width]),
    [["n", "", "numeric", 8], ["short", "", "numeric", 4], ["text", "A text", "character", 10]],
  );
  assert.deepEqual([...sas.rows()], [[1, 3, "one"], [2, 2.5, "two"], [null, null, ""]]);
  assert.equal(sas.properties.name, "SMALL");
  assert.equal(sas.properties.created?.toISOString(), "1960-01-02T00:00:00.000Z");
  assert.equal(sas.properties.rowCount, 3);
  assert.equal(sas.properties.columnCount, 3);
  assert.equal(sas.properties.sasRelease, "9.0401M5");
  assert.equal(sas.properties.serverType, "X64_7PRO");
});

test("rows go on from the first page to data pages, in order", async () => {
  const rows = Array.from({ length: 100 }, (_unused, index): Array<number | string | null> => [index, index, `row ${index}`]);
  const data = buildSas7bdat({ columns: COLUMNS, rows, pageLength: 2048, rowsOnMixPage: 7 });
  assert.equal(data.length, HEADER_LENGTH + 3 * 2048);
  const read = rowsOf(data);
  assert.equal(read.length, 100);
  assert.deepEqual(read[0], [0, 0, "row 0"]);
  assert.deepEqual(read[7], [7, 7, "row 7"]);
  assert.deepEqual(read[99], [99, 99, "row 99"]);
  const { metadata } = await parseSas(data);
  assert.equal(metadata.get("database:row-count"), "100");
});

test("an unknown encoding byte gives no Content-Encoding", async () => {
  const { metadata } = await parseSas(buildSas7bdat({ columns: COLUMNS, rows: ROWS, encodingByte: 250 }));
  assert.equal(metadata.get("Content-Encoding"), null);
});

test("character values are read in the encoding of the file", () => {
  const latin = buildSas7bdat({ columns: [{ name: "t", type: "character", width: 4 }], rows: [["café"]], encodingByte: 62 });
  assert.deepEqual(rowsOf(latin), [["café"]]);
});

// ---- every prefix, and hostile input ----

test("every prefix of testSAS.sas7bdat is refused as malformed, since the pages are all or nothing", async () => {
  const full = SIMPLE();
  for (let length = 0; length < full.length; length++) {
    await assert.rejects(parseSas(full.subarray(0, length)), MalformedDocumentError, `prefix of ${length} bytes`);
  }
  await parseSas(full);
});

test("prefixes of a built file with several pages are parsed or refused as malformed", async () => {
  const rows = Array.from({ length: 30 }, (_unused, index): Array<number | string | null> => [index, index, "x"]);
  const full = buildSas7bdat({ columns: COLUMNS, rows, pageLength: 2048, rowsOnMixPage: 3 });
  for (let length = 0; length <= full.length; length += 7) {
    try {
      await parseSas(full.subarray(0, length));
    } catch (error) {
      if (!(error instanceof MalformedDocumentError)) throw error;
    }
  }
});

const hostile = { timeout: 30_000 };

test("a page count of two billion is not read as that many pages", hostile, async () => {
  await assert.rejects(parseSas(patched(small(), (view) => view.setInt32(204, 0x7fffffff, true))), MalformedDocumentError);
});

test("a header or page length that is negative, zero or past the file is refused", hostile, async () => {
  for (const [offset, value] of [[196, -1], [196, 0x7fffffff], [196, 0], [200, 0], [200, 1], [200, -5]] as const) {
    await assert.rejects(parseSas(patched(small(), (view) => view.setInt32(offset, value, true))), MalformedDocumentError, `${offset}=${value}`);
  }
});

test("a row count of four billion gives the rows the page holds, not that many", hostile, async () => {
  const data = patched(small(), (view) => view.setUint32(ROW_SIZE_AT() + 24, 0xffffffff, true));
  const rows = rowsOf(data);
  assert.ok(rows.length >= 3 && rows.length < 4096, `${rows.length} rows`);
});

test("a row length of zero, or shorter than the columns it holds, is refused", hostile, async () => {
  for (const value of [0, 1, 21]) {
    await assert.rejects(parseSas(patched(small(), (view) => view.setUint32(ROW_SIZE_AT() + 20, value, true))), MalformedDocumentError, `row length ${value}`);
  }
});

test("a column count that is not the number of columns is refused", hostile, async () => {
  const columnSizeAt = ROW_SIZE_AT() - 12;
  await assert.rejects(parseSas(patched(small(), (view) => view.setUint32(columnSizeAt + 4, 4_000_000_000, true))), MalformedDocumentError);
});

test("a subheader that runs past its page is refused", hostile, async () => {
  const pointer = HEADER_LENGTH + 24; // the row size subheader's
  await assert.rejects(parseSas(patched(small(), (view) => view.setUint32(pointer + 4, 100_000, true))), MalformedDocumentError);
  await assert.rejects(parseSas(patched(small(), (view) => view.setUint32(pointer, 4_000_000_000, true))), MalformedDocumentError);
});

test("a thousand pointers at the same large subheader are not read a thousand times over", hostile, async () => {
  const data = buildSas7bdat({ columns: COLUMNS, rows: ROWS, pageLength: 1 << 20 });
  const bytes = patched(data, (view, copy) => {
    const count = 20_000;
    view.setUint16(HEADER_LENGTH + 20, count, true);
    // Every pointer after the real ones copies the pointer to the names subheader.
    const names = HEADER_LENGTH + 24 + 4 * 12;
    for (let index = 8; index < count; index++) copy.copyWithin(HEADER_LENGTH + 24 + index * 12, names, names + 12);
  });
  await assert.rejects(parseSas(bytes), MalformedDocumentError);
});

test("a column that runs past its row, or has no width, is refused", hostile, async () => {
  const data = small();
  // The attribute vectors are found by their signature rather than by a layout the test would have to repeat.
  const at = findSignature(data, [0xfc, 0xff, 0xff, 0xff]);
  for (const width of [0, 9, 4_000_000_000]) {
    const bad = patched(data, (view) => view.setUint32(at + 12 + 4, width, true));
    await assert.rejects(parseSas(bad), MalformedDocumentError, `width ${width}`);
  }
});

test("a name that points at a text block that is not there is refused", hostile, async () => {
  const data = small();
  const at = findSignature(data, [0xff, 0xff, 0xff, 0xff]);
  await assert.rejects(parseSas(patched(data, (view) => view.setUint16(at + 12, 9, true))), MalformedDocumentError);
});

function findSignature(data: Uint8Array, signature: number[]): number {
  for (let at = HEADER_LENGTH; at + signature.length <= data.length; at++) {
    if (signature.every((byte, index) => data[at + index] === byte)) return at;
  }
  throw new Error("signature not found");
}
