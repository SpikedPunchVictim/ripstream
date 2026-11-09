import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { ExcelBinaryParser } from "../src/index.ts";

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

function buildWorkbook(extraColumn?: number, extraRows = 1, codepage?: number): Uint8Array {
  const sstStrings = ["Alpha", "Beta", "Gamma"];
  const sst = [
    ...u32(sstStrings.length),
    ...u32(sstStrings.length),
    ...sstStrings.flatMap((value) => [...u16(value.length), 0, ...new TextEncoder().encode(value)]),
  ];

  const format = record(0x041e, [...u16(164), ...biff8String("yyyy-mm-dd")]);
  const xf0 = record(0x00e0, [...u16(0), ...u16(0), ...new Array(18).fill(0)]);
  const xf1 = record(0x00e0, [...u16(0), ...u16(164), ...new Array(18).fill(0)]);
  const bof = record(0x0809, [...u16(0x0600), ...u16(0x0005), ...new Array(12).fill(0)]);
  const cp = codepage === undefined ? [] : record(0x0042, u16(codepage));
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
    bof.length + cp.length + format.length + xf0.length + xf1.length + sstRecord.length + boundsheetPlaceholder.length;
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
    ...record(0x0203, [...u16(0), ...u16(1), ...u16(1), ...new Uint8Array(new Float64Array([45292]).buffer)]),
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
