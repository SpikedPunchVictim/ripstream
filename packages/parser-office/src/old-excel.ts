import {
  EncryptedDocumentError,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  signalCheckpoint,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { readAll } from "./bytes.ts";
import {
  MAX_BIFF_RECORDS,
  MAX_SHEET_CELLS,
  decodeRk,
  readAnsi,
  readDouble,
  readUInt16,
  readUInt32,
} from "./biff-bytes.ts";
import { javaDoubleString } from "@spikedpunch/ripstream-core";

const TYPES = [
  "application/vnd.ms-excel.sheet.2",
  "application/vnd.ms-excel.sheet.3",
  "application/vnd.ms-excel.sheet.4",
  "application/vnd.ms-excel.workspace.3",
  "application/vnd.ms-excel.workspace.4",
];

type Biff = 2 | 3 | 4 | 5;

/** The BOF record id that opens a stream of each BIFF version. */
const BOF_IDS = new Map<number, Biff>([
  [0x0009, 2],
  [0x0209, 3],
  [0x0409, 4],
]);

type CellKind = "integer" | "number" | "label" | "formula" | "string" | "rk" | "codepage" | "sheet" | "filepass";

/*
 * Record ids per version. BIFF2 numbers its records from 0x0001; BIFF3 and BIFF4 add 0x0200 (and BIFF4 moves FORMULA to
 * 0x0406). A record of another version's id in the stream is not text and is passed over.
 */
const CELL_IDS: Record<Biff, ReadonlyMap<number, CellKind>> = {
  // BIFF5 and BIFF7 (Excel 5 and 95, a stream named Book in an OLE2 container): BIFF4's ids but for the formula's own, and a
  // BOUNDSHEET for each sheet, which OldExcelExtractor writes as a "Sheet:" line.
  5: new Map([
    [0x0203, "number"],
    [0x0204, "label"],
    [0x0006, "formula"],
    [0x0207, "string"],
    [0x027e, "rk"],
    [0x0042, "codepage"],
    [0x0085, "sheet"],
    [0x002f, "filepass"],
  ]),
  2: new Map([
    [0x0002, "integer"],
    [0x0003, "number"],
    [0x0004, "label"],
    [0x0006, "formula"],
    [0x0007, "string"],
    [0x0042, "codepage"],
  ]),
  3: new Map([
    [0x0203, "number"],
    [0x0204, "label"],
    [0x0206, "formula"],
    [0x0207, "string"],
    [0x027e, "rk"],
    [0x0042, "codepage"],
  ]),
  4: new Map([
    [0x0203, "number"],
    [0x0204, "label"],
    [0x0406, "formula"],
    [0x0207, "string"],
    [0x027e, "rk"],
    [0x0042, "codepage"],
  ]),
};

const DEFAULT_CODEPAGE = 1252;

export interface OldExcelOptions {
  /** Most text-bearing cells one file may hold before it is refused; defaults to the cap the .xls parser uses. */
  readonly maxCells?: number;
  /** Most BIFF records one file may hold before it is refused; defaults to the cap the .xls parser uses. */
  readonly maxRecords?: number;
}

interface BiffRecord {
  readonly id: number;
  readonly data: Uint8Array;
}

interface ReadState {
  codepage: number;
  /** A formula with a string result was read, and its STRING record has not come yet. */
  stringPending: boolean;
}

/**
 * Tika's OldExcelParser: Excel 2, 3 and 4 worksheets and workspaces, from before Excel kept its files in OLE2 containers.
 * POI's OldExcelExtractor writes the text of the file as one string, a line per cell, and the parser makes a <p> of every
 * line. These formats keep no metadata, and Tika sets none.
 *
 * Written from the published BIFF2-4 record layouts, with Tika's OldExcelParserTest as the check on the text:
 * OldExcelExtractor's own source is not among those read, so which records it leaves out (booleans, errors, blanks) is
 * inferred, not read.
 */
export class OldExcelParser implements Parser {
  readonly name = "OldExcelParser";
  readonly capabilities = { requiresRandomAccess: true } as const;
  readonly #maxCells: number;
  readonly #maxRecords: number;

  constructor(options: OldExcelOptions = {}) {
    this.#maxCells = options.maxCells ?? MAX_SHEET_CELLS;
    this.#maxRecords = options.maxRecords ?? MAX_BIFF_RECORDS;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(TYPES.map((type) => MediaType.parseOrThrow(type)));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    const version = biffVersion(data);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await writeCellLines(xhtml, cellTexts(data, version, ctx, this.#maxCells, this.#maxRecords));
    await xhtml.endDocument();
  }
}

/**
 * What OldExcelExtractor writes for the Book stream of a BIFF5 or BIFF7 workbook in an OLE2 container (Tika's OfficeParser
 * reads a container that has Book and no Workbook that way): a line for each sheet name, then a line for each cell.
 */
export async function writeBiff5Text(
  xhtml: XHTMLContentHandler,
  book: Uint8Array,
  ctx: ParseContext,
): Promise<void> {
  await writeCellLines(xhtml, cellTexts(book, 5, ctx, MAX_SHEET_CELLS, MAX_BIFF_RECORDS));
}

async function writeCellLines(xhtml: XHTMLContentHandler, texts: Iterable<string>): Promise<void> {
  for (const text of texts) {
    for (const line of linesOf(text)) await writeParagraph(xhtml, line);
  }
}

/** The text of each cell, in file order, bounded by the bytes present, the record cap and the cell cap. */
function* cellTexts(
  data: Uint8Array,
  version: Biff,
  ctx: ParseContext,
  maxCells: number,
  maxRecords: number,
): Generator<string> {
  const tick = signalCheckpoint(ctx, 256);
  const kinds = CELL_IDS[version];
  const state: ReadState = { codepage: DEFAULT_CODEPAGE, stringPending: false };
  let cells = 0;
  for (const record of readRecords(data, maxRecords, version === 5)) {
    tick();
    const kind = kinds.get(record.id);
    if (kind === undefined) continue;
    const text = textOf(kind, version, record, state);
    if (text === undefined) continue;
    if (++cells > maxCells) throw new LimitExceededError(`Excel sheet exceeds ${maxCells} cells`);
    yield text;
  }
}

/** The BIFF version a stream's first record (a BOF) names; anything else is not a BIFF2-4 file. */
function biffVersion(data: Uint8Array): Biff {
  const version = data.byteLength < 4 ? undefined : BOF_IDS.get(readUInt16(data, 0));
  if (version === undefined) throw new MalformedDocumentError("Not a BIFF2, BIFF3 or BIFF4 Excel stream");
  return version;
}

/** The records of a stream, each taken from the bytes present: one that runs past the end is malformed. */
function* readRecords(data: Uint8Array, maxRecords: number, padded: boolean): Generator<BiffRecord> {
  let offset = 0;
  let count = 0;
  while (offset < data.byteLength) {
    // A stream of an OLE2 container ends in the padding of its last sector, which may be too short for a header.
    if (padded && offset + 4 > data.byteLength) return;
    if (offset + 4 > data.byteLength) throw new MalformedDocumentError(`BIFF record header cut short at byte ${offset}`);
    const id = readUInt16(data, offset);
    const end = offset + 4 + readUInt16(data, offset + 2);
    if (end > data.byteLength) {
      throw new MalformedDocumentError(`BIFF record 0x${id.toString(16)} at byte ${offset} runs past the end of the data`);
    }
    if (++count > maxRecords) throw new LimitExceededError(`Excel stream exceeds ${maxRecords} records`);
    yield { id, data: data.subarray(offset + 4, end) };
    offset = end;
  }
}

/** What a record writes, or undefined when it writes nothing. */
function textOf(kind: CellKind, version: Biff, record: BiffRecord, state: ReadState): string | undefined {
  // The value follows the cell's row and column and, in BIFF2, three attribute bytes, in BIFF3 and 4, a two-byte XF index.
  const valueAt = version === 2 ? 7 : 6;
  switch (kind) {
    case "filepass":
      throw new EncryptedDocumentError("Unable to process: document is encrypted");
    case "sheet": {
      // Offset of the sheet's records (4 bytes), visibility and type (1 each), then a one-byte length and the name.
      requireBytes(record, 7);
      const length = record.data[6]!;
      requireBytes(record, 7 + length);
      return `Sheet: ${readAnsi(record.data, 7, length, state.codepage)}`;
    }
    case "codepage":
      requireBytes(record, 2);
      state.codepage = readUInt16(record.data, 0);
      return undefined;
    case "integer":
      requireBytes(record, valueAt + 2);
      return javaDoubleString(readUInt16(record.data, valueAt));
    case "number":
      requireBytes(record, valueAt + 8);
      return javaDoubleString(readDouble(record.data, valueAt));
    case "rk":
      requireBytes(record, valueAt + 4);
      return javaDoubleString(decodeRk(readUInt32(record.data, valueAt)));
    case "label":
      return stringAt(record, valueAt, version, state);
    case "formula":
      return formulaText(record, valueAt, state);
    case "string": {
      if (!state.stringPending) return undefined;
      state.stringPending = false;
      return stringAt(record, 0, version, state);
    }
  }
}

/**
 * A formula writes its cached result. A number is stored as a double; a string, boolean, error or empty result puts 0xFFFF
 * in the double's last two bytes and its kind in the first. Only a string result is text, and the string comes in the STRING
 * record after the formula.
 */
function formulaText(record: BiffRecord, valueAt: number, state: ReadState): string | undefined {
  requireBytes(record, valueAt + 8);
  state.stringPending = false;
  const result = record.data.subarray(valueAt, valueAt + 8);
  if (result[6] !== 0xff || result[7] !== 0xff) return javaDoubleString(readDouble(result, 0));
  state.stringPending = result[0] === 0;
  return undefined;
}

/** A length-prefixed string at `offset`: one length byte in BIFF2, two in BIFF3 and 4, read inside the record or refused. */
function stringAt(record: BiffRecord, offset: number, version: Biff, state: ReadState): string {
  const lengthBytes = version === 2 ? 1 : 2;
  requireBytes(record, offset + lengthBytes);
  const length = version === 2 ? record.data[offset]! : readUInt16(record.data, offset);
  const start = offset + lengthBytes;
  requireBytes(record, start + length);
  return readAnsi(record.data, start, length, state.codepage);
}

function requireBytes(record: BiffRecord, needed: number): void {
  if (record.data.byteLength >= needed) return;
  throw new MalformedDocumentError(
    `BIFF record 0x${record.id.toString(16)} holds ${record.data.byteLength} bytes, fewer than the ${needed} its fields reach`,
  );
}

/** A <p> even for an empty line, as Tika writes one (`element` leaves an empty text out). */
async function writeParagraph(xhtml: XHTMLContentHandler, line: string): Promise<void> {
  await xhtml.startElement("p");
  await xhtml.characters(line);
  await xhtml.endElement("p");
}

/** The lines `BufferedReader.readLine` finds in `text` followed by a newline: \n, \r and \r\n end a line, and an empty one is a line. */
function linesOf(text: string): string[] {
  const lines = `${text}\n`.split(/\r\n|\r|\n/);
  lines.pop();
  return lines;
}
