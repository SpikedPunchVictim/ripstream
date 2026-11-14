import {
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { OpcPackage } from "./opc.ts";

const XLSB = "application/vnd.ms-excel.sheet.binary.macroenabled.12";

/** BIFF12 record ids used here (POI's XSSFBRecordType). */
const BRT_ROW_HDR = 0;
const BRT_CELL_RK = 2;
const BRT_CELL_BOOL = 4;
const BRT_CELL_REAL = 5;
const BRT_CELL_ST = 6;
const BRT_CELL_ISST = 7;
const BRT_FMLA_STRING = 8;
const BRT_BUNDLE_SH = 156;
const BRT_SST_ITEM = 19;

/**
 * XLSB (binary workbook) text: shared strings, sheet cell values and the sheet names, read from the BIFF12 records
 * of the OPC parts. Formulas are not evaluated; a formula cell contributes its cached string or number where one is
 * stored.
 */
export class XlsbParser implements Parser {
  readonly name = "XSSFBParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([XLSB, "application/vnd.ms-excel.sheet.binary.macroEnabled.12"].map((type) => MediaType.parse(type)!));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const part = await OpcPackage.open(stream, ctx.limits);
    let files: Map<string, Uint8Array>;
    try {
      const names = part.names.filter((name) =>
        name === "xl/workbook.bin" || name === "xl/sharedStrings.bin"
        || name === "xl/_rels/workbook.bin.rels" || /^xl\/worksheets\/sheet\d+\.bin$/.test(name),
      );
      files = new Map();
      for (const name of names) files.set(name, await part.read(name));
    } finally {
      await part.close();
    }

    const shared = sharedStrings(files.get("xl/sharedStrings.bin"));
    const sheets = workbookSheets(files.get("xl/workbook.bin"), files.get("xl/_rels/workbook.bin.rels"));
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const sheet of sheets) {
      const data = files.get(sheet.part);
      if (data === undefined) continue;
      await xhtml.startElement("div", "class", "sheet");
      if (sheet.name.length > 0) await xhtml.element("h1", sheet.name);
      await xhtml.startElement("table");
      for (const row of sheetRows(data, shared)) {
        await xhtml.startElement("tr");
        for (const value of row) await xhtml.element("td", value);
        await xhtml.endElement("tr");
      }
      await xhtml.endElement("table");
      await xhtml.endElement("div");
    }
    await xhtml.endDocument();
  }
}

interface Record {
  readonly type: number;
  readonly data: Uint8Array;
}

/** BIFF12 record framing: a 1- or 2-byte 7-bit type, then a 1-4 byte 7-bit length. */
function* records(data: Uint8Array): Generator<Record> {
  let position = 0;
  while (position < data.length) {
    let first = data[position++]!;
    let type = first & 0x7f;
    if ((first & 0x80) !== 0) {
      if (position >= data.length) return;
      type |= (data[position++]! & 0x7f) << 7;
    }
    let length = 0;
    let shift = 0;
    let complete = false;
    for (let index = 0; index < 4; index++) {
      if (position >= data.length) return;
      const byte = data[position++]!;
      length |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) {
        complete = true;
        break;
      }
    }
    if (!complete || position + length > data.length) return;
    yield { type, data: data.subarray(position, position + length) };
    position += length;
  }
}

function readU32(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16) | ((data[offset + 3] ?? 0) << 24);
}

/** An XLWideString: a 32-bit character count, then UTF-16LE; 0xFFFFFFFF means null. */
function readWideString(data: Uint8Array, offset: number): { value: string; next: number } {
  if (offset + 4 > data.length) return { value: "", next: data.length };
  const count = readU32(data, offset);
  if (count === 0xffffffff) return { value: "", next: offset + 4 };
  const start = offset + 4;
  const end = Math.min(data.length, start + count * 2);
  return { value: new TextDecoder("utf-16le").decode(data.subarray(start, end)), next: end };
}

function sharedStrings(data: Uint8Array | undefined): string[] {
  const strings: string[] = [];
  if (data === undefined) return strings;
  for (const record of records(data)) {
    if (record.type !== BRT_SST_ITEM) continue;
    // A flag byte, then the wide string; rich-text runs and phonetic data are not needed for the text.
    strings.push(readWideString(record.data, 1).value);
  }
  return strings;
}

interface Sheet {
  readonly name: string;
  readonly part: string;
}

function workbookSheets(workbook: Uint8Array | undefined, relationships: Uint8Array | undefined): Sheet[] {
  if (workbook === undefined) return [];
  const targets = new Map<string, string>();
  if (relationships !== undefined) {
    const text = new TextDecoder("latin1").decode(relationships);
    for (const tag of text.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]+)"/.exec(tag[0])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(tag[0])?.[1];
      if (id !== undefined && target !== undefined) {
        targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
      }
    }
  }
  const sheets: Sheet[] = [];
  let position = 0;
  let index = 1;
  for (const record of records(workbook)) {
    if (record.type !== BRT_BUNDLE_SH) continue;
    position = 8; // sheet state and tab id
    const relation = readWideString(record.data, position);
    const name = readWideString(record.data, relation.next);
    const part = targets.get(relation.value) ?? `xl/worksheets/sheet${index}.bin`;
    sheets.push({ name: name.value, part });
    index++;
  }
  return sheets;
}

function sheetRows(data: Uint8Array, shared: readonly string[]): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  for (const record of records(data)) {
    if (record.type === BRT_ROW_HDR) {
      if (row.length > 0) rows.push(row);
      row = [];
      continue;
    }
    if (record.data.length < 8) continue;
    const value = cellValue(record, shared);
    if (value !== null && value.length > 0) row.push(value);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

function cellValue(record: Record, shared: readonly string[]): string | null {
  const data = record.data;
  switch (record.type) {
    case BRT_CELL_ST:
      return readWideString(data, 9).value;
    case BRT_CELL_ISST: {
      const index = readU32(data, 8);
      return shared[index] ?? null;
    }
    case BRT_CELL_REAL:
      return numberText(new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(8, true));
    case BRT_CELL_RK:
      return numberText(readRk(readU32(data, 8)));
    case BRT_CELL_BOOL:
      return data[8] === 1 ? "true" : "false";
    case BRT_FMLA_STRING:
      return readCachedFormulaString(data);
    default:
      return null;
  }
}

/** An RK number: bit 0 means the value is divided by 100, bit 1 means the upper 30 bits are an integer. */
function readRk(value: number): number {
  const divided = (value & 1) !== 0;
  let number: number;
  if ((value & 2) !== 0) {
    number = (value | 0) >> 2;
  } else {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setUint32(4, value & 0xffff_fffc, true);
    number = view.getFloat64(0, true);
  }
  return divided ? number / 100 : number;
}

function numberText(value: number): string {
  return String(value);
}

/** A formula's cached string sits after its parsed expression; the cell text is the wide string at the end. */
function readCachedFormulaString(data: Uint8Array): string | null {
  for (let offset = 8; offset + 4 <= data.length; offset++) {
    const length = readU32(data, offset);
    if (length !== 0xffffffff && offset + 4 + length * 2 === data.length) {
      return new TextDecoder("utf-16le").decode(data.subarray(offset + 4));
    }
  }
  return null;
}
