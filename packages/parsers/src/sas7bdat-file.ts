import { LimitExceededError, MalformedDocumentError, UnsupportedFormatError } from "@spikedpunch/ripstream-core";
import { rdcDecompress, rleDecompress } from "./sas-compression.ts";

/*
 * A reader for SAS7BDAT files. Tika reads the format with parso, whose source was not available: nothing here is parso's code
 * or was checked against it. What is checked is the two files of Tika's SAS7BDATParserTest (testSAS.sas7bdat and
 * test-columnar.sas7bdat), read with a hex dump: both 32-bit, little-endian and uncompressed.
 *
 * The 64-bit and big-endian layouts and the RLE and RDC compressions are read as the pandas and ReadStat readers are remembered
 * to read them, with no file of any of those to check against (tikajs-68os.69). In the 64-bit layout every integer that is a
 * count or an offset is eight bytes wide and the page header and the subheader pointers grow with it; a big-endian file has
 * every integer and double the other way round; in a compressed file the rows are subheaders of the metadata pages, packed by
 * sas-compression.ts. Rows are also read from the mixed page (type 512) and from data pages (type 256), whose layout is the
 * published one, from memory, and no file here has one.
 *
 * Everything is bounded by the bytes present: pages are located by arithmetic and checked against the length of the file,
 * nothing is allocated by a declared count, the subheaders read are budgeted by the size of the file so that pointers pointing
 * at the same bytes cannot be read over and over, and the rows a compressed file inflates to are capped by what the caller
 * allows and by what a stream of that length can give.
 */

export type SasValue = number | string | null;

export interface SasFormat {
  readonly name: string;
  readonly width: number;
  readonly precision: number;
}

export interface SasColumn {
  readonly name: string;
  readonly label: string;
  readonly type: "numeric" | "character";
  /** Where the column starts in a row, and how many bytes it takes. */
  readonly offset: number;
  readonly width: number;
  readonly format: SasFormat | null;
}

export interface SasProperties {
  readonly name: string;
  readonly created: Date | null;
  readonly modified: Date | null;
  readonly pageCount: number;
  readonly columnCount: number;
  readonly rowCount: number;
  /** The charset name for the file's encoding byte, or null when the byte is not one this reader knows. */
  readonly encoding: string | null;
  readonly serverType: string;
  readonly sasRelease: string;
  readonly endian: "Little" | "Big";
  readonly bits: 32 | 64;
}

export interface SasReadOptions {
  /** Most bytes that the rows of a compressed file may inflate to, in all; the default is a hundred times the file and a megabyte. */
  readonly maxInflatedBytes?: number;
}

export interface SasFile {
  readonly properties: SasProperties;
  readonly columns: readonly SasColumn[];
  rows(): Generator<SasValue[]>;
}

const MAGIC = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc2, 0xea, 0x81, 0x60, 0xb3, 0x14, 0x11, 0xcf, 0xbd, 0x92, 0x08, 0x00, 0x09, 0xc7, 0x31, 0x8c,
  0x18, 0x1f, 0x10, 0x11,
];
/** The header fields this reader uses end before this; a header is 1024 bytes or more. */
const MIN_HEADER_LENGTH = 288;

const PAGE_META = 0;
const PAGE_DATA = 256;
const PAGE_MIX = [512, 640];
const PAGE_AMD = 1024;
const PAGE_METC = 16384;
const SUBHEADER_PAGES = new Set([PAGE_META, PAGE_AMD, PAGE_METC, ...PAGE_MIX]);
/** The pages whose subheaders can be rows, when the file is compressed. */
const PACKED_ROW_PAGES = new Set([PAGE_META, PAGE_METC]);

/** The first four bytes of a subheader, read as the file's integers; in a 64-bit file these are the low four of eight. */
const ROW_SIZE = 0xf7f7f7f7;
const COLUMN_SIZE = 0xf6f6f6f6;
const COLUMN_TEXT = 0xfffffffd;
const COLUMN_NAME = 0xffffffff;
const COLUMN_ATTRIBUTES = 0xfffffffc;
const FORMAT_AND_LABEL = 0xfffffbfe;
/** Subheaders that hold nothing this reader needs, and must not be taken for the rows of a compressed file. */
const SUBHEADER_COUNTS = 0xfffffc00;
const COLUMN_LIST = 0xfffffffe;
const KNOWN_SIGNATURES = new Set([
  ROW_SIZE, COLUMN_SIZE, COLUMN_TEXT, COLUMN_NAME, COLUMN_ATTRIBUTES, FORMAT_AND_LABEL, SUBHEADER_COUNTS, COLUMN_LIST,
]);

/** A subheader pointer's flags: the pointer to a truncated subheader, and the compression and type of a packed row. */
const POINTER_TRUNCATED = 1;
const POINTER_COMPRESSED = 4;
const POINTER_UNCOMPRESSED = 0;
const POINTER_TYPE_DATA = 1;

const COMPRESSION_LITERALS = new Map<string, "RLE" | "RDC">([
  ["SASYZCRL", "RLE"],
  ["SASYZCR2", "RDC"],
]);
/**
 * The most that one byte of RLE or RDC can inflate to: RLE's 0x70 and the commands beside it write up to 4112 bytes from two,
 * and RDC's from three bytes at most as many. A row longer than this many times the bytes it was packed in cannot be one.
 */
const MAX_INFLATION_PER_BYTE = 2056;
const DEFAULT_INFLATION_RATIO = 100;
const DEFAULT_INFLATION_SLACK = 1024 * 1024;

const SAS_EPOCH_MS = Date.UTC(1960, 0, 1);
const MAX_DATE_MS = 8.64e15;

/** The encoding byte at offset 70 of the header, for the bytes this reader knows (62 is the one the Tika test shows). */
const ENCODINGS = new Map<number, string>([
  [20, "UTF-8"],
  [29, "ISO-8859-1"],
  ...[60, 61, 62, 63, 64, 65, 66, 67, 68].map((byte): [number, string] => [byte, `windows-${1250 + byte - 60}`]),
]);
const FALLBACK_CHARSET = "windows-1252";

/** What the width of the integers and the byte order of the file change. */
interface Layout {
  readonly little: boolean;
  /** Bytes of a count or an offset: 4, or 8 in a 64-bit file. */
  readonly int: 4 | 8;
  /** Where the fields of a page's header start, 16 or 32; its subheader pointers start 8 bytes after. */
  readonly pageHeader: number;
  readonly pointersAt: number;
  readonly pointerSize: number;
}

interface Header {
  readonly layout: Layout;
  /** The four bytes that byte 35 adds to the fields from the timestamps on. */
  readonly alignment: number;
  /** What both the alignments add to the fields from the release on. */
  readonly totalAlignment: number;
  readonly headerLength: number;
  readonly pageLength: number;
  readonly pageCount: number;
}

interface Pointer {
  /** From the start of the page. */
  readonly offset: number;
  readonly length: number;
  readonly compression: number;
  readonly type: number;
}

interface TextReference {
  readonly block: number;
  readonly offset: number;
  readonly length: number;
}

interface FormatEntry {
  readonly format: TextReference;
  readonly label: TextReference;
  readonly width: number;
  readonly precision: number;
}

interface RawAttribute {
  readonly offset: number;
  readonly width: number;
  readonly type: "numeric" | "character";
}

interface Metadata {
  rowLength: number | null;
  rowCount: number;
  mixPageRowCount: number;
  columnCount: number | null;
  readonly texts: Uint8Array[];
  readonly names: TextReference[];
  readonly attributes: RawAttribute[];
  readonly formats: FormatEntry[];
}

export function readSasFile(data: Uint8Array, options: SasReadOptions = {}): SasFile {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const header = readHeader(data, view);
  const { layout } = header;
  const meta = scanSubheaders(data, view, header);
  const compression = compressionOf(meta);
  const charset = ENCODINGS.get(data[70]!) ?? null;
  const decoder = new TextDecoder(charset ?? FALLBACK_CHARSET);
  const columns = buildColumns(meta, decoder);

  const properties: SasProperties = {
    name: javaTrim(latin1(data.subarray(92, 156))),
    created: toDate(view.getFloat64(164 + header.alignment, layout.little)),
    modified: toDate(view.getFloat64(172 + header.alignment, layout.little)),
    pageCount: header.pageCount,
    columnCount: meta.columnCount ?? columns.length,
    rowCount: meta.rowCount,
    encoding: charset,
    serverType: javaTrim(latin1(data.subarray(224 + header.totalAlignment, 240 + header.totalAlignment))),
    sasRelease: javaTrim(latin1(data.subarray(216 + header.totalAlignment, 224 + header.totalAlignment))),
    endian: layout.little ? "Little" : "Big",
    bits: layout.int === 8 ? 64 : 32,
  };
  const maxInflated = options.maxInflatedBytes ?? data.length * DEFAULT_INFLATION_RATIO + DEFAULT_INFLATION_SLACK;
  // Each pass over the rows has its own count of what it has inflated.
  return { properties, columns, rows: () => readRows({ data, view, header, meta, columns, decoder, compression, maxInflated, inflated: 0 }) };
}

/** An integer of 1, 2, 4 or 8 bytes as a number; one of eight bytes that a number cannot hold is not a count of anything real. */
function readUint(view: DataView, at: number, size: number, little: boolean): number {
  if (size === 1) return view.getUint8(at);
  if (size === 2) return view.getUint16(at, little);
  if (size === 4) return view.getUint32(at, little);
  const value = view.getBigUint64(at, little);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new MalformedDocumentError("SAS7BDAT number is too large");
  return Number(value);
}

function readHeader(data: Uint8Array, view: DataView): Header {
  if (data.length < MIN_HEADER_LENGTH || !MAGIC.every((byte, index) => data[index] === byte)) {
    throw new MalformedDocumentError("Not a SAS7BDAT file");
  }
  if (data[37] !== 0 && data[37] !== 1) throw new MalformedDocumentError("SAS7BDAT has an unknown byte order");
  const little = data[37] === 1;
  const int = data[32] === 0x33 ? 8 : 4;
  const layout: Layout = { little, int, pageHeader: int === 8 ? 32 : 16, pointersAt: int === 8 ? 40 : 24, pointerSize: int === 8 ? 24 : 12 };

  // Byte 35 says the fields from the timestamps on are four bytes further in; byte 32, which says the file is 64-bit, adds
  // four more before the release.
  const alignment = data[35] === 0x33 ? 4 : 0;
  const totalAlignment = alignment + (int === 8 ? 4 : 0);
  const headerLength = view.getInt32(196 + alignment, little);
  const pageLength = view.getInt32(200 + alignment, little);
  const pageCount = readPageCount(view, 204 + alignment, layout);
  if (headerLength < MIN_HEADER_LENGTH || headerLength > data.length) throw new MalformedDocumentError("SAS7BDAT header length is not valid");
  if (pageLength < layout.pointersAt) throw new MalformedDocumentError("SAS7BDAT page length is not valid");
  // The declared pages are compared with the bytes there are before anything is read from them.
  if (headerLength + pageCount * pageLength > data.length) throw new MalformedDocumentError("SAS7BDAT is cut short");
  return { layout, alignment, totalAlignment, headerLength, pageLength, pageCount };
}

function readPageCount(view: DataView, at: number, layout: Layout): number {
  const count = layout.int === 8 ? view.getBigInt64(at, layout.little) : BigInt(view.getInt32(at, layout.little));
  if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) throw new MalformedDocumentError("SAS7BDAT page count is not valid");
  return Number(count);
}

/** The pointers of a page that has subheaders, as many as its header says, checked to lie inside the page. */
function* pointersOf(view: DataView, header: Header, start: number): Generator<Pointer> {
  const { layout } = header;
  const count = view.getUint16(start + layout.pageHeader + 4, layout.little);
  if (layout.pointersAt + count * layout.pointerSize > header.pageLength) throw new MalformedDocumentError("SAS7BDAT subheader pointers run past the page");
  for (let index = 0; index < count; index++) {
    const at = start + layout.pointersAt + index * layout.pointerSize;
    const offset = readUint(view, at, layout.int, layout.little);
    const length = readUint(view, at + layout.int, layout.int, layout.little);
    const pointer: Pointer = { offset, length, compression: view.getUint8(at + 2 * layout.int), type: view.getUint8(at + 2 * layout.int + 1) };
    if (length === 0 || pointer.compression === POINTER_TRUNCATED) continue; // the empty pointer that ends the list
    if (offset + length > header.pageLength) throw new MalformedDocumentError("SAS7BDAT subheader runs past its page");
    yield pointer;
  }
}

/** The subheaders of every page that has them, whichever pointer gives them, collected in the order they are met. */
function scanSubheaders(data: Uint8Array, view: DataView, header: Header): Metadata {
  const meta: Metadata = { rowLength: null, rowCount: 0, mixPageRowCount: 0, columnCount: null, texts: [], names: [], attributes: [], formats: [] };
  let budget = data.length;
  for (let page = 0; page < header.pageCount; page++) {
    const start = header.headerLength + page * header.pageLength;
    if (!SUBHEADER_PAGES.has(view.getInt16(start + header.layout.pageHeader, header.layout.little))) continue;
    for (const pointer of pointersOf(view, header, start)) {
      // Subheaders do not overlap, so they hold no more than the file does; pointers that say otherwise are re-reading bytes.
      budget -= pointer.length;
      if (budget < 0) throw new MalformedDocumentError("SAS7BDAT subheaders overlap");
      readSubheader(data.subarray(start + pointer.offset, start + pointer.offset + pointer.length), meta, header.layout);
    }
  }
  return meta;
}

/** The signature of a subheader, or null where it is too short to have one. */
function signatureOf(bytes: Uint8Array, layout: Layout): number | null {
  if (bytes.length < layout.int) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(layout.int === 8 && !layout.little ? 4 : 0, layout.little);
}

function readSubheader(bytes: Uint8Array, meta: Metadata, layout: Layout): void {
  const signature = signatureOf(bytes, layout);
  if (signature === null) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { int, little } = layout;
  switch (signature) {
    case ROW_SIZE:
      requireLength(bytes, 16 * int, "row size");
      meta.rowLength = readUint(view, 5 * int, int, little);
      meta.rowCount = readUint(view, 6 * int, int, little);
      meta.mixPageRowCount = readUint(view, 15 * int, int, little);
      return;
    case COLUMN_SIZE:
      requireLength(bytes, 2 * int, "column size");
      meta.columnCount = readUint(view, int, int, little);
      return;
    case COLUMN_TEXT: {
      requireLength(bytes, int + 2, "column text");
      // The offsets of the other subheaders count from the byte after the signature.
      const size = view.getUint16(int, little);
      if (int + size > bytes.length) throw new MalformedDocumentError("SAS7BDAT text block runs past its subheader");
      meta.texts.push(bytes.subarray(int, int + size));
      return;
    }
    case COLUMN_NAME:
      for (let at = int + 8; at + 6 <= bytes.length - (int + 4); at += 8) {
        meta.names.push({ block: view.getUint16(at, little), offset: view.getUint16(at + 2, little), length: view.getUint16(at + 4, little) });
      }
      return;
    case COLUMN_ATTRIBUTES:
      for (let at = int + 8; at + int + 7 <= bytes.length - (int + 4); at += int + 8) {
        meta.attributes.push({
          offset: readUint(view, at, int, little),
          width: view.getUint32(at + int, little),
          type: view.getUint8(at + int + 6) === 1 ? "numeric" : "character",
        });
      }
      return;
    case FORMAT_AND_LABEL: {
      // Every field of this subheader is placed from the third integer on, as the pandas reader has it.
      const base = 3 * int;
      requireLength(bytes, base + 34, "format and label");
      meta.formats.push({
        width: view.getUint16(base, little),
        precision: view.getUint16(base + 2, little),
        format: { block: view.getUint16(base + 22, little), offset: view.getUint16(base + 24, little), length: view.getUint16(base + 26, little) },
        label: { block: view.getUint16(base + 28, little), offset: view.getUint16(base + 30, little), length: view.getUint16(base + 32, little) },
      });
      return;
    }
    default:
      // The subheader counts, the column list and the others that hold nothing this reader needs.
      return;
  }
}

function requireLength(bytes: Uint8Array, length: number, what: string): void {
  if (bytes.length < length) throw new MalformedDocumentError(`SAS7BDAT ${what} subheader is too short`);
}

/** The first text block names the compression of a compressed file, as a literal inside it. */
function compressionOf(meta: Metadata): "RLE" | "RDC" | null {
  const first = meta.texts[0];
  if (first === undefined) return null;
  const text = latin1(first);
  for (const [literal, method] of COMPRESSION_LITERALS) {
    if (text.includes(literal)) return method;
  }
  return null;
}

function buildColumns(meta: Metadata, decoder: TextDecoder): SasColumn[] {
  const rowLength = meta.rowLength;
  if (rowLength === null || meta.columnCount === null) throw new MalformedDocumentError("SAS7BDAT has no size subheaders");
  const count = meta.attributes.length;
  if (count === 0 || meta.names.length !== count || meta.columnCount !== count) {
    throw new MalformedDocumentError("SAS7BDAT column count does not match its column subheaders");
  }

  let widths = 0;
  const columns = meta.attributes.map((attribute, index): SasColumn => {
    if (attribute.width < 1 || (attribute.type === "numeric" && attribute.width > 8) || attribute.offset + attribute.width > rowLength) {
      throw new MalformedDocumentError("SAS7BDAT column does not fit in its row");
    }
    widths += attribute.width;
    const entry = meta.formats[index];
    const formatName = entry === undefined ? "" : text(meta.texts, entry.format, decoder);
    return {
      name: text(meta.texts, meta.names[index]!, decoder),
      label: entry === undefined ? "" : text(meta.texts, entry.label, decoder),
      type: attribute.type,
      offset: attribute.offset,
      width: attribute.width,
      format: entry === undefined || formatName === "" ? null : { name: formatName, width: entry.width, precision: entry.precision },
    };
  });
  // Columns do not overlap, so a row holds the bytes of all of them: that bounds the cells of a row by its bytes.
  if (widths > rowLength) throw new MalformedDocumentError("SAS7BDAT columns are wider than their row");
  return columns;
}

function text(blocks: readonly Uint8Array[], reference: TextReference, decoder: TextDecoder): string {
  const block = blocks[reference.block];
  if (block === undefined) throw new MalformedDocumentError("SAS7BDAT names a text block that is not there");
  return javaTrim(decoder.decode(block.subarray(reference.offset, reference.offset + reference.length)));
}

interface RowReader {
  readonly data: Uint8Array;
  readonly view: DataView;
  readonly header: Header;
  readonly meta: Metadata;
  readonly columns: readonly SasColumn[];
  readonly decoder: TextDecoder;
  readonly compression: "RLE" | "RDC" | null;
  readonly maxInflated: number;
  /** The bytes the rows read so far have inflated to; the one thing about a pass that changes. */
  inflated: number;
}

/** The rows, from the pages in file order, as many as the file declares and its pages hold. */
function* readRows(reader: RowReader): Generator<SasValue[]> {
  const { view, header, meta } = reader;
  const { layout } = header;
  let remaining = meta.rowCount;
  for (let page = 0; page < header.pageCount && remaining > 0; page++) {
    const start = header.headerLength + page * header.pageLength;
    const type = view.getInt16(start + layout.pageHeader, layout.little);
    if (reader.compression !== null && PACKED_ROW_PAGES.has(type)) {
      for (const row of readPackedRows(reader, start, remaining)) {
        remaining--;
        yield row;
      }
      continue;
    }
    let first: number;
    let wanted: number;
    if (PAGE_MIX.includes(type)) {
      // The rows follow the pointers, on the next multiple of eight.
      first = (layout.pointersAt + view.getUint16(start + layout.pageHeader + 4, layout.little) * layout.pointerSize + 7) & ~7;
      wanted = meta.mixPageRowCount;
    } else if (type === PAGE_DATA) {
      first = layout.pointersAt;
      wanted = view.getUint16(start + layout.pageHeader + 2, layout.little);
    } else {
      continue;
    }
    // A count that the page cannot hold is a count the page cannot back: the rows are those whose bytes are there.
    const rowLength = meta.rowLength!;
    const room = first >= header.pageLength ? 0 : Math.floor((header.pageLength - first) / rowLength);
    const count = Math.min(remaining, wanted, room);
    for (let index = 0; index < count; index++) yield readRow(reader, reader.data, start + first + index * rowLength);
    remaining -= count;
  }
}

/**
 * The rows of a compressed file on one page: the subheaders that no known signature names, marked as data. A subheader as
 * long as a row is the row as it is; a shorter one is packed, and is inflated to the length of a row.
 */
function* readPackedRows(reader: RowReader, start: number, remaining: number): Generator<SasValue[]> {
  const { data, view, header, meta } = reader;
  const rowLength = meta.rowLength!;
  let left = remaining;
  for (const pointer of pointersOf(view, header, start)) {
    if (left === 0) return;
    const bytes = data.subarray(start + pointer.offset, start + pointer.offset + pointer.length);
    if (isKnownSubheader(bytes, header.layout) || !isPackedRow(pointer)) continue;
    if (bytes.length > rowLength) throw new MalformedDocumentError("SAS7BDAT row data is longer than a row");
    const row = bytes.length < rowLength ? inflate(reader, bytes) : bytes;
    left--;
    yield readRow(reader, row, 0);
  }
}

function isKnownSubheader(bytes: Uint8Array, layout: Layout): boolean {
  const signature = signatureOf(bytes, layout);
  return signature !== null && KNOWN_SIGNATURES.has(signature);
}

function isPackedRow(pointer: Pointer): boolean {
  return (pointer.compression === POINTER_COMPRESSED || pointer.compression === POINTER_UNCOMPRESSED) && pointer.type === POINTER_TYPE_DATA;
}

function inflate(reader: RowReader, packed: Uint8Array): Uint8Array {
  const rowLength = reader.meta.rowLength!;
  reader.inflated += rowLength;
  if (rowLength > MAX_INFLATION_PER_BYTE * packed.length) {
    throw new MalformedDocumentError("SAS7BDAT row is longer than the data packed into it can make");
  }
  if (reader.inflated > reader.maxInflated) {
    throw new LimitExceededError(`The rows of the SAS7BDAT file inflate to more than ${reader.maxInflated} bytes`);
  }
  return reader.compression === "RLE" ? rleDecompress(packed, rowLength) : rdcDecompress(packed, rowLength);
}

function readRow(reader: RowReader, bytes: Uint8Array, start: number): SasValue[] {
  const little = reader.header.layout.little;
  return reader.columns.map((column) => {
    const cell = bytes.subarray(start + column.offset, start + column.offset + column.width);
    return column.type === "numeric" ? readNumber(cell, little) : javaTrim(reader.decoder.decode(cell));
  });
}

/**
 * A number of 3 to 8 bytes is the high-order end of a double, which is the end of the bytes in a little-endian file and the
 * start of them in a big-endian one.
 */
function readNumber(bytes: Uint8Array, little: boolean): number | null {
  const eight = new Uint8Array(8);
  eight.set(bytes, little ? 8 - bytes.length : 0);
  const value = new DataView(eight.buffer).getFloat64(0, little);
  return Number.isNaN(value) ? null : value;
}

function toDate(seconds: number): Date | null {
  const millis = SAS_EPOCH_MS + seconds * 1000;
  return Number.isFinite(millis) && Math.abs(millis) <= MAX_DATE_MS ? new Date(millis) : null;
}

/** String.trim in Java: every character up to U+0020 comes off both ends, the NULs and the padding of SAS strings with it. */
function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

function latin1(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}
