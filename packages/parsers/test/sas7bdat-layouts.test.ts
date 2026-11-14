import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  UnsupportedFormatError,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { Sas7bdatParser } from "../src/sas7bdat.ts";
import { readSasFile, type SasValue } from "../src/sas7bdat-file.ts";
import { buildSas7bdat, HEADER_LENGTH, type BuildOptions, type BuiltColumn } from "./sas7bdat-builder.ts";

/*
 * The 64-bit, big-endian and compressed layouts of SAS7BDAT (tikajs-68os.69). No file of any of them was available, and the
 * Tika tree has none: the files here come from sas7bdat-builder.ts, which writes the layouts as the pandas and ReadStat readers
 * are remembered to read them. These tests show the reader and the builder agree, and that hostile input is bounded; they do
 * not show that SAS writes the layouts so. Read from the Tika source (the metadata keys), not run against a Tika.
 */

const COLUMNS: BuiltColumn[] = [
  { name: "n", type: "numeric", width: 8 },
  { name: "short", type: "numeric", width: 4 },
  { name: "text", type: "character", width: 10, label: "A text" },
  { name: "when", type: "numeric", width: 8, format: { name: "DATE", width: 9, precision: 0 } },
];
const ROWS: SasValue[][] = [
  [1, 3, "one", 0],
  [2.5, 2.5, "two", 366],
  [null, null, "", null],
];

const rowsOf = (data: Uint8Array): SasValue[][] => [...readSasFile(data).rows()];

async function parseSas(data: Uint8Array, context = new ParseContext()): Promise<{ metadata: Metadata; xml: string }> {
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  const handler = createOutputHandler("xml");
  try {
    await new Sas7bdatParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { metadata, xml: handler.toString() };
}

const LAYOUTS: Array<[string, Partial<BuildOptions>]> = [
  ["32-bit little-endian", {}],
  ["32-bit big-endian", { bigEndian: true }],
  ["64-bit little-endian", { bits: 64 }],
  ["64-bit big-endian", { bits: 64, bigEndian: true }],
];

for (const [name, layout] of LAYOUTS) {
  const build = (extra: Partial<BuildOptions> = {}): Uint8Array =>
    buildSas7bdat({ columns: COLUMNS, rows: ROWS, created: 86400, name: "LAYOUT", ...layout, ...extra });

  test(`${name}: the columns, labels, values and properties are read`, () => {
    const sas = readSasFile(build());
    assert.deepEqual(
      sas.columns.map((column) => [column.name, column.label, column.type, column.width, column.format?.name ?? null]),
      [
        ["n", "", "numeric", 8, null],
        ["short", "", "numeric", 4, null],
        ["text", "A text", "character", 10, null],
        ["when", "", "numeric", 8, "DATE"],
      ],
    );
    assert.deepEqual([...sas.rows()], ROWS);
    assert.equal(sas.properties.name, "LAYOUT");
    assert.equal(sas.properties.created?.toISOString(), "1960-01-02T00:00:00.000Z");
    assert.equal(sas.properties.rowCount, 3);
    assert.equal(sas.properties.columnCount, 4);
    assert.equal(sas.properties.sasRelease, "9.0401M5");
    assert.equal(sas.properties.serverType, "X64_7PRO");
    assert.equal(sas.properties.bits, layout.bits ?? 32);
    assert.equal(sas.properties.endian, layout.bigEndian === true ? "Big" : "Little");
  });

  test(`${name}: rows go on from the first page to data pages, in order`, () => {
    const rows = Array.from({ length: 400 }, (_unused, index): SasValue[] => [index, index, `row ${index}`, index]);
    const data = build({ rows, rowsOnMixPage: 7 });
    assert.ok(data.length >= HEADER_LENGTH + 4 * 4096);
    const read = rowsOf(data);
    assert.equal(read.length, 400);
    assert.deepEqual(read[7], [7, 7, "row 7", 7]);
    assert.deepEqual(read[399], [399, 399, "row 399", 399]);
  });

  test(`${name}: the metadata says the architecture and the byte order, and the table has the cells`, async () => {
    const { metadata, xml } = await parseSas(build());
    assert.equal(metadata.get("machine:architectureBits"), String(layout.bits ?? 32));
    assert.equal(metadata.get("machine:endian"), layout.bigEndian === true ? "Big" : "Little");
    assert.equal(metadata.get("database:row-count"), "3");
    assert.match(xml, /<td>two<\/td>/);
    assert.match(xml, /<td>01Jan1961<\/td>/);
  });
}

test("a big-endian file with a byte order byte that is neither is malformed", () => {
  const data = buildSas7bdat({ columns: COLUMNS, rows: ROWS, bits: 64 });
  data[37] = 2;
  assert.throws(() => readSasFile(data), MalformedDocumentError);
});

test("a 64-bit page count that does not fit in a number is malformed, and is not read as that many pages", () => {
  const data = buildSas7bdat({ columns: COLUMNS, rows: ROWS, bits: 64 });
  new DataView(data.buffer).setBigUint64(208, 0xffffffffffffffffn, true);
  assert.throws(() => readSasFile(data), MalformedDocumentError);
});

test("a 64-bit file cut short is malformed whatever the cut", () => {
  const data = buildSas7bdat({ columns: COLUMNS, rows: ROWS, bits: 64, bigEndian: true });
  for (const length of [0, 100, 287, 288, 1024, 1024 + 40, data.length - 1]) {
    assert.throws(() => readSasFile(data.subarray(0, length)), MalformedDocumentError, `cut at ${length}`);
  }
});

// ---- compressed rows ----

/** The inverse of the RLE reader, for runs and copies only: enough for the rows of a test. */
function rleCompress(row: Uint8Array): Uint8Array {
  const out: number[] = [];
  const literal: number[] = [];
  const flush = (): void => {
    for (let at = 0; at < literal.length; at += 16) {
      const chunk = literal.slice(at, at + 16);
      out.push(0x80 + chunk.length - 1, ...chunk);
    }
    literal.length = 0;
  };
  let index = 0;
  while (index < row.length) {
    let run = 1;
    while (index + run < row.length && row[index + run] === row[index]) run++;
    const byte = row[index]!;
    const special = byte === 0x20 ? 0x60 : byte === 0 ? 0x70 : byte === 0x40 ? 0x50 : null;
    if (special !== null && run >= 18) {
      flush();
      const count = Math.min(run, 17 + 0xfff) - 17;
      out.push(special + (count >> 8), count & 0xff);
      index += count + 17;
    } else if (run >= 3 && run <= 18) {
      flush();
      out.push(0xc0 + run - 3, byte);
      index += run;
    } else if (run > 18) {
      flush();
      out.push(0xc0 + 15, byte);
      index += 18;
    } else {
      literal.push(byte);
      index++;
    }
  }
  flush();
  return Uint8Array.from(out);
}

/** The inverse of the RDC reader, for literals and runs: the control words, then the items. */
function rdcCompress(row: Uint8Array): Uint8Array {
  const items: Array<{ command: boolean; bytes: number[] }> = [];
  let index = 0;
  while (index < row.length) {
    let run = 1;
    while (index + run < row.length && row[index + run] === row[index]) run++;
    if (run >= 19) {
      const count = Math.min(run, 19 + 0xfff) - 19;
      items.push({ command: true, bytes: [0x10 + (count & 0x0f), count >> 4, row[index]!] });
      index += count + 19;
    } else if (run >= 3) {
      items.push({ command: true, bytes: [run - 3, row[index]!] });
      index += run;
    } else {
      items.push({ command: false, bytes: [row[index]!] });
      index++;
    }
  }
  const out: number[] = [];
  for (let at = 0; at < items.length; at += 16) {
    const group = items.slice(at, at + 16);
    const bits = group.reduce((word, item, position) => (item.command ? word | (0x8000 >> position) : word), 0);
    out.push(bits >> 8, bits & 0xff, ...group.flatMap((item) => item.bytes));
  }
  return Uint8Array.from(out);
}

const COMPRESSORS = [
  ["RLE", rleCompress],
  ["RDC", rdcCompress],
] as const;

const WIDE: BuiltColumn[] = [
  { name: "id", type: "numeric", width: 8 },
  { name: "name", type: "character", width: 40 },
  { name: "note", type: "character", width: 60, label: "A note" },
];
const WIDE_ROWS: SasValue[][] = [
  [1, "alpha", "short"],
  [2, "bravo", "x".repeat(60)],
  [3, "", ""],
  [4, "delta", "a mixed note, with some runs     in it"],
];

for (const [method, compress] of COMPRESSORS) {
  for (const [name, layout] of LAYOUTS) {
    test(`${method}, ${name}: compressed rows are read as the rows they were`, () => {
      const data = buildSas7bdat({ columns: WIDE, rows: WIDE_ROWS, name: "PACKED", ...layout, compression: { method, compress } });
      const sas = readSasFile(data);
      assert.deepEqual([...sas.rows()], WIDE_ROWS);
      assert.deepEqual(sas.columns.map((column) => column.name), ["id", "name", "note"]);
      assert.equal(sas.properties.rowCount, 4);
    });
  }

  test(`${method}: the compressed rows go on over several pages, in order`, async () => {
    const rows = Array.from({ length: 600 }, (_unused, index): SasValue[] => [index, `name ${index}`, `note ${index}`]);
    const data = buildSas7bdat({ columns: WIDE, rows, compression: { method, compress } });
    assert.ok(data.length >= HEADER_LENGTH + 4 * 4096);
    assert.deepEqual(rowsOf(data), rows);
    const { metadata, xml } = await parseSas(data);
    assert.equal(metadata.get("database:row-count"), "600");
    assert.match(xml, /<td>note 599<\/td>/);
  });

  test(`${method}: a row that did not get shorter is stored as it is, and read as it is`, () => {
    // Eight bytes, then text with no runs: nothing for either compression to take out of a row this short.
    const columns: BuiltColumn[] = [
      { name: "a", type: "character", width: 8 },
      { name: "b", type: "character", width: 8 },
    ];
    const rows: SasValue[][] = [["abcdefgh", "ijklmnop"]];
    const data = buildSas7bdat({ columns, rows, compression: { method, compress } });
    assert.deepEqual(rowsOf(data), rows);
  });

  test(`${method}: data that does not decompress to a row is malformed`, () => {
    const data = buildSas7bdat({ columns: WIDE, rows: WIDE_ROWS, compression: { method, compress: () => Uint8Array.of(0x80, 0x41) } });
    assert.throws(() => rowsOf(data), MalformedDocumentError);
  });

  test(`${method}: a row length of a gigabyte over subheaders of a few bytes is refused, and is not allocated`, () => {
    const data = buildSas7bdat({ columns: WIDE, rows: WIDE_ROWS, compression: { method, compress } });
    // The row size subheader is the first on page 0, at the end of the page.
    const at = HEADER_LENGTH + 4096 - 480;
    new DataView(data.buffer).setUint32(at + 20, 0x40000000, true);
    assert.throws(() => rowsOf(data), MalformedDocumentError);
  });

  test(`${method}: rows that inflate past what the limits allow are a LimitExceededError`, async () => {
    // One blank-filled row of a megabyte takes a few hundred bytes; the test pins a ratio of 100, below Tika's 1000.
    const columns: BuiltColumn[] = [{ name: "blank", type: "character", width: 65536 }];
    const rows: SasValue[][] = Array.from({ length: 300 }, () => [""]);
    const data = buildSas7bdat({ columns, rows, pageLength: 8192, compression: { method, compress } });
    await assert.rejects(parseSas(data, new ParseContext({ limits: { maxDecompressionRatio: 100 } })), LimitExceededError);
  });
}

test("an RLE command whose length is not known is a refusal as unsupported", () => {
  const data = buildSas7bdat({
    columns: WIDE,
    rows: WIDE_ROWS,
    compression: { method: "RLE", compress: () => Uint8Array.of(0x40, 0x00, 0x41) },
  });
  assert.throws(() => rowsOf(data), UnsupportedFormatError);
});

test("a file that names a compression only in a later text block is not compressed", () => {
  const data = buildSas7bdat({
    columns: [{ name: "SASYZCRL", type: "numeric", width: 8, blocks: { name: 1 } }],
    rows: [[1]],
    textBlocks: 2,
  });
  assert.deepEqual(rowsOf(data), [[1]]);
});
