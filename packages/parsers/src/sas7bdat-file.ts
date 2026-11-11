import { MalformedDocumentError, UnsupportedFormatError } from "@spikedpunch/ripstream-core";

/*
 * A reader for SAS7BDAT files, the published format as the two files of Tika's SAS7BDATParserTest show it (testSAS.sas7bdat and
 * test-columnar.sas7bdat, read with a hex dump). Tika reads the format with parso, whose source was not available: nothing
 * here is parso's code or was checked against it.
 *
 * It reads 32-bit, little-endian, uncompressed files. A file of the 64-bit layout, the big-endian one, or with RLE or RDC
 * compression is refused as unsupported: the offsets and algorithms of those are not in the two files, and a reader that
 * guessed at them would give wrong values for real files rather than none. Rows are read from the mixed page (type 512) and
 * from data pages (type 256); the layout of the latter is the published one, from memory, and no file here has one.
 *
 * Everything is bounded by the bytes present: pages are located by arithmetic and checked against the length of the file,
 * nothing is allocated by a declared count, and the subheaders read are budgeted by the size of the file so that pointers
 * pointing at the same bytes cannot be read over and over.
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
  readonly endian: "Little";
  readonly bits: 32;
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
const PAGE_HEADER = 16;
const POINTERS_AT = 24;
const POINTER_SIZE = 12;

const PAGE_META = 0;
const PAGE_DATA = 256;
const PAGE_MIX = [512, 640];
const PAGE_AMD = 1024;
const SUBHEADER_PAGES = new Set([PAGE_META, PAGE_AMD, ...PAGE_MIX]);

/** The first four bytes of a subheader, read as the file's integers. */
const ROW_SIZE = 0xf7f7f7f7;
const COLUMN_SIZE = 0xf6f6f6f6;
const COLUMN_TEXT = 0xfffffffd;
const COLUMN_NAME = 0xffffffff;
const COLUMN_ATTRIBUTES = 0xfffffffc;
const FORMAT_AND_LABEL = 0xfffffbfe;

const COMPRESSION_LITERALS = ["SASYZCRL", "SASYZCR2"];
const SAS_EPOCH_MS = Date.UTC(1960, 0, 1);
const MAX_DATE_MS = 8.64e15;

/** The encoding byte at offset 70 of the header, for the bytes this reader knows (62 is the one the Tika test shows). */
const ENCODINGS = new Map<number, string>([
  [20, "UTF-8"],
  [29, "ISO-8859-1"],
  ...[60, 61, 62, 63, 64, 65, 66, 67, 68].map((byte): [number, string] => [byte, `windows-${1250 + byte - 60}`]),
]);
const FALLBACK_CHARSET = "windows-1252";

interface Header {
  readonly alignment: number;
  readonly headerLength: number;
  readonly pageLength: number;
  readonly pageCount: number;
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

export function readSasFile(data: Uint8Array): SasFile {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const header = readHeader(data, view);
  const meta = scanSubheaders(data, view, header);
  rejectCompression(meta);
  const charset = ENCODINGS.get(data[70]!) ?? null;
  const decoder = new TextDecoder(charset ?? FALLBACK_CHARSET);
  const columns = buildColumns(meta, decoder);

  const properties: SasProperties = {
    name: javaTrim(latin1(data.subarray(92, 156))),
    created: toDate(view.getFloat64(164 + header.alignment, true)),
    modified: toDate(view.getFloat64(172 + header.alignment, true)),
    pageCount: header.pageCount,
    columnCount: meta.columnCount ?? columns.length,
    rowCount: meta.rowCount,
    encoding: charset,
    serverType: javaTrim(latin1(data.subarray(224 + header.alignment, 240 + header.alignment))),
    sasRelease: javaTrim(latin1(data.subarray(216 + header.alignment, 224 + header.alignment))),
    endian: "Little",
    bits: 32,
  };
  return { properties, columns, rows: () => readRows(data, view, header, meta, columns, decoder) };
}

function readHeader(data: Uint8Array, view: DataView): Header {
  if (data.length < MIN_HEADER_LENGTH || !MAGIC.every((byte, index) => data[index] === byte)) {
    throw new MalformedDocumentError("Not a SAS7BDAT file");
  }
  if (data[32] === 0x33) throw new UnsupportedFormatError("64-bit SAS7BDAT files are not supported");
  if (data[37] === 0) throw new UnsupportedFormatError("Big-endian SAS7BDAT files are not supported");
  if (data[37] !== 1) throw new MalformedDocumentError("SAS7BDAT has an unknown byte order");

  // Byte 35 says the fields from the timestamps on are four bytes further in.
  const alignment = data[35] === 0x33 ? 4 : 0;
  const headerLength = view.getInt32(196 + alignment, true);
  const pageLength = view.getInt32(200 + alignment, true);
  const pageCount = view.getInt32(204 + alignment, true);
  if (headerLength < MIN_HEADER_LENGTH || headerLength > data.length) throw new MalformedDocumentError("SAS7BDAT header length is not valid");
  if (pageLength < POINTERS_AT) throw new MalformedDocumentError("SAS7BDAT page length is not valid");
  if (pageCount < 0) throw new MalformedDocumentError("SAS7BDAT page count is not valid");
  // The declared pages are compared with the bytes there are before anything is read from them.
  if (headerLength + pageCount * pageLength > data.length) throw new MalformedDocumentError("SAS7BDAT is cut short");
  return { alignment, headerLength, pageLength, pageCount };
}

/** The subheaders of every page that has them, whichever pointer gives them, collected in the order they are met. */
function scanSubheaders(data: Uint8Array, view: DataView, header: Header): Metadata {
  const meta: Metadata = { rowLength: null, rowCount: 0, mixPageRowCount: 0, columnCount: null, texts: [], names: [], attributes: [], formats: [] };
  let budget = data.length;
  for (let page = 0; page < header.pageCount; page++) {
    const start = header.headerLength + page * header.pageLength;
    if (!SUBHEADER_PAGES.has(view.getInt16(start + PAGE_HEADER, true))) continue;
    const count = view.getUint16(start + PAGE_HEADER + 4, true);
    if (POINTERS_AT + count * POINTER_SIZE > header.pageLength) throw new MalformedDocumentError("SAS7BDAT subheader pointers run past the page");
    for (let index = 0; index < count; index++) {
      const pointer = start + POINTERS_AT + index * POINTER_SIZE;
      const offset = view.getUint32(pointer, true);
      const length = view.getUint32(pointer + 4, true);
      if (length === 0) continue; // the empty pointer that ends the list
      if (offset + length > header.pageLength) throw new MalformedDocumentError("SAS7BDAT subheader runs past its page");
      // Subheaders do not overlap, so they hold no more than the file does; pointers that say otherwise are re-reading bytes.
      budget -= length;
      if (budget < 0) throw new MalformedDocumentError("SAS7BDAT subheaders overlap");
      readSubheader(data.subarray(start + offset, start + offset + length), meta);
    }
  }
  return meta;
}

function readSubheader(bytes: Uint8Array, meta: Metadata): void {
  if (bytes.length < 4) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (view.getUint32(0, true)) {
    case ROW_SIZE:
      requireLength(bytes, 64, "row size");
      meta.rowLength = view.getUint32(20, true);
      meta.rowCount = view.getUint32(24, true);
      meta.mixPageRowCount = view.getUint32(60, true);
      return;
    case COLUMN_SIZE:
      requireLength(bytes, 8, "column size");
      meta.columnCount = view.getUint32(4, true);
      return;
    case COLUMN_TEXT: {
      requireLength(bytes, 6, "column text");
      // The offsets of the other subheaders count from the byte after the signature.
      const size = view.getUint16(4, true);
      if (4 + size > bytes.length) throw new MalformedDocumentError("SAS7BDAT text block runs past its subheader");
      meta.texts.push(bytes.subarray(4, 4 + size));
      return;
    }
    case COLUMN_NAME:
      for (let at = 12; at + 6 <= bytes.length - 8; at += 8) {
        meta.names.push({ block: view.getUint16(at, true), offset: view.getUint16(at + 2, true), length: view.getUint16(at + 4, true) });
      }
      return;
    case COLUMN_ATTRIBUTES:
      for (let at = 12; at + 11 <= bytes.length - 8; at += 12) {
        meta.attributes.push({
          offset: view.getUint32(at, true),
          width: view.getUint32(at + 4, true),
          type: view.getUint8(at + 10) === 1 ? "numeric" : "character",
        });
      }
      return;
    case FORMAT_AND_LABEL:
      requireLength(bytes, 46, "format and label");
      meta.formats.push({
        width: view.getUint16(12, true),
        precision: view.getUint16(14, true),
        format: { block: view.getUint16(34, true), offset: view.getUint16(36, true), length: view.getUint16(38, true) },
        label: { block: view.getUint16(40, true), offset: view.getUint16(42, true), length: view.getUint16(44, true) },
      });
      return;
    default:
      // The subheader counts, the column list and the others that hold nothing this reader needs.
      return;
  }
}

function requireLength(bytes: Uint8Array, length: number, what: string): void {
  if (bytes.length < length) throw new MalformedDocumentError(`SAS7BDAT ${what} subheader is too short`);
}

/** The first text block names the compression of a compressed file, as a literal inside it. */
function rejectCompression(meta: Metadata): void {
  const first = meta.texts[0];
  if (first === undefined) return;
  const text = latin1(first);
  const literal = COMPRESSION_LITERALS.find((candidate) => text.includes(candidate));
  if (literal !== undefined) throw new UnsupportedFormatError(`Compressed (${literal}) SAS7BDAT files are not supported`);
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

/** The rows, from the mixed page and the data pages in file order, as many as the file declares and its pages hold. */
function* readRows(
  data: Uint8Array,
  view: DataView,
  header: Header,
  meta: Metadata,
  columns: readonly SasColumn[],
  decoder: TextDecoder,
): Generator<SasValue[]> {
  const rowLength = meta.rowLength!;
  let remaining = meta.rowCount;
  for (let page = 0; page < header.pageCount && remaining > 0; page++) {
    const start = header.headerLength + page * header.pageLength;
    const type = view.getInt16(start + PAGE_HEADER, true);
    let first: number;
    let wanted: number;
    if (PAGE_MIX.includes(type)) {
      // The rows follow the pointers, on the next multiple of eight.
      first = (POINTERS_AT + view.getUint16(start + PAGE_HEADER + 4, true) * POINTER_SIZE + 7) & ~7;
      wanted = meta.mixPageRowCount;
    } else if (type === PAGE_DATA) {
      first = POINTERS_AT;
      wanted = view.getUint16(start + PAGE_HEADER + 2, true);
    } else {
      continue;
    }
    // A count that the page cannot hold is a count the page cannot back: the rows are those whose bytes are there.
    const room = first >= header.pageLength ? 0 : Math.floor((header.pageLength - first) / rowLength);
    const count = Math.min(remaining, wanted, room);
    for (let index = 0; index < count; index++) yield readRow(data, start + first + index * rowLength, columns, decoder);
    remaining -= count;
  }
}

function readRow(data: Uint8Array, start: number, columns: readonly SasColumn[], decoder: TextDecoder): SasValue[] {
  return columns.map((column) => {
    const bytes = data.subarray(start + column.offset, start + column.offset + column.width);
    return column.type === "numeric" ? readNumber(bytes) : javaTrim(decoder.decode(bytes));
  });
}

/** A number of 3 to 8 bytes is the high-order end of a double, which is the end of the bytes in a little-endian file. */
function readNumber(bytes: Uint8Array): number | null {
  const eight = new Uint8Array(8);
  eight.set(bytes, 8 - bytes.length);
  const value = new DataView(eight.buffer).getFloat64(0, true);
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
