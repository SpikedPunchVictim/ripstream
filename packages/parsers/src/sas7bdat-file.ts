import { LimitExceededError, MalformedDocumentError, UnsupportedFormatError } from "@spikedpunch/ripstream-core";
import { rdcDecompress, rleDecompress } from "./sas-compression.ts";

/*
 * A reader for SAS7BDAT files, with parso's own source and its test corpus to check it against. In the 64-bit layout every
 * integer that is a count or an offset is eight bytes wide and the page header and the subheader pointers grow with it; a
 * big-endian file has every integer and double the other way round; in a compressed file the rows are subheaders of the
 * metadata pages, packed by sas-compression.ts. Rows are read from the mixed page (types 512 and 640) and from data pages
 * (types 256 and 384), and a page's deleted-map ends the rows at its first deleted one, as parso's reader does.
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
/** The compressed-metadata page type (PAGE_CMETA_TYPE). */
const PAGE_CMETA = 128;
const PAGE_DATA = 256;
/** A data or mixed page whose rows carry a deleted-map: the first deleted row ends the parse, as it does in Tika. */
const PAGE_DATA_DELETED = 384;
const PAGE_MIX_DELETED = 640;
const PAGE_MIX = [512, 640];
const PAGE_AMD = 1024;
const PAGE_METC = 16384;
const SUBHEADER_PAGES = new Set([PAGE_META, PAGE_CMETA, PAGE_AMD, PAGE_METC, ...PAGE_MIX]);
/** The pages whose subheaders can be rows, when the file is compressed. */
const PACKED_ROW_PAGES = new Set([PAGE_META, PAGE_CMETA, PAGE_METC]);

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
/**
 * The eight-byte signatures of a 64-bit file, as parso maps them: a 32-bit signature in either half (the row and column
 * size are written with the other half zero or, in the files parso tested against, with `fffffbfe` there) and the
 * others sign-extended. The value is read in the file's byte order, so one table covers both byte orders.
 */
const SIGNATURES_64 = new Map<bigint, number>([
  [0x00000000f7f7f7f7n, ROW_SIZE],
  [0xf7f7f7f700000000n, ROW_SIZE],
  [0xf7f7f7f7fffffbfen, ROW_SIZE],
  [0x00000000f6f6f6f6n, COLUMN_SIZE],
  [0xf6f6f6f600000000n, COLUMN_SIZE],
  [0xf6f6f6f6fffffbfen, COLUMN_SIZE],
  [0x00fcffffffffffffn, SUBHEADER_COUNTS],
  [0xfffffffffffffc00n, SUBHEADER_COUNTS],
  [0xfdffffffffffffffn, COLUMN_TEXT],
  [0xfffffffffffffffdn, COLUMN_TEXT],
  [0xffffffffffffffffn, COLUMN_NAME],
  [0xfcffffffffffffffn, COLUMN_ATTRIBUTES],
  [0xfffffffffffffffcn, COLUMN_ATTRIBUTES],
  [0xfefbffffffffffffn, FORMAT_AND_LABEL],
  [0xfffffffffffffbfen, FORMAT_AND_LABEL],
  [0xfeffffffffffffffn, COLUMN_LIST],
  [0xfffffffffffffffen, COLUMN_LIST],
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

/** The encoding byte at offset 70, named as parso names it (SasFileConstants.SAS_CHARACTER_ENCODINGS). */
const ENCODINGS = new Map<number, string>([
  [0x46, "x-MacArabic"],
  [0xf5, "x-MacCroatian"],
  [0xf6, "x-MacCyrillic"],
  [0x48, "x-MacGreek"],
  [0x47, "x-MacHebrew"],
  [0xa3, "x-MacIceland"],
  [0x22, "ISO-8859-6"],
  [0x45, "x-MacRoman"],
  [0xf7, "x-MacRomania"],
  [0x49, "x-MacThai"],
  [0x4b, "x-MacTurkish"],
  [0x4c, "x-MacUkraine"],
  [0x7b, "Big5"],
  [0x21, "ISO-8859-5"],
  [0x4e, "IBM037"],
  [0x5f, "x-IBM1025"],
  [0xcf, "x-IBM1097"],
  [0x62, "x-IBM1112"],
  [0x63, "x-IBM1122"],
  [0xb7, "IBM01140"],
  [0xb8, "IBM01141"],
  [0xb9, "IBM01142"],
  [0xba, "IBM01143"],
  [0xbb, "IBM01144"],
  [0xbc, "IBM01145"],
  [0xbd, "IBM01146"],
  [0xbe, "IBM01147"],
  [0xbf, "IBM01148"],
  [0xd3, "IBM01149"],
  [0x57, "IBM424"],
  [0x58, "IBM500"],
  [0x59, "IBM-Thai"],
  [0x5a, "IBM870"],
  [0x5b, "x-IBM875"],
  [0x7d, "GBK"],
  [0x86, "EUC-JP"],
  [0x8c, "EUC-KR"],
  [0x77, "x-EUC-TW"],
  [0xcd, "GB18030"],
  [0x23, "ISO-8859-7"],
  [0x24, "ISO-8859-8"],
  [0x80, "x-IBM1381"],
  [0x82, "x-IBM930"],
  [0x8b, "x-IBM933"],
  [0x7c, "x-IBM935"],
  [0x75, "x-IBM937"],
  [0x81, "x-IBM939"],
  [0x89, "x-IBM942"],
  [0x8e, "x-IBM949"],
  [0xac, "x-ISO2022-CN-CNS"],
  [0xa9, "x-ISO2022-CN-GB"],
  [0xa7, "ISO-2022-JP"],
  [0xa8, "ISO-2022-KR"],
  [0x1d, "ISO-8859-1"],
  [0x1e, "ISO-8859-2"],
  [0x1f, "ISO-8859-3"],
  [0x20, "ISO-8859-4"],
  [0x25, "ISO-8859-9"],
  [0xf2, "ISO-8859-13"],
  [0x28, "ISO-8859-15"],
  [0x88, "x-windows-iso2022jp"],
  [0x7e, "x-mswin-936"],
  [0x8d, "x-windows-949"],
  [0x76, "x-windows-950"],
  [0xad, "IBM037"],
  [0x6c, "x-IBM1025"],
  [0x6d, "IBM1026"],
  [0x6e, "IBM1047"],
  [0xd0, "x-IBM1097"],
  [0x6f, "x-IBM1112"],
  [0x70, "x-IBM1122"],
  [0xc0, "IBM01140"],
  [0xc1, "IBM01141"],
  [0xc2, "IBM01142"],
  [0xc3, "IBM01143"],
  [0xc4, "IBM01144"],
  [0xc5, "IBM01145"],
  [0xc6, "IBM01146"],
  [0xc7, "IBM01147"],
  [0xc8, "IBM01148"],
  [0xd4, "IBM01149"],
  [0x66, "IBM424"],
  [0x67, "IBM-Thai"],
  [0x68, "IBM870"],
  [0x69, "x-IBM875"],
  [0xea, "x-IBM930"],
  [0xeb, "x-IBM933"],
  [0xec, "x-IBM935"],
  [0xed, "x-IBM937"],
  [0xee, "x-IBM939"],
  [0x2b, "IBM437"],
  [0x2c, "IBM850"],
  [0x2d, "IBM852"],
  [0x3a, "IBM857"],
  [0x2e, "IBM00858"],
  [0x2f, "IBM862"],
  [0x33, "IBM866"],
  [0x8a, "Shift_JIS"],
  [0xf8, "JIS_X0201"],
  [0x27, "x-iso-8859-11"],
  [0x1c, "US-ASCII"],
  [0x14, "UTF-8"],
  [0x42, "windows-1256"],
  [0x43, "windows-1257"],
  [0x3d, "windows-1251"],
  [0x3f, "windows-1253"],
  [0x41, "windows-1255"],
  [0x3e, "windows-1252"],
  [0x3c, "windows-1250"],
  [0x40, "windows-1254"],
  [0x44, "windows-1258"],
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
  const decoder = decoderFor(charset);
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
  if (layout.int === 8) return SIGNATURES_64.get(view.getBigUint64(0, layout.little)) ?? null;
  return view.getUint32(0, layout.little);
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
    const deleted = type === PAGE_DATA_DELETED || type === PAGE_MIX_DELETED;
    if (PAGE_MIX.includes(type)) {
      // The rows follow the pointers, on the next multiple of eight.
      first = (layout.pointersAt + view.getUint16(start + layout.pageHeader + 4, layout.little) * layout.pointerSize + 7) & ~7;
      wanted = meta.mixPageRowCount;
    } else if (type === PAGE_DATA || type === PAGE_DATA_DELETED) {
      first = layout.pointersAt;
      wanted = view.getUint16(start + layout.pageHeader + 2, layout.little);
    } else {
      continue;
    }
    // A count that the page cannot hold is a count the page cannot back: the rows are those whose bytes are there.
    const rowLength = meta.rowLength!;
    const room = first >= header.pageLength ? 0 : Math.floor((header.pageLength - first) / rowLength);
    const count = Math.min(remaining, wanted, room);
    const deletedMap = deleted ? deletedMapOf(reader, start) : null;
    for (let index = 0; index < count; index++) {
      // Tika's reader stops at the first deleted row, so what its parse has is what this one gives.
      if (deletedMap !== null && deletedMap.isDeleted(index)) return;
      yield readRow(reader, reader.data, start + first + index * rowLength);
    }
    remaining -= count;
  }
}

/**
 * The deleted-map of a page whose rows can be deleted: one bit a row, the most significant bit of a byte first, as parso
 * finds it after the rows. A map that is not inside the page marks nothing, so no row is taken for deleted.
 */
function deletedMapOf(reader: RowReader, start: number): { isDeleted(index: number): boolean } | null {
  const { view, header, meta } = reader;
  const { layout } = header;
  const blockCount = view.getUint16(start + layout.pageHeader + 2, layout.little);
  const pointerCount = view.getUint16(start + layout.pageHeader + 4, layout.little);
  const align = (layout.pointersAt + pointerCount * layout.pointerSize) % 8;
  const rowsAt = layout.pointersAt + align + pointerCount * layout.pointerSize;
  const deletedPointer = view.getUint32(start + (layout.int === 8 ? 24 : 12), layout.little);
  const at = rowsAt + deletedPointer + (blockCount - pointerCount) * meta.rowLength!;
  const bytes = Math.ceil((blockCount - pointerCount) / 8);
  if (bytes <= 0 || at + bytes > header.pageLength) return null;
  return {
    isDeleted(index: number): boolean {
      if (index >= blockCount - pointerCount) return false;
      return ((view.getUint8(start + at + Math.floor(index / 8)) >> (7 - (index % 8))) & 1) === 1;
    },
  };
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
  // parso reads a positive number below 1E-300 as missing, and NaN as missing too.
  return Number.isNaN(value) || (value > 0 && value < 1e-300) ? null : value;
}

function toDate(seconds: number): Date | null {
  const millis = SAS_EPOCH_MS + seconds * 1000;
  return Number.isFinite(millis) && Math.abs(millis) <= MAX_DATE_MS ? new Date(millis) : null;
}

/** The decoder of an encoding name, or the fallback when the runtime does not know the name Java uses for it. */
function decoderFor(charset: string | null): TextDecoder {
  try {
    return new TextDecoder(charset ?? FALLBACK_CHARSET);
  } catch {
    return new TextDecoder(FALLBACK_CHARSET);
  }
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
