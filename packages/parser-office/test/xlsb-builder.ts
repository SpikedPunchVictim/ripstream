/*
 * A small XLSB (BIFF12) writer for tests: shared strings, sheets of rows of cells, as the records the parser reads. A cell's
 * column and a row's number are the sheet's own (0-based, as the records store them), so a test can leave cells and rows out.
 */
import { zipSync } from "fflate";

export type XlsbCell =
  | { readonly col: number; readonly type: "string"; readonly value: string }
  | { readonly col: number; readonly type: "shared"; readonly value: number }
  | { readonly col: number; readonly type: "real"; readonly value: number }
  | { readonly col: number; readonly type: "bool"; readonly value: boolean }
  | { readonly col: number; readonly type: "blank" }
  | { readonly col: number; readonly type: "error"; readonly value: number };

export interface XlsbRow {
  readonly row: number;
  readonly cells: readonly XlsbCell[];
}

export interface XlsbSheet {
  readonly name: string;
  readonly rows: readonly XlsbRow[];
}

const BRT_ROW_HDR = 0;
const BRT_CELL_BLANK = 1;
const BRT_CELL_ERROR = 3;
const BRT_CELL_BOOL = 4;
const BRT_CELL_REAL = 5;
const BRT_CELL_ST = 6;
const BRT_CELL_ISST = 7;
const BRT_BUNDLE_SH = 156;
const BRT_SST_ITEM = 19;

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

function wide(text: string): number[] {
  const bytes: number[] = [...u32(text.length)];
  for (let index = 0; index < text.length; index++) bytes.push(text.charCodeAt(index) & 0xff, text.charCodeAt(index) >> 8);
  return bytes;
}

function record(type: number, data: readonly number[]): number[] {
  const header = type < 0x80 ? [type] : [(type & 0x7f) | 0x80, type >> 7];
  const length: number[] = [];
  let rest = data.length;
  do {
    const byte = rest & 0x7f;
    rest >>= 7;
    length.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return [...header, ...length, ...data];
}

function cellRecord(cell: XlsbCell): number[] {
  const header = [...u32(cell.col), ...u32(0)];
  switch (cell.type) {
    case "string":
      return record(BRT_CELL_ST, [...header, ...wide(cell.value)]);
    case "shared":
      return record(BRT_CELL_ISST, [...header, ...u32(cell.value)]);
    case "real": {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, cell.value, true);
      return record(BRT_CELL_REAL, [...header, ...bytes]);
    }
    case "bool":
      return record(BRT_CELL_BOOL, [...header, cell.value ? 1 : 0]);
    case "blank":
      return record(BRT_CELL_BLANK, header);
    case "error":
      return record(BRT_CELL_ERROR, [...header, cell.value]);
  }
}

function sheetPart(sheet: XlsbSheet): Uint8Array {
  return Uint8Array.from(
    sheet.rows.flatMap((row) => [
      ...record(BRT_ROW_HDR, [...u32(row.row), ...new Array(13).fill(0)]),
      ...row.cells.flatMap(cellRecord),
    ]),
  );
}

export function buildXlsb(sheets: readonly XlsbSheet[], shared: readonly string[] = []): Uint8Array {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": text(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>' +
        '<Override PartName="/xl/sharedStrings.bin" ContentType="application/vnd.ms-excel.sharedStrings"/>' +
        sheets
          .map((_sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.bin" ContentType="application/vnd.ms-excel.worksheet"/>`)
          .join("") +
        "</Types>",
    ),
    "_rels/.rels": text(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.bin"/></Relationships>',
    ),
    "xl/_rels/workbook.bin.rels": text(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (_sheet, index) =>
              `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.bin"/>`,
          )
          .join("") +
        `<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.bin"/>` +
        "</Relationships>",
    ),
    "xl/workbook.bin": Uint8Array.from(
      sheets.flatMap((sheet, index) => record(BRT_BUNDLE_SH, [...u32(0), ...u32(index + 1), ...wide(`rId${index + 1}`), ...wide(sheet.name)])),
    ),
    "xl/sharedStrings.bin": Uint8Array.from(shared.flatMap((value) => record(BRT_SST_ITEM, [0, ...wide(value)]))),
  };
  sheets.forEach((sheet, index) => (files[`xl/worksheets/sheet${index + 1}.bin`] = sheetPart(sheet)));
  return zipSync(files);
}
