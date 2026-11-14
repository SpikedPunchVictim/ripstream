import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  UnsupportedFormatError,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { Sas7bdatParser } from "../src/sas7bdat.ts";
import { formatCell } from "../src/sas-format.ts";
import { readSasFile, type SasColumn, type SasValue } from "../src/sas7bdat-file.ts";
import { buildSas7bdat, HEADER_LENGTH, type BuildOptions, type BuiltColumn } from "./sas7bdat-builder.ts";

/*
 * Mutation tests for the SAS7BDAT reader (tikajs-68os.21): each test pins a behaviour of sas7bdat-file.ts, sas-format.ts or
 * sas7bdat.ts that the two files of Tika's test and sas7bdat.test.ts leave open. The parser is constructed directly, so
 * nothing here loads another parser's registration.
 *
 * Most of these files are built by sas7bdat-builder.ts, which was written by the author of the reader, from the same reading of
 * the format: where a test is about a layout only the builder has (the rows of a data page, the byte-35 alignment, a second
 * text block), it shows that the reader and the builder agree, not that SAS writes the layout so. The two real files are the
 * check on everything they contain.
 */

const PAGE0 = HEADER_LENGTH;
const POINTERS_AT = 24;
const POINTER_SIZE = 12;
const sig = (...bytes: number[]): number[] => bytes;
const ROW_SIZE = sig(0xf7, 0xf7, 0xf7, 0xf7);
const COLUMN_SIZE = sig(0xf6, 0xf6, 0xf6, 0xf6);
const COLUMN_TEXT = sig(0xfd, 0xff, 0xff, 0xff);
const COLUMN_NAME = sig(0xff, 0xff, 0xff, 0xff);
const COLUMN_ATTRIBUTES = sig(0xfc, 0xff, 0xff, 0xff);
const FORMAT_AND_LABEL = sig(0xfe, 0xfb, 0xff, 0xff);

const COLUMNS: BuiltColumn[] = [
  { name: "n", type: "numeric", width: 8 },
  { name: "c", type: "character", width: 6 },
];
const ROWS: Array<Array<number | string | null>> = [
  [1, "a"],
  [2, "b"],
];
const base = (options: Partial<BuildOptions> = {}): Uint8Array => buildSas7bdat({ columns: COLUMNS, rows: ROWS, ...options });

const viewOf = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);
const rowsOf = (data: Uint8Array): SasValue[][] => [...readSasFile(data).rows()];

/** What reading the file does: its refusal, or "accepted"; any other error is a defect and is thrown. */
function outcome(data: Uint8Array): string {
  try {
    rowsOf(data);
  } catch (error) {
    if (error instanceof MalformedDocumentError) return `malformed: ${error.message}`;
    if (error instanceof UnsupportedFormatError) return `unsupported: ${error.message}`;
    throw error;
  }
  return "accepted";
}

/** The pointer slot, offset and length of the subheader of page 0 that starts with the signature. */
function pointerOf(data: Uint8Array, signature: number[], page = PAGE0): { slot: number; offset: number; length: number } {
  const view = viewOf(data);
  const count = view.getUint16(page + 20, true);
  for (let index = 0; index < count; index++) {
    const slot = page + POINTERS_AT + index * POINTER_SIZE;
    const offset = view.getUint32(slot, true);
    const length = view.getUint32(slot + 4, true);
    if (length >= 4 && signature.every((byte, at) => data[page + offset + at] === byte)) return { slot, offset: page + offset, length };
  }
  throw new Error("no such subheader");
}

/** The offsets of every subheader of page 0 that starts with the signature. */
function offsetsOf(data: Uint8Array, signature: number[]): number[] {
  const view = viewOf(data);
  const found: number[] = [];
  for (let index = 0; index < view.getUint16(PAGE0 + 20, true); index++) {
    const slot = PAGE0 + POINTERS_AT + index * POINTER_SIZE;
    const offset = PAGE0 + view.getUint32(slot, true);
    if (view.getUint32(slot + 4, true) >= 4 && signature.every((byte, at) => data[offset + at] === byte)) found.push(offset);
  }
  return found;
}

const copy = (data: Uint8Array): Uint8Array => Uint8Array.from(data);

/** The file with a page of 4096 bytes added after the others; `fill` writes it, and the page count follows. */
function withPage(data: Uint8Array, fill: (page: Uint8Array, view: DataView) => void, pageLength = 4096): Uint8Array {
  const out = new Uint8Array(data.length + pageLength);
  out.set(data, 0);
  const page = out.subarray(data.length);
  fill(page, new DataView(page.buffer, page.byteOffset, page.byteLength));
  const view = viewOf(out);
  view.setInt32(204, view.getInt32(204, true) + 1, true);
  return out;
}

/** The file with a page of type 0 that has one pointer, at offset 100 and as long as `bytes`, which are what is there. */
function withSubheader(data: Uint8Array, bytes: Uint8Array): Uint8Array {
  return withPage(data, (page, view) => {
    view.setUint16(20, 1, true);
    view.setUint32(POINTERS_AT, 100, true);
    view.setUint32(POINTERS_AT + 4, bytes.length, true);
    page.set(bytes, 100);
  });
}

const subheaderBytes = (data: Uint8Array, signature: number[], length?: number): Uint8Array => {
  const found = pointerOf(data, signature);
  return data.slice(found.offset, found.offset + (length ?? found.length));
};

// ---- the header ----

/** The first 288 bytes of a file with a header and nothing else: the least a header can be. */
function stub(edit: (view: DataView) => void = () => {}): Uint8Array {
  const data = base().slice(0, 288);
  const view = viewOf(data);
  view.setInt32(196, 288, true);
  view.setInt32(204, 0, true);
  edit(view);
  return data;
}

test("a header of exactly the least length is read, and one byte less is not a SAS7BDAT file", () => {
  assert.equal(outcome(stub()), "malformed: SAS7BDAT has no size subheaders");
  assert.equal(outcome(base().slice(0, 287)), "malformed: Not a SAS7BDAT file");
});

test("a header length of 288 up to the length of the file is valid, and 287 or one past the file is not", () => {
  assert.equal(outcome(stub((view) => view.setInt32(196, 288, true))), "malformed: SAS7BDAT has no size subheaders");
  assert.equal(outcome(stub((view) => view.setInt32(196, 287, true))), "malformed: SAS7BDAT header length is not valid");
  assert.equal(outcome(stub((view) => view.setInt32(196, 289, true))), "malformed: SAS7BDAT header length is not valid");
});

test("a page length of 24 is valid and 23 is not", () => {
  assert.equal(outcome(stub((view) => view.setInt32(200, 24, true))), "malformed: SAS7BDAT has no size subheaders");
  assert.equal(outcome(stub((view) => view.setInt32(200, 23, true))), "malformed: SAS7BDAT page length is not valid");
  assert.equal(outcome(stub((view) => view.setInt32(200, -1, true))), "malformed: SAS7BDAT page length is not valid");
});

test("a page count of none is valid and a negative one is not", () => {
  assert.equal(outcome(stub((view) => view.setInt32(204, 0, true))), "malformed: SAS7BDAT has no size subheaders");
  assert.equal(outcome(stub((view) => view.setInt32(204, -1, true))), "malformed: SAS7BDAT page count is not valid");
  assert.equal(outcome(stub((view) => view.setInt32(204, 1, true))), "malformed: SAS7BDAT is cut short");
});

test("a byte order that is neither of the two is refused as malformed", () => {
  const data = base();
  data[37] = 2;
  assert.equal(outcome(data), "malformed: SAS7BDAT has an unknown byte order");
});

test("the layout of byte 35 puts the page fields and the timestamps four bytes further in", () => {
  const options = {
    name: "ALIGNED",
    created: 86400,
    modified: 172800,
    release: "9.4M7",
    host: "HOST_NAME_12",
    rows: [[1, "a"], [2, "b"], [3, "c"]],
  };
  for (const alignment of [0, 4] as const) {
    const sas = readSasFile(base({ ...options, alignment }));
    assert.equal(sas.properties.name, "ALIGNED", `${alignment}`);
    assert.equal(sas.properties.created?.toISOString(), "1960-01-02T00:00:00.000Z", `${alignment}`);
    assert.equal(sas.properties.modified?.toISOString(), "1960-01-03T00:00:00.000Z", `${alignment}`);
    assert.equal(sas.properties.sasRelease, "9.4M7", `${alignment}`);
    assert.equal(sas.properties.serverType, "HOST_NAME_12", `${alignment}`);
    assert.equal(sas.properties.pageCount, 1, `${alignment}`);
    assert.deepEqual([...sas.rows()], options.rows, `${alignment}`);
  }
});

test("a name of the full sixty-four characters, and one with accents, are read whole", () => {
  assert.equal(readSasFile(base({ name: "N".repeat(64) })).properties.name, "N".repeat(64));
  assert.equal(readSasFile(base({ name: "CAF\xc9 \xff" })).properties.name, "CAF\xc9 \xff");
});

test("the page count of the properties is the page count of the file", () => {
  assert.equal(readSasFile(base()).properties.pageCount, 1);
  const rows = Array.from({ length: 1000 }, (_, index) => [index, "x"]);
  const sas = readSasFile(base({ rows }));
  assert.ok(sas.properties.pageCount > 1);
  assert.equal(sas.properties.pageCount, (base({ rows }).length - HEADER_LENGTH) / 4096);
  assert.equal(sas.properties.columnCount, 2);
  assert.equal(sas.properties.rowCount, 1000);
});

test("the creation and modification dates are the two timestamps, the first for creation", () => {
  const sas = readSasFile(base({ created: 86400, modified: 3 * 86400 }));
  assert.equal(sas.properties.created?.toISOString(), "1960-01-02T00:00:00.000Z");
  assert.equal(sas.properties.modified?.toISOString(), "1960-01-04T00:00:00.000Z");
});

test("a date is kept to the last instant a Date can hold, either side, and left out beyond it", () => {
  const MAX_SECONDS = 8_640_315_619_200;
  const MIN_SECONDS = -8_639_684_380_800;
  assert.equal(readSasFile(base({ created: MAX_SECONDS })).properties.created?.getTime(), 8.64e15);
  assert.equal(readSasFile(base({ created: MAX_SECONDS + 1 })).properties.created, null);
  assert.equal(readSasFile(base({ created: MIN_SECONDS })).properties.created?.getTime(), -8.64e15);
  assert.equal(readSasFile(base({ created: MIN_SECONDS - 1 })).properties.created, null);
  assert.equal(readSasFile(base({ created: Number.NaN })).properties.created, null);
  assert.equal(readSasFile(base({ created: Infinity })).properties.created, null);
});

test("the encoding byte at offset 70 names the charset of the file, and an unknown one names none", () => {
  const names = new Map<number, string>([[20, "UTF-8"], [29, "ISO-8859-1"]]);
  for (let byte = 60; byte <= 68; byte++) names.set(byte, `windows-${1250 + byte - 60}`);
  for (const [byte, name] of names) assert.equal(readSasFile(base({ encodingByte: byte })).properties.encoding, name, `byte ${byte}`);
  for (const byte of [0, 19, 21, 59, 255]) assert.equal(readSasFile(base({ encodingByte: byte })).properties.encoding, null, `byte ${byte}`);
  assert.equal(readSasFile(base({ encodingByte: 28 })).properties.encoding, "US-ASCII");
  assert.equal(readSasFile(base({ encodingByte: 30 })).properties.encoding, "ISO-8859-2");
  assert.equal(readSasFile(base({ encodingByte: 69 })).properties.encoding, "x-MacRoman");
});

test("character values are decoded in the charset of the file, and in windows-1252 where it is not known", () => {
  const columns: BuiltColumn[] = [{ name: "c", type: "character", width: 6 }];
  const valueFor = (encodingByte: number, value: string): SasValue => rowsOf(base({ columns, rows: [[value]], encodingByte }))[0]![0]!;
  // The two bytes of the UTF-8 for e acute.
  assert.equal(valueFor(20, "\xc3\xa9"), "\xe9");
  assert.equal(valueFor(29, "\xc3\xa9"), "\xc3\xa9");
  assert.equal(valueFor(62, "\xc3\xa9"), "\xc3\xa9");
  // 0x8a is S caron in windows-1252, and a different letter in windows-1251.
  assert.equal(valueFor(0, "\x8a"), "Š");
  assert.equal(valueFor(255, "\x8a"), "Š");
  assert.equal(valueFor(61, "\x8a"), "Љ");
});

test("trimming takes off every character up to the space from both ends, and no other", () => {
  const columns: BuiltColumn[] = [{ name: "  nm\t", type: "character", width: 8 }];
  const sas = readSasFile(base({ columns, rows: [["\0 !a!\t "], ["!!"], ["\x01\x02"]] }));
  assert.equal(sas.columns[0]!.name, "nm");
  assert.deepEqual([...sas.rows()], [["!a!"], ["!!"], [""]]);
});

// ---- page types ----

const typeOfFirstPage = (data: Uint8Array, type: number): Uint8Array => {
  const out = copy(data);
  viewOf(out).setInt16(PAGE0 + 16, type, true);
  return out;
};

test("pages of type 0, 512, 640 and 1024 are searched for subheaders, and only the mixed ones give rows", () => {
  for (const type of [0, 512, 640, 1024]) {
    assert.equal(outcome(typeOfFirstPage(base(), type)), "accepted", `type ${type}`);
  }
  // Only the mixed pages carry the rows of the first page; the others have none of their own.
  assert.deepEqual(rowsOf(typeOfFirstPage(base(), 512)), ROWS);
  assert.deepEqual(rowsOf(typeOfFirstPage(base(), 640)), ROWS);
  assert.deepEqual(rowsOf(typeOfFirstPage(base(), 0)), []);
  assert.deepEqual(rowsOf(typeOfFirstPage(base(), 1024)), []);
});

test("pages of another type are not searched for subheaders", () => {
  for (const type of [1, 2, 256, 513, 641, 1023, 1025]) {
    assert.equal(outcome(typeOfFirstPage(base(), type)), "malformed: SAS7BDAT has no size subheaders", `type ${type}`);
  }
});

// ---- the subheader pointers of a page ----

test("an empty pointer is skipped whatever offset it has", () => {
  const data = base();
  const count = viewOf(data).getUint16(PAGE0 + 20, true);
  const slot = PAGE0 + POINTERS_AT + (count - 1) * POINTER_SIZE;
  assert.equal(viewOf(data).getUint32(slot + 4, true), 0);
  viewOf(data).setUint32(slot, 0xffffffff, true);
  assert.deepEqual(rowsOf(data), ROWS);
});

test("the pointers of a page may fill it exactly, and not more", () => {
  const pageLength = 4104;
  const data = base({ pageLength });
  // (4104 - 24) / 12 pointers fill the page to its last byte; the page of type 0 added has only empty ones.
  const filled = withPage(data, (_page, view) => view.setUint16(20, 340, true), pageLength);
  assert.equal(outcome(filled), "accepted");
  const over = withPage(data, (_page, view) => view.setUint16(20, 341, true), pageLength);
  assert.equal(outcome(over), "malformed: SAS7BDAT subheader pointers run past the page");
});

test("a subheader may end at the end of its page, and not past it", () => {
  const pointer = (offset: number, length: number) => (_page: Uint8Array, view: DataView) => {
    view.setUint16(20, 1, true);
    view.setUint32(POINTERS_AT, offset, true);
    view.setUint32(POINTERS_AT + 4, length, true);
  };
  assert.equal(outcome(withPage(base(), pointer(4092, 4))), "accepted");
  assert.equal(outcome(withPage(base(), pointer(4094, 4))), "malformed: SAS7BDAT subheader runs past its page");
  assert.equal(outcome(withPage(base(), pointer(0xfffffff0, 0x20))), "malformed: SAS7BDAT subheader runs past its page");
});

test("the subheaders read together are no more than the file holds", () => {
  const data = base();
  const count = viewOf(data).getUint16(PAGE0 + 20, true);
  let used = 0;
  for (let index = 0; index < count; index++) used += viewOf(data).getUint32(PAGE0 + POINTERS_AT + index * POINTER_SIZE + 4, true);
  // Two more pages: the second holds two pointers, whose lengths come to what is left of the file once the page is added.
  const pointers = (extra: number) => (_page: Uint8Array, view: DataView) => {
    const left = data.length + 4096 - used + extra;
    assert.ok(left > 4096 && left <= 8192, `${left}`);
    view.setUint16(20, 2, true);
    view.setUint32(POINTERS_AT + 4, 4096, true);
    view.setUint32(POINTERS_AT + POINTER_SIZE + 4, left - 4096, true);
  };
  assert.equal(outcome(withPage(data, pointers(0))), "accepted");
  assert.equal(outcome(withPage(data, pointers(1))), "malformed: SAS7BDAT subheaders overlap");
});

// ---- the least length of each subheader ----

test("a subheader of under four bytes is left alone, and of four bytes it is read for what it is", () => {
  assert.equal(outcome(withSubheader(base(), Uint8Array.of(0xf7, 0xf7, 0xf7))), "accepted");
  assert.equal(outcome(withSubheader(base(), Uint8Array.from(ROW_SIZE))), "malformed: SAS7BDAT row size subheader is too short");
  assert.equal(outcome(withSubheader(base(), Uint8Array.from(COLUMN_SIZE))), "malformed: SAS7BDAT column size subheader is too short");
});

test("the row size subheader is read from 64 bytes and not from fewer", () => {
  const data = base();
  assert.deepEqual(rowsOf(withSubheader(data, subheaderBytes(data, ROW_SIZE, 64))), ROWS);
  assert.equal(outcome(withSubheader(data, subheaderBytes(data, ROW_SIZE, 63))), "malformed: SAS7BDAT row size subheader is too short");
});

test("the column size subheader is read from 8 bytes and not from fewer", () => {
  const data = base();
  assert.deepEqual(rowsOf(withSubheader(data, subheaderBytes(data, COLUMN_SIZE, 8))), ROWS);
  assert.equal(outcome(withSubheader(data, subheaderBytes(data, COLUMN_SIZE, 7))), "malformed: SAS7BDAT column size subheader is too short");
});

test("a column text subheader is read from 6 bytes, and its size is the end of what it holds", () => {
  const text = (size: number, length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    bytes.set(COLUMN_TEXT, 0);
    bytes[4] = size & 0xff;
    bytes[5] = size >> 8;
    return bytes;
  };
  assert.equal(outcome(withSubheader(base(), text(2, 6))), "accepted");
  assert.equal(outcome(withSubheader(base(), text(0, 6))), "accepted");
  assert.equal(outcome(withSubheader(base(), text(2, 5))), "malformed: SAS7BDAT column text subheader is too short");
  assert.equal(outcome(withSubheader(base(), text(3, 6))), "malformed: SAS7BDAT text block runs past its subheader");
  assert.equal(outcome(withSubheader(base(), text(0xffff, 6))), "malformed: SAS7BDAT text block runs past its subheader");
});

test("a format and label subheader is read from 46 bytes and not from fewer", () => {
  const data = base();
  assert.deepEqual(rowsOf(withSubheader(data, subheaderBytes(data, FORMAT_AND_LABEL, 46))), ROWS);
  assert.equal(outcome(withSubheader(data, subheaderBytes(data, FORMAT_AND_LABEL, 45))), "malformed: SAS7BDAT format and label subheader is too short");
});

test("the names and attributes of a subheader are the whole entries it holds, to the last eight bytes", () => {
  const withLength = (signature: number[], change: number): Uint8Array => {
    const data = base();
    const found = pointerOf(data, signature);
    viewOf(data).setUint32(found.slot + 4, found.length + change, true);
    return data;
  };
  const mismatch = "malformed: SAS7BDAT column count does not match its column subheaders";
  // Two names of 8 bytes each after 12, then 8 bytes that are not entries: an entry is read while 6 bytes of it fit before them.
  assert.equal(outcome(withLength(COLUMN_NAME, 5)), "accepted");
  assert.equal(outcome(withLength(COLUMN_NAME, 6)), mismatch);
  assert.equal(outcome(withLength(COLUMN_NAME, -2)), "accepted");
  assert.equal(outcome(withLength(COLUMN_NAME, -3)), mismatch);
  // The attributes are 12 bytes each, of which 11 have to fit.
  assert.equal(outcome(withLength(COLUMN_ATTRIBUTES, 10)), "accepted");
  assert.equal(outcome(withLength(COLUMN_ATTRIBUTES, 11)), mismatch);
  assert.equal(outcome(withLength(COLUMN_ATTRIBUTES, -1)), "accepted");
  assert.equal(outcome(withLength(COLUMN_ATTRIBUTES, -2)), mismatch);
});

// ---- the columns ----

test("a file without a row size, or without a column size, is refused for it", () => {
  for (const signature of [ROW_SIZE, COLUMN_SIZE]) {
    const data = base();
    data.fill(0, pointerOf(data, signature).offset, pointerOf(data, signature).offset + 4);
    assert.equal(outcome(data), "malformed: SAS7BDAT has no size subheaders");
  }
});

test("a file of no columns is refused", () => {
  assert.equal(outcome(buildSas7bdat({ columns: [], rows: [] })), "malformed: SAS7BDAT column count does not match its column subheaders");
});

test("a numeric column is up to eight bytes wide, and a character one may be wider", () => {
  const numeric = (width: number): string => outcome(buildSas7bdat({ columns: [{ name: "n", type: "numeric", width }], rows: [] }));
  assert.equal(numeric(8), "accepted");
  assert.equal(numeric(9), "malformed: SAS7BDAT column does not fit in its row");
  assert.equal(outcome(buildSas7bdat({ columns: [{ name: "c", type: "character", width: 40 }], rows: [["x"]] })), "accepted");
});

test("a column that runs past the row is refused for that, and columns that together exceed the row are refused for that", () => {
  const shortRow = base();
  viewOf(shortRow).setUint32(pointerOf(shortRow, ROW_SIZE).offset + 20, 13, true);
  assert.equal(outcome(shortRow), "malformed: SAS7BDAT column does not fit in its row");

  // Both columns start at 0 and each fits in 13 bytes; their widths, 8 and 6, do not.
  const overlapping = base();
  viewOf(overlapping).setUint32(pointerOf(overlapping, ROW_SIZE).offset + 20, 13, true);
  viewOf(overlapping).setUint32(pointerOf(overlapping, COLUMN_ATTRIBUTES).offset + 12 + 12, 0, true);
  assert.equal(outcome(overlapping), "malformed: SAS7BDAT columns are wider than their row");
});

test("a column without a format and label subheader has no label and no format", () => {
  const columns: BuiltColumn[] = [
    { name: "a", type: "numeric", width: 8, label: "First", format: { name: "DATE", width: 9, precision: 1 } },
    { name: "b", type: "character", width: 6, label: "Second", format: { name: "$CHAR", width: 6, precision: 0 } },
  ];
  const data = base({ columns, rows: [] });
  const formats = offsetsOf(data, FORMAT_AND_LABEL);
  assert.equal(formats.length, 2);
  // The subheaders are placed last to first from the end of the page, so the lowest offset is the second column's.
  data.fill(0, Math.min(...formats), Math.min(...formats) + 4);
  const sas = readSasFile(data);
  assert.equal(sas.columns[0]!.label, "First");
  assert.deepEqual(sas.columns[0]!.format, { name: "DATE", width: 9, precision: 1 });
  assert.equal(sas.columns[1]!.name, "b");
  assert.equal(sas.columns[1]!.label, "");
  assert.equal(sas.columns[1]!.format, null);
});

test("a format has its own width and precision, in that order", () => {
  const columns: BuiltColumn[] = [{ name: "a", type: "numeric", width: 8, format: { name: "COMMA", width: 12, precision: 3 } }];
  assert.deepEqual(readSasFile(base({ columns, rows: [] })).columns[0]!.format, { name: "COMMA", width: 12, precision: 3 });
  // A column whose format has no name has no format, whatever its width and precision.
  const nameless: BuiltColumn[] = [{ name: "a", type: "numeric", width: 8, format: { name: "", width: 12, precision: 3 } }];
  assert.equal(readSasFile(base({ columns: nameless, rows: [] })).columns[0]!.format, null);
});

test("the strings of a column may be in any of the text blocks, each named by its own number", () => {
  const columns: BuiltColumn[] = [
    { name: "a", type: "numeric", width: 8, label: "A label", format: { name: "DATE", width: 9, precision: 2 }, blocks: { label: 1, format: 1 } },
    { name: "b", type: "character", width: 4, label: "Other", format: { name: "$CHAR", width: 4 }, blocks: { name: 1, label: 0, format: 1 } },
  ];
  const sas = readSasFile(base({ columns, rows: [], textBlocks: 2 }));
  assert.deepEqual(
    sas.columns.map((column) => [column.name, column.label, column.format]),
    [
      ["a", "A label", { name: "DATE", width: 9, precision: 2 }],
      ["b", "Other", { name: "$CHAR", width: 4, precision: 0 }],
    ],
  );
});

test("compression is named by the first text block only, and either literal in it is read as a compressed file", () => {
  // Compressed files are read in sas7bdat-layouts.test.ts; here only that naming it does not refuse the file.
  const named = (name: string, blocks?: BuiltColumn["blocks"], textBlocks = 1): string =>
    outcome(base({ columns: [{ name, type: "numeric", width: 8, blocks }], rows: [], textBlocks }));
  assert.equal(named("SASYZCRL"), "accepted");
  assert.equal(named("SASYZCR2"), "accepted");
  assert.equal(named("xx SASYZCR2 xx"), "accepted");
  assert.equal(named("SASYZCRL", { name: 0 }, 2), "accepted");
  assert.equal(named("SASYZCRL", { name: 1 }, 2), "accepted");
  assert.equal(named("SASYZCRX"), "accepted");
});

// ---- rows ----

test("the rows of a mixed page begin on the next multiple of eight after its pointers", () => {
  // Nine pointers end at byte 132 of the page, which is not one.
  const data = base();
  assert.equal(viewOf(data).getUint16(PAGE0 + 20, true), 9);
  assert.deepEqual(rowsOf(data), ROWS);
});

test("rows go on from the first page to the data pages only as far as the file says it has them", () => {
  const rows = [[1, "a"], [2, "b"], [3, "c"], [4, "d"], [5, "e"]];
  const data = base({ rows, rowsOnMixPage: 2 });
  assert.deepEqual(rowsOf(data), rows);
  viewOf(data).setUint32(pointerOf(data, ROW_SIZE).offset + 24, 3, true);
  assert.deepEqual(rowsOf(data), rows.slice(0, 3));
  viewOf(data).setUint32(pointerOf(data, ROW_SIZE).offset + 24, 2, true);
  assert.deepEqual(rowsOf(data), rows.slice(0, 2));
});

test("a data page gives the rows its block count says, no more than its bytes hold", () => {
  const data = base({ rows: [], rowsOnMixPage: 0 });
  const rowSize = pointerOf(data, ROW_SIZE).offset;
  viewOf(data).setUint32(rowSize + 24, 100_000, true);
  const mixCount = viewOf(data).getUint32(rowSize + 60, true);
  const forged = withPage(data, (_page, view) => {
    view.setInt16(16, 256, true);
    view.setUint16(18, 65535, true);
  });
  // The pages are 4096 bytes and a row is 14: after the 24 bytes of the header there is room for 290, and not for a 291st.
  assert.equal(rowsOf(forged).length, mixCount + 290);
  const few = withPage(data, (_page, view) => {
    view.setInt16(16, 256, true);
    view.setUint16(18, 7, true);
  });
  assert.equal(rowsOf(few).length, mixCount + 7);
});

// ---- the text of the cells and the document ----

const numeric = (format: string | null, precision = 0): SasColumn => ({
  name: "x",
  label: "",
  type: "numeric",
  offset: 0,
  width: 8,
  format: format === null ? null : { name: format, width: 0, precision },
});

test("a format name is read whatever its case", () => {
  assert.equal(formatCell(numeric("date"), 0), "01Jan1960");
  assert.equal(formatCell(numeric("DdMmYyD"), 0), "01-01-1960");
  assert.equal(formatCell(numeric("percent", 1), 0.25), "25%");
});

test("each letter at the end of a date format names what is between its parts", () => {
  // 31 days after the start of 1960 is the 1st of February, which has a different day and month.
  const day = 31;
  const expected: Array<[string, string]> = [
    ["DDMMYYB", "01 02 1960"],
    ["DDMMYYC", "01:02:1960"],
    ["DDMMYYD", "01-02-1960"],
    ["DDMMYYN", "01021960"],
    ["DDMMYYP", "01.02.1960"],
    ["DDMMYYS", "01/02/1960"],
    ["DDMMYY", "01/02/1960"],
    ["MMDDYYB", "02 01 1960"],
    ["MMDDYYC", "02:01:1960"],
    ["MMDDYYD", "02-01-1960"],
    ["MMDDYYN", "02011960"],
    ["MMDDYYP", "02.01.1960"],
    ["MMDDYYS", "02/01/1960"],
    ["MMDDYY", "02/01/1960"],
    ["YYMMDDB", "1960 02 01"],
    ["YYMMDDC", "1960:02:01"],
    ["YYMMDDD", "1960-02-01"],
    ["YYMMDDN", "19600201"],
    ["YYMMDDP", "1960.02.01"],
    ["YYMMDDS", "1960/02/01"],
    ["YYMMDD", "1960-02-01"],
  ];
  for (const [name, text] of expected) assert.equal(formatCell(numeric(name), day), text, name);
});

test("a format name that only begins like a date format is not one", () => {
  for (const name of ["DDMMYYX", "DDMMYYSS", "DDMMYY10", "XDDMMYY", "DATETIME20", "DATE9", "PERCENT8"]) {
    assert.equal(formatCell(numeric(name), 31), "31", name);
  }
  // TIMEAMPM is a time format, whose cells DataWriterUtil writes as hours, minutes and seconds.
  assert.equal(formatCell(numeric("TIMEAMPM"), 31), "00:00:31");
});

test("a date is the whole days, a datetime and a time the seconds to the millisecond", () => {
  assert.equal(formatCell(numeric("DATE"), 31.9), "01Feb1960");
  assert.equal(formatCell(numeric("DATE"), -0.5), "31Dec1959");
  assert.equal(formatCell(numeric("DATE"), 1), "02Jan1960");
  assert.equal(formatCell(numeric("DATETIME"), 1.9996), "01Jan1960:00:00:02.00");
  // parso truncates the millisecond of the epoch difference toward zero, as Java's cast does.
  assert.equal(formatCell(numeric("DATETIME"), 0.0004), "01Jan1960:00:00:00.01");
  assert.equal(formatCell(numeric("TIME"), 59.9996), "00:00:59");
  assert.equal(formatCell(numeric("DATETIME"), 86400 * 366 + 0.25), "01Jan1961:00:00:00.250");
});

test("every month has its name, and the day, hour, minute and second their own two digits", () => {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  names.forEach((name, month) => {
    const days = (Date.UTC(1961, month, 5) - Date.UTC(1960, 0, 1)) / 86_400_000;
    assert.equal(formatCell(numeric("DATE"), days), `05${name}1961`, name);
  });
  assert.equal(formatCell(numeric("DATETIME"), 9 * 3600 + 8 * 60 + 7), "01Jan1960:09:08:07.00");
  assert.equal(formatCell(numeric("DATETIME"), 86400 * 365 + 23 * 3600 + 22 * 60 + 21), "31Dec1960:23:22:21.00");
});

test("a date beyond what a Date can hold is written as the number it is", () => {
  // SAS removes the leap days of 4000 and 8000, so parso adds them back and the last day of a Date passes its end.
  const last = (8.64e15 + 315_619_200_000) / 86_400_000;
  assert.equal(formatCell(numeric("DATE"), last), String(last));
  assert.equal(formatCell(numeric("DATE"), last + 1), String(last + 1));
  const first = (-8.64e15 + 315_619_200_000) / 86_400_000;
  assert.equal(formatCell(numeric("DATE"), first), "20Nov-271816");
  assert.equal(formatCell(numeric("DATE"), first - 1), String(first - 1));
  assert.equal(formatCell(numeric("DATE"), NaN), "NaN");
  assert.equal(formatCell(numeric("DATETIME"), -Infinity), "-Infinity");
});

test("a year of fewer than four digits is padded to four", () => {
  // Year 1000 and the years before 1000 are in the range of a Date; 1960 minus 1960 years is the year 0.
  const days = (Date.UTC(900, 5, 1) - Date.UTC(1960, 0, 1)) / 86_400_000;
  assert.equal(formatCell(numeric("DATE"), days), "27May0900");
});

test("a percent is a number text, not a fixed number of digits", () => {
  assert.equal(formatCell(numeric("PERCENT", 3), 0.5), "50%");
  assert.equal(formatCell(numeric("PERCENT", 3), 0.12345), "12.345%");
  assert.equal(formatCell(numeric("PERCENT", 0), 0.125), "13%");
  assert.equal(formatCell(numeric("PERCENT", 200), 0.5), "50%");
  assert.equal(formatCell(numeric("PERCENT", 2), 1 / 3), "33.33%");
});

test("a whole number has no decimal point, and a fraction is written as it is to fifteen digits", () => {
  // Java's Double.toString and DataWriterUtil's trim: one digit before the point and an upper-case exponent.
  assert.equal(formatCell(numeric(null), 1e21), "1.0E21");
  // Sixteen digits are more than fifteen, and a whole number is not rounded to them.
  assert.equal(formatCell(numeric(null), 1234567890123456), "1234567890123456");
  assert.equal(formatCell(numeric(null), 100), "100");
  assert.equal(formatCell(numeric(null), 123456789.123456789), "1.23456789123457E8");
  assert.equal(formatCell(numeric("COMMA"), 5), "5");
});

// ---- the parser ----

async function parse(data: Uint8Array, context = new ParseContext()): Promise<{ metadata: Metadata; xml: string }> {
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  const handler = createOutputHandler("xml");
  try {
    await new Sas7bdatParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { metadata, xml: handler.toString() };
}

const DOCUMENT = (): Uint8Array =>
  buildSas7bdat({
    name: "SMALL",
    created: 86400,
    modified: 172800,
    release: "9.4M7",
    host: "HOSTX",
    columns: [
      { name: "n", type: "numeric", width: 8, label: "The N", format: { name: "DATE", width: 9, precision: 0 } },
      { name: "c", type: "character", width: 6 },
    ],
    rows: [[1, "a"], [null, ""]],
  });

test("the parser names itself and the type it reads", () => {
  const parser = new Sas7bdatParser();
  assert.equal(parser.name, "SAS7BDATParser");
  assert.deepEqual([...parser.getSupportedTypes()].map(String), ["application/x-sas-data"]);
});

test("the metadata of a file is its properties under the keys Tika gives them, in that order", async () => {
  const { metadata } = await parse(DOCUMENT());
  assert.deepEqual(metadata.names(), [
    "Content-Type",
    "dc:title",
    "dcterms:created",
    "dcterms:modified",
    "xmpTPg:NPages",
    "database:column-count",
    "database:row-count",
    "Content-Encoding",
    "extended-properties:Application",
    "extended-properties:AppVersion",
    "machine:architectureBits",
    "machine:endian",
    "database:column-name",
  ]);
  assert.equal(metadata.get("Content-Type"), "application/x-sas-data");
  assert.equal(metadata.get("dc:title"), "SMALL");
  assert.equal(metadata.get("dcterms:created"), "1960-01-02T00:00:00Z");
  assert.equal(metadata.get("dcterms:modified"), "1960-01-03T00:00:00Z");
  assert.equal(metadata.get("xmpTPg:NPages"), "1");
  assert.equal(metadata.get("database:column-count"), "2");
  assert.equal(metadata.get("database:row-count"), "2");
  assert.equal(metadata.get("Content-Encoding"), "windows-1252");
  assert.equal(metadata.get("extended-properties:Application"), "HOSTX");
  assert.equal(metadata.get("extended-properties:AppVersion"), "9.4M7");
  assert.equal(metadata.get("machine:architectureBits"), "32");
  assert.equal(metadata.get("machine:endian"), "Little");
  assert.deepEqual(metadata.getAll("database:column-name"), ["The N", "c"]);
});

test("a date the header cannot hold, and a charset it does not name, leave their keys out", async () => {
  const { metadata } = await parse(base({ created: 1e300, modified: -1e300, encodingByte: 0 }));
  assert.equal(metadata.has("dcterms:created"), false);
  assert.equal(metadata.has("dcterms:modified"), false);
  assert.equal(metadata.has("Content-Encoding"), false);
});

test("the document is the name over a table of the headings and the cells, with an empty cell kept", async () => {
  const { xml } = await parse(DOCUMENT());
  const body = xml.slice(xml.indexOf("<body>"));
  assert.equal(
    body,
    [
      "<body><h1>SMALL</h1>",
      "<table>",
      '<tr>\t<th title="n">The N</th>\t<th title="c">c</th></tr>',
      "",
      "<tr>\t<td>02Jan1960</td>\t<td>a</td></tr>",
      "",
      "<tr>\t<td></td>\t<td></td></tr>",
      "",
      "</table>",
      "</body></html>",
    ].join("\n"),
  );
});

test("an abort is noticed after every 256 rows, and not before", async () => {
  const rowsOfCount = (count: number): Uint8Array =>
    buildSas7bdat({ columns: [{ name: "n", type: "numeric", width: 8 }], rows: Array.from({ length: count }, (_, index) => [index]) });
  const aborted = (): ParseContext => {
    const controller = new AbortController();
    controller.abort();
    return new ParseContext({ signal: controller.signal });
  };
  const { metadata } = await parse(rowsOfCount(255), aborted());
  assert.equal(metadata.get("database:row-count"), "255");
  await assert.rejects(parse(rowsOfCount(256), aborted()), AbortError);
});
