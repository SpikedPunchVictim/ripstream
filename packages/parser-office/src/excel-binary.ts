import {
  EncryptedDocumentError,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { CompoundFile, hasSignature, isEncryptedCompound } from "./cfb.ts";
import { formatExcelDate, isDateFormat } from "./excel-format.ts";

const XLS = "application/vnd.ms-excel";

interface BiffRecord {
  readonly type: number;
  readonly data: Uint8Array;
}

interface BoundSheet {
  readonly name: string;
  readonly offset: number;
}

interface Cell {
  readonly value: string;
  readonly numFmtId: number;
  readonly numeric: boolean;
}

/** Excel 5/95/97-2003 BIFF binary (.xls) text extraction. */
export class ExcelBinaryParser implements Parser {
  readonly name = "ExcelParser";
  readonly capabilities = { requiresRandomAccess: true, unsafe: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse(XLS)!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }

    if (!hasSignature(data)) {
      const text = legacyBiffText(data);
      if (text.length === 0) {
        throw new MalformedDocumentError("Not a binary Excel document");
      }
      const xhtml = new XHTMLContentHandler(handler, metadata);
      await xhtml.startDocument();
      for (const line of text.split("\n")) {
        if (line.trim().length > 0) await xhtml.element("p", line);
      }
      await xhtml.endDocument();
      return;
    }
    const compound = CompoundFile.parse(data);
    if (isEncryptedCompound(compound)) {
      throw new EncryptedDocumentError("Excel document is encrypted");
    }
    const name = compound.has("Workbook")
      ? "Workbook"
      : compound.has("Book")
        ? "Book"
        : undefined;
    if (name === undefined) {
      throw new MalformedDocumentError("Missing Excel workbook stream");
    }

    const workbook = compound.read(name);
    const sheets = readWorkbook(workbook);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const sheet of sheets) {
      await xhtml.startElement("div", "class", "sheet");
      await xhtml.startElement("h1");
      await xhtml.characters(sheet.name);
      await xhtml.endElement("h1");
      await xhtml.startElement("table");
      for (const row of sheet.rows) {
        await xhtml.startElement("tr");
        for (const cell of row) {
          await xhtml.startElement("td");
          if (cell.value.length > 0) await xhtml.characters(cell.value);
          await xhtml.endElement("td");
        }
        await xhtml.endElement("tr");
      }
      await xhtml.endElement("table");
      await xhtml.endElement("div");
    }
    await xhtml.endDocument();
  }
}

interface Sheet {
  readonly name: string;
  readonly rows: readonly (readonly Cell[])[];
}

function readWorkbook(workbook: Uint8Array): Sheet[] {
  const records = readRecords(workbook);
  const first = records[0];
  const biff8 =
    first !== undefined &&
    first.type === 0x0809 &&
    readUInt16(first.data, 0) >= 0x0600;

  let codepage = 1252;
  let date1904 = false;
  const boundSheets: BoundSheet[] = [];
  const formats = new Map<number, string>();
  const xfFormats: number[] = [];
  let sst: string[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    switch (record.type) {
      case 0x0022:
        date1904 = readUInt16(record.data, 0) === 1;
        break;
      case 0x0042:
        codepage = readUInt16(record.data, 0);
        break;
      case 0x0085:
        boundSheets.push(readBoundSheet(record.data, biff8, codepage));
        break;
      case 0x041e:
        formats.set(
          readUInt16(record.data, 0),
          biff8
            ? readBiff8String(record.data, 2, codepage)
            : readAnsi(record.data, 3, record.data[2] ?? 0, codepage),
        );
        break;
      case 0x00e0:
        xfFormats.push(readUInt16(record.data, 2));
        break;
      case 0x00fc: {
        const chunks = [record.data];
        let cursor = index + 1;
        while (
          cursor < records.length &&
          records[cursor]!.type === 0x003c
        ) {
          chunks.push(records[cursor]!.data);
          cursor++;
        }
        sst = readSst(chunks, codepage);
        index = cursor - 1;
        break;
      }
      case 0x000a:
        break;
      default:
        break;
    }
  }

  const sheets: Sheet[] = [];
  // Records are offset-sorted, so binary search finds each sheet start in O(log N);
  // identical starts are memoized and each sheet is bounded by the next sheet's start.
  const starts = [...new Set(boundSheets.map((b) => firstRecordAt(records, b.offset)))]
    .filter((s) => s !== -1)
    .sort((a, b) => a - b);
  const stopFor = new Map(starts.map((s, i) => [s, starts[i + 1] ?? records.length]));
  const rowsByStart = new Map<number, Sheet["rows"]>();
  for (const bound of boundSheets) {
    const start = firstRecordAt(records, bound.offset);
    if (start === -1) continue;
    let rows = rowsByStart.get(start);
    if (rows === undefined) {
      const cells = readSheet(
        records,
        start,
        stopFor.get(start)!,
        biff8,
        codepage,
        formats,
        xfFormats,
        sst,
      );
      rows = toRows(cells, date1904, formats);
      rowsByStart.set(start, rows);
    }
    sheets.push({ name: bound.name, rows });
  }
  return sheets;
}

interface RecordWithOffset extends BiffRecord {
  readonly offset: number;
}

function firstRecordAt(records: RecordWithOffset[], offset: number): number {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (records[mid]!.offset < offset) low = mid + 1;
    else high = mid;
  }
  return low === records.length ? -1 : low;
}

function readRecords(data: Uint8Array): RecordWithOffset[] {
  const records: RecordWithOffset[] = [];
  let offset = 0;
  while (offset + 4 <= data.byteLength && records.length < 2_000_000) {
    const type = readUInt16(data, offset);
    const length = readUInt16(data, offset + 2);
    if (offset + 4 + length > data.byteLength) break;
    records.push({
      type,
      data: data.subarray(offset + 4, offset + 4 + length),
      offset,
    });
    offset += 4 + length;
  }
  return records;
}

function readBoundSheet(
  data: Uint8Array,
  biff8: boolean,
  codepage: number,
): BoundSheet {
  const offset = readUInt32(data, 0);
  const length = data[6] ?? 0;
  const name = biff8 && (data[7] ?? 0) === 1
    ? new TextDecoder("utf-16le").decode(data.subarray(8, 8 + length * 2))
    : readAnsi(data, biff8 ? 8 : 7, length, codepage);
  return { name, offset };
}

function readSheet(
  records: RecordWithOffset[],
  start: number,
  stop: number,
  biff8: boolean,
  codepage: number,
  formats: Map<number, string>,
  xfFormats: number[],
  sst: string[],
): Map<number, Map<number, Cell>> {
  const cells = new Map<number, Map<number, Cell>>();
  let pendingRow = -1;
  let pendingColumn = -1;
  let pendingFormat = 0;

  const put = (row: number, column: number, cell: Cell): void => {
    let values = cells.get(row);
    if (values === undefined) {
      values = new Map();
      cells.set(row, values);
    }
    values.set(column, cell);
  };

  const formatFor = (xf: number): number => xfFormats[xf] ?? 0;

  for (let index = start; index < stop; index++) {
    const record = records[index]!;
    if (record.type === 0x000a) break;

    switch (record.type) {
      case 0x00fd:
        put(
          readUInt16(record.data, 0),
          readUInt16(record.data, 2),
          {
            value: sst[readUInt32(record.data, 6)] ?? "",
            numFmtId: formatFor(readUInt16(record.data, 4)),
            numeric: false,
          },
        );
        break;
      case 0x0204:
      case 0x00d6:
        put(
          readUInt16(record.data, 0),
          readUInt16(record.data, 2),
          {
            value: biff8
              ? readBiff8String(record.data, 6, codepage)
              : readAnsi(
                  record.data,
                  8,
                  readUInt16(record.data, 6),
                  codepage,
                ),
            numFmtId: formatFor(readUInt16(record.data, 4)),
            numeric: false,
          },
        );
        break;
      case 0x0203:
        put(
          readUInt16(record.data, 0),
          readUInt16(record.data, 2),
          {
            value: String(readDouble(record.data, 6)),
            numFmtId: formatFor(readUInt16(record.data, 4)),
            numeric: true,
          },
        );
        break;
      case 0x027e:
        put(
          readUInt16(record.data, 0),
          readUInt16(record.data, 2),
          {
            value: String(decodeRk(readUInt32(record.data, 6))),
            numFmtId: formatFor(readUInt16(record.data, 4)),
            numeric: true,
          },
        );
        break;
      case 0x00bd: {
        const row = readUInt16(record.data, 0);
        const firstColumn = readUInt16(record.data, 2);
        const count = Math.floor((record.data.byteLength - 6) / 6);
        for (let slot = 0; slot < count; slot++) {
          const offset = 4 + slot * 6;
          put(row, firstColumn + slot, {
            value: String(decodeRk(readUInt32(record.data, offset + 2))),
            numFmtId: formatFor(readUInt16(record.data, offset)),
            numeric: true,
          });
        }
        break;
      }
      case 0x0205:
        put(
          readUInt16(record.data, 0),
          readUInt16(record.data, 2),
          {
            value:
              record.data[7] === 1
                ? `#ERROR`
                : record.data[6] === 1
                  ? "TRUE"
                  : "FALSE",
            numFmtId: formatFor(readUInt16(record.data, 4)),
            numeric: false,
          },
        );
        break;
      case 0x0006: {
        const row = readUInt16(record.data, 0);
        const column = readUInt16(record.data, 2);
        const format = formatFor(readUInt16(record.data, 4));
        const special =
          record.data[12] === 0xff && record.data[13] === 0xff;
        if (!special) {
          put(row, column, {
            value: String(readDouble(record.data, 6)),
            numFmtId: format,
            numeric: true,
          });
        } else if (record.data[6] === 0) {
          pendingRow = row;
          pendingColumn = column;
          pendingFormat = format;
        } else if (record.data[6] === 1) {
          put(row, column, {
            value: record.data[8] === 1 ? "TRUE" : "FALSE",
            numFmtId: format,
            numeric: false,
          });
        } else if (record.data[6] === 2) {
          put(row, column, {
            value: "#ERROR",
            numFmtId: format,
            numeric: false,
          });
        }
        break;
      }
      case 0x0207:
        if (pendingRow >= 0 && pendingColumn >= 0) {
          const value = biff8
            ? readBiff8String(record.data, 0, codepage)
            : readAnsi(record.data, 3, record.data[0] ?? 0, codepage);
          put(pendingRow, pendingColumn, {
            value,
            numFmtId: pendingFormat,
            numeric: false,
          });
          pendingRow = -1;
          pendingColumn = -1;
        }
        break;
      default:
        break;
    }
  }
  return cells;
}

const MAX_COLUMNS = 16_384;
/** Cap on materialized (real plus padding) cells per sheet. */
const MAX_SHEET_CELLS = 1_000_000;

function toRows(
  cells: Map<number, Map<number, Cell>>,
  date1904: boolean,
  formats: Map<number, string>,
): Cell[][] {
  const rows: Cell[][] = [];
  let totalCells = 0;
  const rowNumbers = [...cells.keys()].sort((a, b) => a - b);
  for (const rowNumber of rowNumbers) {
    const values = cells.get(rowNumber)!;
    const columns = [...values.keys()].sort((a, b) => a - b);
    const last = columns[columns.length - 1] ?? 0;
    if (last >= MAX_COLUMNS) {
      throw new MalformedDocumentError(`Excel cell column out of range: ${last}`);
    }
    totalCells += last + 1;
    if (totalCells > MAX_SHEET_CELLS) {
      throw new LimitExceededError(`Excel sheet exceeds ${MAX_SHEET_CELLS} cells`);
    }
    const row: Cell[] = [];
    for (let column = 0; column <= last; column++) {
      const cell = values.get(column);
      row.push(
        cell === undefined
          ? { value: "", numFmtId: 0, numeric: false }
          : { ...cell, value: formatCell(cell, date1904, formats) },
      );
    }
    rows.push(row);
  }
  return rows;
}

function formatCell(
  cell: Cell,
  date1904: boolean,
  formats: Map<number, string>,
): string {
  if (!cell.numeric || cell.value.length === 0) return cell.value;
  const value = Number(cell.value);
  if (!Number.isFinite(value)) return cell.value;
  if (!dateFmt(cell.numFmtId, formats)) return cell.value;
  return formatExcelDate(value + (date1904 ? 1462 : 0));
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function dateFmt(
  numFmtId: number,
  formats: Map<number, string>,
): boolean {
  if (BUILTIN_DATE_FORMATS.has(numFmtId)) return true;
  const custom = formats.get(numFmtId);
  return custom !== undefined && isDateFormat(custom);
}

function decodeRk(rk: number): number {
  let value: number;
  if ((rk & 0x02) !== 0) {
    value = rk >> 2;
  } else {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setUint32(4, (rk & 0xfffffffc) >>> 0, true);
    value = new DataView(buffer).getFloat64(0, true);
  }
  return (rk & 0x01) !== 0 ? value / 100 : value;
}

function readBiff8String(
  data: Uint8Array,
  offset: number,
  codepage: number,
): string {
  const length = readUInt16(data, offset);
  const flags = data[offset + 2] ?? 0;
  let position = offset + 3;
  if ((flags & 0x08) !== 0) position += 2;
  if ((flags & 0x04) !== 0) position += 4;
  if ((flags & 0x01) !== 0) {
    return new TextDecoder("utf-16le").decode(
      data.subarray(position, position + length * 2),
    );
  }
  return readAnsi(data, position, length, codepage);
}

function readAnsi(
  data: Uint8Array,
  offset: number,
  length: number,
  codepage: number,
): string {
  const bytes = data.subarray(offset, offset + length);
  try {
    return new TextDecoder(encodingFor(codepage)).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function encodingFor(codepage: number): string {
  if (codepage === 65001) return "utf-8";
  // CODEPAGE 1200 (UTF-16) is what every Excel 97+ file declares. It describes the
  // uncompressed strings, which carry their own flag; an 8-bit ("compressed") string
  // is Latin-1, never UTF-16 (POI: StringUtil.getFromCompressedUnicode).
  if (codepage === 1200) return "windows-1252";
  if (codepage === 932) return "shift_jis";
  if (codepage === 936) return "gbk";
  if (codepage === 949) return "euc-kr";
  if (codepage === 950) return "big5";
  return codepage >= 1250 && codepage <= 1258
    ? `windows-${codepage}`
    : "windows-1252";
}

// ---------------------------------------------------------------------------
// Shared string table (SST + CONTINUE)
// ---------------------------------------------------------------------------

function readSst(chunks: Uint8Array[], codepage: number): string[] {
  const cursor = new ChunkCursor(chunks);
  if (cursor.remaining < 8) return [];
  cursor.skip(4);
  const unique = cursor.readUInt32();
  if (unique > 1_000_000) return [];

  const strings: string[] = [];
  for (let index = 0; index < unique && cursor.available; index++) {
    if (cursor.remaining < 3) break;
    const length = cursor.readUInt16();
    const flags = cursor.readByte();
    const rich = (flags & 0x08) !== 0;
    const extended = (flags & 0x04) !== 0;
    const runs = rich ? cursor.readUInt16() : 0;
    const extendedSize = extended ? cursor.readUInt32() : 0;
    const characters: string[] = [];
    let high = (flags & 0x01) !== 0;

    let remaining = length;
    while (remaining > 0 && cursor.available) {
      const take = Math.min(remaining, cursor.charsAvailable(high));
      if (take <= 0) {
        high = cursor.nextChunkFlag();
        continue;
      }
      characters.push(cursor.readChars(take, high, codepage));
      remaining -= take;
      if (remaining > 0) high = cursor.nextChunkFlag();
    }
    cursor.skip(runs * 4);
    cursor.skip(extendedSize);
    strings.push(characters.join(""));
  }
  return strings;
}

class ChunkCursor {
  readonly #chunks: Uint8Array[];
  #chunk = 0;
  #position = 0;

  constructor(chunks: Uint8Array[]) {
    this.#chunks = chunks;
  }

  get available(): boolean {
    return this.#normalize();
  }

  get remaining(): number {
    if (!this.#normalize()) return 0;
    return this.#chunks[this.#chunk]!.byteLength - this.#position;
  }

  readByte(): number {
    if (!this.#normalize()) return 0;
    return this.#chunks[this.#chunk]![this.#position++] ?? 0;
  }

  readUInt16(): number {
    return this.readByte() | (this.readByte() << 8);
  }

  readUInt32(): number {
    return (
      (this.readByte() |
        (this.readByte() << 8) |
        (this.readByte() << 16) |
        (this.readByte() << 24)) >>>
      0
    );
  }

  skip(count: number): void {
    let remaining = count;
    while (remaining > 0 && this.#normalize()) {
      const available = this.#chunks[this.#chunk]!.byteLength - this.#position;
      const take = Math.min(available, remaining);
      this.#position += take;
      remaining -= take;
    }
  }

  charsAvailable(high: boolean): number {
    if (!this.#normalize()) return 0;
    const available = this.#chunks[this.#chunk]!.byteLength - this.#position;
    return Math.floor(available / (high ? 2 : 1));
  }

  nextChunkFlag(): boolean {
    if (!this.#normalize()) return false;
    return (this.#chunks[this.#chunk]![this.#position++]! & 0x01) !== 0;
  }

  readChars(count: number, high: boolean, codepage: number): string {
    if (!this.#normalize()) return "";
    const chunk = this.#chunks[this.#chunk]!;
    const bytes = high ? count * 2 : count;
    const slice = chunk.subarray(this.#position, this.#position + bytes);
    this.#position += bytes;
    return high
      ? new TextDecoder("utf-16le").decode(slice)
      : readAnsi(slice, 0, slice.byteLength, codepage);
  }

  #normalize(): boolean {
    while (
      this.#chunk < this.#chunks.length &&
      this.#position >= this.#chunks[this.#chunk]!.byteLength
    ) {
      this.#chunk++;
      this.#position = 0;
    }
    return this.#chunk < this.#chunks.length;
  }
}

function readDouble(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getFloat64(
    0,
    true,
  );
}

function readUInt16(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readUInt32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) |
    ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16) |
    ((data[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function legacyBiffText(data: Uint8Array): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const values: string[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    if (length > data.length - offset - 4) break;
    const payload = data.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
    if (type === 0x0002 && payload.length >= 8) {
      values.push(String(view.getUint16(offset - length + 0, true)));
    } else if (type === 0x0003 && payload.length >= 12) {
      values.push(String(new DataView(payload.buffer, payload.byteOffset).getFloat64(6, true)));
    } else if (type === 0x0004 || type === 0x0204) {
      const start = type === 0x0204 ? 8 : 7;
      const count = type === 0x0204
        ? new DataView(payload.buffer, payload.byteOffset).getUint16(6, true)
        : payload[6] ?? 0;
      const text = new TextDecoder("windows-1252").decode(
        payload.subarray(start, start + count),
      ).trim();
      if (text.length > 0) values.push(text);
    }
  }
  return values.join("\n");
}
