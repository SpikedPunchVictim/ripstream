import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  EncryptedDocumentError,
  LimitExceededError,
  MalformedDocumentError,
  CONTEXT_KEYS,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  type SegmentHints,
} from "@spikedpunch/ripstream-core";
import { ExcelBinaryParser } from "../src/index.ts";
import { buildCompound as buildOle, summaryInformation } from "./ole-builder.ts";

const SECTOR = 512;

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function record(type: number, data: number[]): number[] {
  return [...u16(type), ...u16(data.length), ...data];
}

function biff8String(value: string): number[] {
  return [...u16(value.length), 0, ...new TextEncoder().encode(value)];
}

function buildWorkbook(
  extraColumn?: number,
  extraRows = 1,
  codepage?: number,
  filepass?: number[],
  options: { formatId?: number; date1904?: boolean; value?: number } = {},
): Uint8Array {
  const sstStrings = ["Alpha", "Beta", "Gamma"];
  const sst = [
    ...u32(sstStrings.length),
    ...u32(sstStrings.length),
    ...sstStrings.flatMap((value) => [...u16(value.length), 0, ...new TextEncoder().encode(value)]),
  ];

  const format = record(0x041e, [...u16(164), ...biff8String("yyyy-mm-dd")]);
  const xf0 = record(0x00e0, [...u16(0), ...u16(0), ...new Array(18).fill(0)]);
  const xf1 = record(0x00e0, [...u16(0), ...u16(options.formatId ?? 164), ...new Array(18).fill(0)]);
  const datemode = options.date1904 === true ? record(0x0022, u16(1)) : [];
  const bof = record(0x0809, [...u16(0x0600), ...u16(0x0005), ...new Array(12).fill(0)]);
  const cp = codepage === undefined ? [] : record(0x0042, u16(codepage));
  const encryption = filepass === undefined ? [] : record(0x002f, filepass);
  const sstRecord = record(0x00fc, sst);

  const sheetName = new TextEncoder().encode("Sheet1");
  const boundsheetLength = 4 + 2 + 1 + 1 + sheetName.length;
  const boundsheetPlaceholder = record(0x0085, [
    ...u32(0),
    0,
    1,
    sheetName.length,
    0,
    ...sheetName,
  ]);
  void boundsheetLength;

  const globalLength =
    bof.length + encryption.length + datemode.length + cp.length + format.length + xf0.length + xf1.length + sstRecord.length + boundsheetPlaceholder.length;
  const boundsheet = record(0x0085, [
    ...u32(globalLength),
    0,
    1,
    sheetName.length,
    0,
    ...sheetName,
  ]);

  const sheet = [
    ...bof,
    ...record(0x00fd, [...u16(0), ...u16(0), ...u16(0), ...u32(0)]),
    ...record(0x0203, [...u16(0), ...u16(1), ...u16(1), ...new Uint8Array(new Float64Array([options.value ?? 45292]).buffer)]),
    ...record(0x0204, [...u16(1), ...u16(0), ...u16(0), ...u16(4), 0, ...new TextEncoder().encode("Text")]),
    ...(extraColumn === undefined
      ? []
      : Array.from({ length: extraRows }, (_, index) =>
          record(0x0203, [...u16(9 + index), ...u16(extraColumn), ...u16(1), ...new Uint8Array(new Float64Array([1]).buffer)]),
        ).flat()),
    ...record(0x000a, []),
  ];

  const workbook = new Uint8Array([
    ...bof,
    ...encryption,
    ...datemode,
    ...cp,
    ...format,
    ...xf0,
    ...xf1,
    ...sstRecord,
    ...boundsheet,
    ...sheet,
  ]);
  return buildCompound(workbook);
}

function buildCompound(workbook: Uint8Array): Uint8Array {
  const sectors = Math.ceil(Math.max(workbook.byteLength, 4096) / SECTOR);
  const total = 2 + sectors;
  const data = new Uint8Array(SECTOR + total * SECTOR);
  const view = new DataView(data.buffer);
  data.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 1, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, 0xfffffffe, true);
  view.setUint32(68, 0xfffffffe, true);
  view.setUint32(76, 0, true);
  for (let index = 1; index < 109; index++) view.setUint32(76 + index * 4, 0xffffffff, true);

  const fat = SECTOR;
  view.setUint32(fat, 0xfffffffd, true);
  view.setUint32(fat + 4, 0xfffffffe, true);
  for (let index = 0; index < sectors; index++) {
    const sector = 2 + index;
    view.setUint32(fat + sector * 4, index === sectors - 1 ? 0xfffffffe : sector + 1, true);
  }

  const directory = 2 * SECTOR;
  const name = "Workbook";
  const writeEntry = (index: number, value: string, type: number, right: number, child: number, start: number, size: number): void => {
    const offset = directory + index * 128;
    for (let char = 0; char < value.length; char++) view.setUint16(offset + char * 2, value.charCodeAt(char), true);
    view.setUint16(offset + 64, (value.length + 1) * 2, true);
    data[offset + 66] = type;
    data[offset + 67] = 1;
    view.setUint32(offset + 68, 0xffffffff, true);
    view.setUint32(offset + 72, right, true);
    view.setUint32(offset + 76, child, true);
    view.setUint32(offset + 116, start, true);
    view.setUint32(offset + 120, size, true);
  };
  writeEntry(0, "Root Entry", 5, 0xffffffff, 1, 0, 0);
  writeEntry(1, name, 2, 0xffffffff, 0xffffffff, 2, Math.max(workbook.byteLength, 4096));
  data.set(workbook, 3 * SECTOR);
  return data;
}

async function parse(data: Uint8Array): Promise<string> {
  const stream = await RipstreamInputStream.from(data);
  const handler = new BodyContentHandler();
  await new ExcelBinaryParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  return handler.toString();
}

test("extracts BIFF8 shared strings, dates and labels", async () => {
  const text = await parse(buildWorkbook());
  assert.match(text, /Sheet1/);
  assert.match(text, /Alpha/);
  assert.match(text, /2024-01-01/);
  assert.match(text, /Text/);
});

// Oracle (Tika 4.2.0 /tika, tikajs-ibvq follow-up, an .xls with one NUMBER cell per builtin number format id): POI writes an xls cell
// with the format's code, as it does an xlsx one. 1234.5678 reads "5/18/03" under id 14, "13:37" under 20, "1,235" under 3 and
// "123457%" under 9, and General stays "1234.5678". The CELL values were compared; Tika's table markup is not part of the result.
for (const [formatId, value, expected] of [
  [14, 1234.5678, "5/18/03"],
  [15, 45292.75, "1-Jan-24"],
  [20, 1234.5678, "13:37"],
  [22, 1234.5678, "5/18/03 13:37"],
  [47, 1234.5678, "37:37.9"],
  [3, 1234.5678, "1,235"],
  [9, 1234.5678, "123457%"],
  [0, 1234.5678, "1234.5678"],
] as const) {
  test(`an xls cell of number format ${formatId} is written as POI writes it: ${expected}`, async () => {
    const text = await parse(buildWorkbook(undefined, 1, undefined, undefined, { formatId, value }));
    assert.ok(text.split("\t").includes(expected) || text.includes(`\t${expected}\t`) || text.includes(`\t${expected}\n`), text);
  });
}

// Oracle (Tika 4.2.0 /tika, an .xls with the DATEMODE record set to 1904): serials 0, 1 and 1462 under m/d/yy read "12/31/99",
// "1/1/00" and "1/1/04", the 1900 system. The flag is not applied (the xlsx path reads it the same way).
test("an xls date of a 1904-based workbook is read in the 1900 system, as Tika does", async () => {
  const text = await parse(buildWorkbook(undefined, 1, undefined, undefined, { formatId: 14, value: 1462, date1904: true }));
  assert.match(text, /1\/1\/04/);
});

// Oracle (Tika 4.2.0 /rmeta, an .xls of 150 rows whose Workbook chain was ended early, by an end-of-chain, a free sector, a sector past
// the file or a cut file): HSSF fails reading the sector it does not have, a container-exception with no text. With the declared size
// 4096 past the chain but every sheet whole, the whole text. The check is on the last sheet's EOF, not on the stream size.
const WORKBOOK_FAT_ENTRY = 512 + 2 * 4;

test("an xls whose Workbook chain ends inside its last sheet is truncated, as Tika's read fails", async () => {
  const data = buildWorkbook(1, 100);
  new DataView(data.buffer).setUint32(WORKBOOK_FAT_ENTRY, 0xfffffffe, true);
  await assert.rejects(parse(data), (error: unknown) => error instanceof MalformedDocumentError && /truncated/.test(error.message));
});

test("an xls whose Workbook size is declared past its chain, with every sheet whole, is read", async () => {
  const data = buildWorkbook();
  const view = new DataView(data.buffer);
  view.setUint32(2 * SECTOR + 128 + 120, view.getUint32(2 * SECTOR + 128 + 120, true) + 4096, true);
  assert.match(await parse(data), /Alpha/);
});

test("reads 8-bit strings when the CODEPAGE record says UTF-16 (every Excel 97+ file)", async () => {
  const text = await parse(buildWorkbook(undefined, 1, 1200));
  assert.match(text, /Sheet1/);
  assert.match(text, /Alpha/);
  assert.match(text, /Text/);
});

test("rejects non-compound data", async () => {
  await assert.rejects(
    parse(new TextEncoder().encode("not compound")),
    MalformedDocumentError,
  );
});

test("rejects cells beyond the column limit", async () => {
  await assert.rejects(parse(buildWorkbook(65_535)), MalformedDocumentError);
});

test("rejects sparse sheets whose padded cell total is too large", async () => {
  await assert.rejects(parse(buildWorkbook(16_383, 100)), LimitExceededError);
});

// Oracle (Tika 4.2.0 /rmeta, a workbook with a FILEPASS record, RC4 or XOR): EncryptedDocumentException "Unable to process: document is
// encrypted" and no text. The enciphered records used to be read as cells.
for (const [kind, filepass] of [["RC4", [...u16(1), ...u16(1), ...u16(1), ...new Array(48).fill(7)]], ["XOR", [...u16(0), ...u16(0x1234), ...u16(0x5678)]]] as const) {
  test(`an .xls with a ${kind} FILEPASS record is an encrypted document`, async () => {
    const stream = await RipstreamInputStream.from(buildWorkbook(undefined, 1, undefined, [...filepass]));
    await assert.rejects(
      new ExcelBinaryParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
      (error) => error instanceof EncryptedDocumentError && /document is encrypted/.test(error.message),
    );
    await stream.close();
  });
}

test("an xls's rows are told to the segments by their own numbers, so empty rows are counted (tikajs-57wb)", async () => {
  // buildWorkbook holds cells in rows 1 and 2, and one more at row 10 (0-based 9).
  const rows: number[] = [];
  const hints = { layout() {}, delimited() {}, heading() {}, line() {}, row: (number: number) => rows.push(number), col() {}, shape() {}, para() {} } satisfies SegmentHints;
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.SEGMENT_HINTS, hints);
  const stream = await RipstreamInputStream.from(buildWorkbook(1, 1));
  await new ExcelBinaryParser().parse(stream, new BodyContentHandler(), new Metadata(), ctx);
  await stream.close();
  assert.deepEqual(rows, [1, 2, 10]);
});

// Oracle (Tika 4.2.0 /rmeta/body, testEXCEL_5.xls: BIFF5, a stream named Book): OfficeParser reads it with OldExcelExtractor, a
// "Sheet: name" line for each BOUNDSHEET and a line for each cell, numbers as Java writes a double (tikajs-cigc).
function biff5BookBytes(extra: number[] = []): Uint8Array {
  const bof = record(0x0809, [...u16(0x0500), ...u16(0x0005), ...new Array(4).fill(0)]);
  const name = new TextEncoder().encode("Feuil1");
  const boundsheet = record(0x0085, [...u32(0), 0, 0, name.length, ...name]);
  const label = record(0x0204, [...u16(0), ...u16(0), ...u16(0), ...u16(5), ...new TextEncoder().encode("hello")]);
  const number = record(0x0203, [...u16(1), ...u16(0), ...u16(0), ...new Uint8Array(new Float64Array([3]).buffer)]);
  const rk = record(0x027e, [...u16(2), ...u16(0), ...u16(0), ...u32((7 << 2) | 0x02)]);
  return new Uint8Array([...bof, ...extra, ...boundsheet, ...label, ...number, ...rk, ...record(0x000a, [])]);
}

function buildBiff5Book(extra: number[] = []): Uint8Array {
  return buildOle([{ name: "Book", data: biff5BookBytes(extra) }]);
}

test("a BIFF5 workbook in a Book stream is read as OldExcelExtractor reads it", async () => {
  assert.equal(await parse(buildBiff5Book()), "Sheet: Feuil1\nhello\n3.0\n7.0\n");
});

test("a BIFF5 workbook with a FILEPASS record is an encrypted document", async () => {
  await assert.rejects(
    parse(buildBiff5Book(record(0x002f, [...u16(0), ...u16(0x1234), ...u16(0x5678)]))),
    (error) => error instanceof EncryptedDocumentError && /document is encrypted/.test(error.message),
  );
});

test("an .xls's SummaryInformation stream is metadata, as OfficeParser makes it for every OLE2 file (tikajs-n83j)", async () => {
  const stream = await RipstreamInputStream.from(
    buildOle([
      { name: "Book", data: biff5BookBytes() },
      { name: "\u0005SummaryInformation", data: summaryInformation("Quarterly") },
    ]),
  );
  const metadata = new Metadata();
  await new ExcelBinaryParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("dc:title"), "Quarterly");
});
