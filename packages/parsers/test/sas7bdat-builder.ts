/*
 * A SAS7BDAT file for the tests of the SAS reader (tikajs-68os.21): 32-bit, little-endian, uncompressed, with the header and
 * the metadata subheaders laid out as the two files of Tika's tests have them (testSAS.sas7bdat, test-columnar.sas7bdat), read
 * with a hex dump. The data pages (type 256) that carry rows after the first page are not in either of those files: their
 * layout is the published one, from memory, and this builder is the only thing here that has written it.
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
}

export const HEADER_LENGTH = 1024;
const MAGIC = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc2, 0xea, 0x81, 0x60, 0xb3, 0x14, 0x11, 0xcf, 0xbd, 0x92, 0x08, 0x00, 0x09, 0xc7, 0x31, 0x8c,
  0x18, 0x1f, 0x10, 0x11,
]);
const PAGE_HEADER = 16;
const POINTERS_AT = 24;
const POINTER_SIZE = 12;

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

export function buildSas7bdat(options: BuildOptions): Uint8Array {
  const pageLength = options.pageLength ?? 4096;
  const rowLength = options.columns.reduce((sum, column) => sum + column.width, 0);
  const subheaders = buildSubheaders(options, rowLength);

  const pointerEnd = POINTERS_AT + (subheaders.length + 1) * POINTER_SIZE;
  const rowsStart = (pointerEnd + 7) & ~7;
  const subheaderBytes = subheaders.reduce((sum, part) => sum + part.length, 0);
  const room = Math.floor((pageLength - subheaderBytes - rowsStart) / Math.max(rowLength, 1));
  const onMix = Math.min(options.rows.length, options.rowsOnMixPage ?? room);
  if (onMix > room) throw new Error("the rows do not fit on the first page");

  // As in the files, the row size subheader gives the room of the page, or here the rows put on it when there are fewer.
  new DataView(subheaders[0]!.buffer).setUint32(60, options.rowsOnMixPage === undefined ? room : onMix, true);

  const mix = new Uint8Array(pageLength);
  const view = new DataView(mix.buffer);
  view.setInt16(PAGE_HEADER, 512, true);
  view.setUint16(PAGE_HEADER + 2, subheaders.length + onMix, true);
  view.setUint16(PAGE_HEADER + 4, subheaders.length + 1, true);
  let end = pageLength;
  subheaders.forEach((part, index) => {
    end -= part.length;
    mix.set(part, end);
    writePointer(view, index, end, part.length, 0, pointerType(part));
  });
  writePointer(view, subheaders.length, end, 0, 1, 0); // the empty, truncated pointer that ends the list
  options.rows.slice(0, onMix).forEach((row, index) => mix.set(encodeRow(options.columns, row), rowsStart + index * rowLength));

  const pages = [mix];
  const perDataPage = Math.floor((pageLength - POINTERS_AT) / Math.max(rowLength, 1));
  for (let first = onMix; first < options.rows.length; first += perDataPage) {
    const rows = options.rows.slice(first, first + perDataPage);
    const page = new Uint8Array(pageLength);
    const pageView = new DataView(page.buffer);
    pageView.setInt16(PAGE_HEADER, 256, true);
    pageView.setUint16(PAGE_HEADER + 2, rows.length, true);
    rows.forEach((row, index) => page.set(encodeRow(options.columns, row), POINTERS_AT + index * rowLength));
    pages.push(page);
  }

  const header = buildHeader(options, pageLength, pages.length);
  const file = new Uint8Array(HEADER_LENGTH + pages.length * pageLength);
  file.set(header, 0);
  pages.forEach((page, index) => file.set(page, HEADER_LENGTH + index * pageLength));
  return file;
}

function buildHeader(options: BuildOptions, pageLength: number, pageCount: number): Uint8Array {
  const header = new Uint8Array(HEADER_LENGTH);
  const view = new DataView(header.buffer);
  header.set(MAGIC, 0);
  header[32] = 0x22;
  const shift = options.alignment ?? 0;
  header[35] = shift === 4 ? 0x33 : 0x32;
  header[37] = 1;
  header[39] = 0x32;
  header[70] = options.encodingByte ?? 62;
  header.fill(0x20, 92, 156);
  header.set(latin1(options.name ?? "TESTING"), 92);
  header.set(latin1("DATA    "), 156);
  view.setFloat64(164 + shift, options.created ?? 0, true);
  view.setFloat64(172 + shift, options.modified ?? options.created ?? 0, true);
  view.setInt32(196 + shift, HEADER_LENGTH, true);
  view.setInt32(200 + shift, pageLength, true);
  view.setInt32(204 + shift, pageCount, true);
  // The four bytes the layout adds before the release are not part of it; a reader that starts too early would show them.
  if (shift === 4) header.set(latin1("ZZZZ"), 216);
  header.set(latin1(options.release ?? "9.0401M5"), 216 + shift);
  header.set(latin1(options.host ?? "X64_7PRO"), 224 + shift);
  return header;
}

function writePointer(view: DataView, index: number, offset: number, length: number, compression: number, type: number): void {
  const at = POINTERS_AT + index * POINTER_SIZE;
  view.setUint32(at, offset, true);
  view.setUint32(at + 4, length, true);
  view.setUint8(at + 8, compression);
  view.setUint8(at + 9, type);
}

/** Pointer type 1 is for the text, name, attribute and list subheaders; the sizes and the format subheaders are type 0. */
const TEXTUAL_SIGNATURES = new Set(["fdffffff", "ffffffff", "fcffffff", "feffffff"]);
const pointerType = (part: Uint8Array): number => (TEXTUAL_SIGNATURES.has(Buffer.from(part.subarray(0, 4)).toString("hex")) ? 1 : 0);

function signature(length: number, ...signatureBytes: number[]): Uint8Array {
  const part = new Uint8Array(length);
  part.set(signatureBytes, 0);
  return part;
}

function buildSubheaders(options: BuildOptions, rowLength: number): Uint8Array[] {
  const { columns, rows } = options;
  const blocks = Array.from({ length: options.textBlocks ?? 1 }, () => new TextBlock());
  const references = columns.map((column) => ({
    name: blocks[column.blocks?.name ?? 0]!.add(column.name, column.blocks?.name ?? 0),
    label: blocks[column.blocks?.label ?? 0]!.add(column.label ?? "", column.blocks?.label ?? 0),
    format: blocks[column.blocks?.format ?? 0]!.add(column.format?.name ?? "", column.blocks?.format ?? 0),
  }));

  const rowSize = signature(480, 0xf7, 0xf7, 0xf7, 0xf7);
  const rowSizeView = new DataView(rowSize.buffer);
  rowSizeView.setUint32(20, rowLength, true);
  rowSizeView.setUint32(24, rows.length, true);
  rowSizeView.setUint32(36, columns.length, true);

  const columnSize = signature(12, 0xf6, 0xf6, 0xf6, 0xf6);
  new DataView(columnSize.buffer).setUint32(4, columns.length, true);

  const names = signature(20 + 8 * columns.length, 0xff, 0xff, 0xff, 0xff);
  const namesView = new DataView(names.buffer);
  references.forEach((reference, index) => {
    namesView.setUint16(12 + 8 * index, reference.name.block, true);
    namesView.setUint16(14 + 8 * index, reference.name.offset, true);
    namesView.setUint16(16 + 8 * index, reference.name.length, true);
  });

  const attributes = signature(20 + 12 * columns.length, 0xfc, 0xff, 0xff, 0xff);
  const attributesView = new DataView(attributes.buffer);
  let offset = 0;
  columns.forEach((column, index) => {
    const at = 12 + 12 * index;
    attributesView.setUint32(at, offset, true);
    attributesView.setUint32(at + 4, column.width, true);
    attributesView.setUint16(at + 8, 0x0400, true);
    attributesView.setUint8(at + 10, column.type === "numeric" ? 1 : 2);
    offset += column.width;
  });

  const formats = columns.map((column, index) => {
    const part = signature(52, 0xfe, 0xfb, 0xff, 0xff);
    const view = new DataView(part.buffer);
    view.setUint16(12, column.format?.width ?? 0, true);
    view.setUint16(14, column.format?.precision ?? 0, true);
    view.setUint16(34, references[index]!.format.block, true);
    view.setUint16(36, references[index]!.format.offset, true);
    view.setUint16(38, references[index]!.format.length, true);
    view.setUint16(40, references[index]!.label.block, true);
    view.setUint16(42, references[index]!.label.offset, true);
    view.setUint16(44, references[index]!.label.length, true);
    return part;
  });

  return [rowSize, columnSize, signature(304, 0x00, 0xfc, 0xff, 0xff), ...blocks.map((block) => block.subheader()), names, attributes, ...formats];
}

/** The text block of the column text subheader: 32 bytes of its own header, then the strings the other subheaders point at. */
class TextBlock {
  readonly #parts: Uint8Array[] = [];
  #length = 32;

  add(value: string, block: number): { block: number; offset: number; length: number } {
    const bytes = latin1(value);
    const reference = { block, offset: this.#length, length: bytes.length };
    this.#parts.push(bytes);
    this.#length += bytes.length;
    return reference;
  }

  subheader(): Uint8Array {
    const block = new Uint8Array(this.#length);
    new DataView(block.buffer).setUint16(0, this.#length, true);
    let at = 32;
    for (const part of this.#parts) {
      block.set(part, at);
      at += part.length;
    }
    const part = new Uint8Array(4 + ((this.#length + 7) & ~7) + 8);
    part.set([0xfd, 0xff, 0xff, 0xff], 0);
    part.set(block, 4);
    return part;
  }
}

function encodeRow(columns: readonly BuiltColumn[], row: readonly CellValue[]): Uint8Array {
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
      // A missing number is the NaN that SAS writes: 00 00 00 00 00 00 fe ff, little-endian.
      if (value === null) eight.set([0, 0, 0, 0, 0, 0, 0xfe, 0xff]);
      else new DataView(eight.buffer).setFloat64(0, Number(value), true);
      // A narrower column keeps the high-order bytes of the double, which are the last ones in a little-endian file.
      out.set(eight.subarray(8 - column.width), offset);
    }
    offset += column.width;
  });
  return out;
}
