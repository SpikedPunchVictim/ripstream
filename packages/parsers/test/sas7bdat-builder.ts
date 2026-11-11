/*
 * A SAS7BDAT file for the tests of the SAS reader (tikajs-68os.21, .69). The 32-bit little-endian layout has the header and
 * the metadata subheaders laid out as the two files of Tika's tests have them (testSAS.sas7bdat, test-columnar.sas7bdat), read
 * with a hex dump. The data pages (type 256) that carry rows after the first page are not in either of those files: their
 * layout is the published one, from memory, and this builder is the only thing here that has written it.
 *
 * The 64-bit and big-endian layouts, and the compressed rows, are not in any file here either. They are written from the
 * layout of the pandas and ReadStat readers as remembered (every integer of an offset or a count is eight bytes wide, the
 * page header and the subheader pointers grow with it, the signatures are eight bytes), so a test that uses them shows that
 * the reader and this builder agree, not that SAS writes the layout so.
 */

export type CellValue = number | string | null;

export interface BuiltColumn {
  readonly name: string;
  /** The text block (0 by default) that holds each of the column's strings; a file with several has them listed in order. */
  readonly blocks?: { readonly name?: number; readonly label?: number; readonly format?: number };
  readonly label?: string;
  readonly format?: { readonly name: string; readonly width?: number; readonly precision?: number };
  readonly type: "numeric" | "character";
  readonly width: number;
}

export interface BuildOptions {
  readonly name?: string;
  /** Seconds since 1960-01-01, as the header holds them. */
  readonly created?: number;
  readonly modified?: number;
  readonly release?: string;
  readonly host?: string;
  /** The encoding byte at offset 70; 62 is windows-1252. */
  readonly encodingByte?: number;
  /** How many column text subheaders the file has (default 1). */
  readonly textBlocks?: number;
  /** 4 for the layout byte 35 = 0x33 gives, where every header field from the timestamps on is four bytes further in. */
  readonly alignment?: 0 | 4;
  readonly columns: readonly BuiltColumn[];
  readonly rows: readonly CellValue[][];
  readonly pageLength?: number;
  /** How many rows the first (mixed) page holds; the rest go on data pages. Default: all of them that fit. */
  readonly rowsOnMixPage?: number;
  /** 64 for the layout whose offsets and counts are eight bytes wide (byte 32 = 0x33); it implies the alignment of 4. */
  readonly bits?: 32 | 64;
  readonly bigEndian?: boolean;
  /**
   * Rows as compressed data subheaders on pages of type 0, after the page of the metadata, with the literal of the
   * compression in the first text block. Replaces the mixed page and the data pages for the rows.
   */
  readonly compression?: { readonly method: "RLE" | "RDC"; readonly compress: (row: Uint8Array) => Uint8Array };
}

export const HEADER_LENGTH = 1024;
const MAGIC = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc2, 0xea, 0x81, 0x60, 0xb3, 0x14, 0x11, 0xcf, 0xbd, 0x92, 0x08, 0x00, 0x09, 0xc7, 0x31, 0x8c,
  0x18, 0x1f, 0x10, 0x11,
]);

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

/** What changes with the width of the integers and the byte order. */
class Layout {
  readonly int: 4 | 8;
  readonly little: boolean;
  /** Where the page header's fields start, and where the subheader pointers do. */
  readonly pageHeader: number;
  readonly pointersAt: number;
  readonly pointerSize: number;

  constructor(options: BuildOptions) {
    this.int = options.bits === 64 ? 8 : 4;
    this.little = options.bigEndian !== true;
    this.pageHeader = this.int === 8 ? 32 : 16;
    this.pointersAt = this.pageHeader + 8;
    this.pointerSize = this.int === 8 ? 24 : 12;
  }

  /** An integer of `size` bytes in the file's byte order. */
  put(view: DataView, at: number, value: number, size: number = this.int): void {
    if (size === 1) view.setUint8(at, value);
    else if (size === 2) view.setUint16(at, value, this.little);
    else if (size === 4) view.setUint32(at, value, this.little);
    else view.setBigUint64(at, BigInt(value), this.little);
  }

  /** A subheader's signature: the 32-bit value, in the low half of the eight bytes of a 64-bit file, filled with ones for a negative one. */
  signature(length: number, value: number): Uint8Array {
    const part = new Uint8Array(length);
    const view = new DataView(part.buffer);
    if (this.int === 4) {
      view.setUint32(0, value, this.little);
      return part;
    }
    const negative = value >= 0xf8000000;
    const high = negative ? 0xffffffff : 0;
    view.setUint32(this.little ? 0 : 4, value, this.little);
    view.setUint32(this.little ? 4 : 0, high, this.little);
    return part;
  }
}

export function buildSas7bdat(options: BuildOptions): Uint8Array {
  const layout = new Layout(options);
  const pageLength = options.pageLength ?? 4096;
  const rowLength = options.columns.reduce((sum, column) => sum + column.width, 0);
  const subheaders = buildSubheaders(options, layout, rowLength);

  const pages: Uint8Array[] =
    options.compression === undefined
      ? rowPages(options, layout, subheaders, pageLength, rowLength)
      : compressedPages(options, layout, subheaders, pageLength, options.compression.compress);

  const header = buildHeader(options, layout, pageLength, pages.length);
  const file = new Uint8Array(HEADER_LENGTH + pages.length * pageLength);
  file.set(header, 0);
  pages.forEach((page, index) => file.set(page, HEADER_LENGTH + index * pageLength));
  return file;
}

function rowPages(options: BuildOptions, layout: Layout, subheaders: Uint8Array[], pageLength: number, rowLength: number): Uint8Array[] {
  const pointerEnd = layout.pointersAt + (subheaders.length + 1) * layout.pointerSize;
  const rowsStart = (pointerEnd + 7) & ~7;
  const subheaderBytes = subheaders.reduce((sum, part) => sum + part.length, 0);
  const room = Math.floor((pageLength - subheaderBytes - rowsStart) / Math.max(rowLength, 1));
  const onMix = Math.min(options.rows.length, options.rowsOnMixPage ?? room);
  if (onMix > room) throw new Error("the rows do not fit on the first page");

  // As in the files, the row size subheader gives the room of the page, or here the rows put on it when there are fewer.
  const rowSizeView = new DataView(subheaders[0]!.buffer);
  layout.put(rowSizeView, 15 * layout.int, options.rowsOnMixPage === undefined ? room : onMix);

  const mix = new Uint8Array(pageLength);
  const view = new DataView(mix.buffer);
  writePageHeader(view, layout, 512, subheaders.length + onMix, subheaders.length + 1);
  placeSubheaders(mix, view, layout, subheaders, pageLength);
  options.rows.slice(0, onMix).forEach((row, index) => mix.set(encodeRow(options, layout, row), rowsStart + index * rowLength));

  const pages = [mix];
  const perDataPage = Math.floor((pageLength - layout.pointersAt) / Math.max(rowLength, 1));
  for (let first = onMix; first < options.rows.length; first += perDataPage) {
    const rows = options.rows.slice(first, first + perDataPage);
    const page = new Uint8Array(pageLength);
    writePageHeader(new DataView(page.buffer), layout, 256, rows.length, 0);
    rows.forEach((row, index) => page.set(encodeRow(options, layout, row), layout.pointersAt + index * rowLength));
    pages.push(page);
  }
  return pages;
}

/** The metadata on a page of type 0, then the compressed rows as subheaders of pages of type 0, as many to a page as fit. */
function compressedPages(
  options: BuildOptions,
  layout: Layout,
  subheaders: Uint8Array[],
  pageLength: number,
  compress: (row: Uint8Array) => Uint8Array,
): Uint8Array[] {
  const metadata = new Uint8Array(pageLength);
  const view = new DataView(metadata.buffer);
  writePageHeader(view, layout, 0, subheaders.length, subheaders.length + 1);
  placeSubheaders(metadata, view, layout, subheaders, pageLength);
  const pages = [metadata];

  const rowLength = options.columns.reduce((sum, column) => sum + column.width, 0);
  const compressedRows = options.rows.map((row) => {
    const plain = encodeRow(options, layout, row);
    const packed = compress(plain);
    // A row that did not get shorter is stored as it is, which is what a reader tells by its length being the row's.
    return packed.length < rowLength ? { bytes: packed, compression: 4 } : { bytes: plain, compression: 0 };
  });
  for (let first = 0; first < compressedRows.length; ) {
    const page = new Uint8Array(pageLength);
    const pageView = new DataView(page.buffer);
    let end = pageLength;
    let count = 0;
    while (first + count < compressedRows.length) {
      const next = compressedRows[first + count]!;
      const used = layout.pointersAt + (count + 2) * layout.pointerSize + (pageLength - end) + next.bytes.length;
      if (used > pageLength) break;
      end -= next.bytes.length;
      page.set(next.bytes, end);
      writePointer(pageView, layout, count, end, next.bytes.length, next.compression, 1);
      count++;
    }
    if (count === 0) throw new Error("a compressed row does not fit on a page");
    writePageHeader(pageView, layout, 0, count, count);
    pages.push(page);
    first += count;
  }
  return pages;
}

function writePageHeader(view: DataView, layout: Layout, type: number, blocks: number, subheaders: number): void {
  view.setInt16(layout.pageHeader, type, layout.little);
  layout.put(view, layout.pageHeader + 2, blocks, 2);
  layout.put(view, layout.pageHeader + 4, subheaders, 2);
}

/** The subheaders from the end of the page backwards, a pointer to each, and the empty truncated pointer after them. */
function placeSubheaders(page: Uint8Array, view: DataView, layout: Layout, subheaders: Uint8Array[], pageLength: number): void {
  let end = pageLength;
  subheaders.forEach((part, index) => {
    end -= part.length;
    page.set(part, end);
    writePointer(view, layout, index, end, part.length, 0, pointerType(layout, part));
  });
  writePointer(view, layout, subheaders.length, end, 0, 1, 0);
}

function buildHeader(options: BuildOptions, layout: Layout, pageLength: number, pageCount: number): Uint8Array {
  const header = new Uint8Array(HEADER_LENGTH);
  const view = new DataView(header.buffer);
  const little = layout.little;
  header.set(MAGIC, 0);
  header[32] = layout.int === 8 ? 0x33 : 0x22;
  const align1 = (options.alignment ?? (layout.int === 8 ? 4 : 0)) === 4 ? 4 : 0;
  const total = align1 + (layout.int === 8 ? 4 : 0);
  header[35] = align1 === 4 ? 0x33 : 0x32;
  header[37] = little ? 1 : 0;
  header[39] = 0x32;
  header[70] = options.encodingByte ?? 62;
  header.fill(0x20, 92, 156);
  header.set(latin1(options.name ?? "TESTING"), 92);
  header.set(latin1("DATA    "), 156);
  view.setFloat64(164 + align1, options.created ?? 0, little);
  view.setFloat64(172 + align1, options.modified ?? options.created ?? 0, little);
  view.setInt32(196 + align1, HEADER_LENGTH, little);
  view.setInt32(200 + align1, pageLength, little);
  layout.put(view, 204 + align1, pageCount);
  // The bytes the layout adds before the release are not part of it; a reader that starts too early would show them.
  header.fill(0x5a, 216, 216 + total);
  header.set(latin1(options.release ?? "9.0401M5"), 216 + total);
  header.set(latin1(options.host ?? "X64_7PRO"), 224 + total);
  return header;
}

function writePointer(view: DataView, layout: Layout, index: number, offset: number, length: number, compression: number, type: number): void {
  const at = layout.pageHeader + 8 + index * layout.pointerSize;
  layout.put(view, at, offset);
  layout.put(view, at + layout.int, length);
  view.setUint8(at + 2 * layout.int, compression);
  view.setUint8(at + 2 * layout.int + 1, type);
}

/** Pointer type 1 is for the text, name, attribute and list subheaders; the sizes and the format subheaders are type 0. */
const TEXTUAL_SIGNATURES = new Set([0xfffffffd, 0xffffffff, 0xfffffffc, 0xfffffffe]);

function pointerType(layout: Layout, part: Uint8Array): number {
  const view = new DataView(part.buffer, part.byteOffset, part.byteLength);
  const low = view.getUint32(layout.int === 8 && !layout.little ? 4 : 0, layout.little);
  return TEXTUAL_SIGNATURES.has(low) ? 1 : 0;
}

function buildSubheaders(options: BuildOptions, layout: Layout, rowLength: number): Uint8Array[] {
  const { columns, rows } = options;
  const int = layout.int;
  const blocks = Array.from({ length: options.textBlocks ?? 1 }, () => new TextBlock(layout));
  if (options.compression !== undefined) blocks[0]!.add(options.compression.method === "RLE" ? "SASYZCRL" : "SASYZCR2", 0);
  const references = columns.map((column) => ({
    name: blocks[column.blocks?.name ?? 0]!.add(column.name, column.blocks?.name ?? 0),
    label: blocks[column.blocks?.label ?? 0]!.add(column.label ?? "", column.blocks?.label ?? 0),
    format: blocks[column.blocks?.format ?? 0]!.add(column.format?.name ?? "", column.blocks?.format ?? 0),
  }));

  const rowSize = layout.signature(int === 8 ? 808 : 480, 0xf7f7f7f7);
  const rowSizeView = new DataView(rowSize.buffer);
  layout.put(rowSizeView, 5 * int, rowLength);
  layout.put(rowSizeView, 6 * int, rows.length);
  layout.put(rowSizeView, 9 * int, columns.length);

  const columnSize = layout.signature(3 * int, 0xf6f6f6f6);
  layout.put(new DataView(columnSize.buffer), int, columns.length);

  const names = layout.signature(2 * int + 12 + 8 * columns.length, 0xffffffff);
  const namesView = new DataView(names.buffer);
  references.forEach((reference, index) => {
    const at = int + 8 + 8 * index;
    layout.put(namesView, at, reference.name.block, 2);
    layout.put(namesView, at + 2, reference.name.offset, 2);
    layout.put(namesView, at + 4, reference.name.length, 2);
  });

  const stride = int + 8;
  const attributes = layout.signature(2 * int + 12 + stride * columns.length, 0xfffffffc);
  const attributesView = new DataView(attributes.buffer);
  let offset = 0;
  columns.forEach((column, index) => {
    const at = int + 8 + stride * index;
    layout.put(attributesView, at, offset);
    layout.put(attributesView, at + int, column.width, 4);
    layout.put(attributesView, at + int + 4, 0x0400, 2);
    layout.put(attributesView, at + int + 6, column.type === "numeric" ? 1 : 2, 1);
    offset += column.width;
  });

  const formats = columns.map((column, index) => {
    const part = layout.signature(3 * int + 40, 0xfffffbfe);
    const view = new DataView(part.buffer);
    const base = 3 * int;
    layout.put(view, base, column.format?.width ?? 0, 2);
    layout.put(view, base + 2, column.format?.precision ?? 0, 2);
    layout.put(view, base + 22, references[index]!.format.block, 2);
    layout.put(view, base + 24, references[index]!.format.offset, 2);
    layout.put(view, base + 26, references[index]!.format.length, 2);
    layout.put(view, base + 28, references[index]!.label.block, 2);
    layout.put(view, base + 30, references[index]!.label.offset, 2);
    layout.put(view, base + 32, references[index]!.label.length, 2);
    return part;
  });

  return [rowSize, columnSize, layout.signature(304, 0xfffffc00), ...blocks.map((block) => block.subheader()), names, attributes, ...formats];
}

/** The text block of the column text subheader: 32 bytes of its own header, then the strings the other subheaders point at. */
class TextBlock {
  readonly #layout: Layout;
  readonly #parts: Uint8Array[] = [];
  #length = 32;

  constructor(layout: Layout) {
    this.#layout = layout;
  }

  add(value: string, block: number): { block: number; offset: number; length: number } {
    const bytes = latin1(value);
    const reference = { block, offset: this.#length, length: bytes.length };
    this.#parts.push(bytes);
    this.#length += bytes.length;
    return reference;
  }

  subheader(): Uint8Array {
    const int = this.#layout.int;
    const block = new Uint8Array(this.#length);
    this.#layout.put(new DataView(block.buffer), 0, this.#length, 2);
    let at = 32;
    for (const part of this.#parts) {
      block.set(part, at);
      at += part.length;
    }
    const part = this.#layout.signature(int + ((this.#length + 7) & ~7) + 8, 0xfffffffd);
    part.set(block, int);
    return part;
  }
}

/** A row as the file holds it, each number a double of the byte order of the file. */
function encodeRow(options: BuildOptions, layout: Layout, row: readonly CellValue[]): Uint8Array {
  const columns = options.columns;
  const rowLength = columns.reduce((sum, column) => sum + column.width, 0);
  const out = new Uint8Array(rowLength);
  let offset = 0;
  columns.forEach((column, index) => {
    const value = row[index] ?? null;
    if (column.type === "character") {
      out.fill(0x20, offset, offset + column.width);
      out.set(latin1(String(value ?? "")).subarray(0, column.width), offset);
    } else {
      const eight = new Uint8Array(8);
      // A missing number is the NaN that SAS writes: 00 00 00 00 00 00 fe ff, in the byte order of the file.
      if (value === null) eight.set(layout.little ? [0, 0, 0, 0, 0, 0, 0xfe, 0xff] : [0xff, 0xfe, 0, 0, 0, 0, 0, 0]);
      else new DataView(eight.buffer).setFloat64(0, Number(value), layout.little);
      // A narrower column keeps the high-order bytes of the double: the last ones in a little-endian file, the first in a big-endian one.
      out.set(layout.little ? eight.subarray(8 - column.width) : eight.subarray(0, column.width), offset);
    }
    offset += column.width;
  });
  return out;
}
