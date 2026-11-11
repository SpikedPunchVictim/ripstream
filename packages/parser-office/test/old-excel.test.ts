import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortError,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { OldExcelParser, type OldExcelOptions } from "../src/index.ts";
import { javaDoubleString } from "../src/java-double.ts";

/*
 * Tika's OldExcelParser hands the file to POI's OldExcelExtractor, which is not among the sources read for this port, so
 * these tests build BIFF2, BIFF3 and BIFF4 streams from the published record layouts (BIFF2: a 3-byte cell attribute
 * block and 1-byte string lengths; BIFF3 and BIFF4: a 2-byte XF index and 2-byte string lengths) and expect what Tika's
 * OldExcelParserTest expects of testEXCEL_4.xls: one <p> per line of text, numbers written the way Java's
 * Double.toString writes them. Nothing here was run against a Tika.
 */

type Bytes = readonly number[];

const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number): number[] => [...u16(value & 0xffff), ...u16(value >>> 16)];

function f64(value: number): number[] {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [...bytes];
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

function rec(id: number, data: Bytes = []): number[] {
  return [...u16(id), ...u16(data.length), ...data];
}

const join = (...records: Bytes[]): Uint8Array => Uint8Array.from(records.flat());

// BIFF2 cells: row, column, three attribute bytes, then the value.
const attr2 = [0x00, 0x00, 0x00];
const bof2 = (type = 0x0010): number[] => rec(0x0009, [0x00, 0x00, ...u16(type)]);
const integer2 = (row: number, col: number, value: number): number[] =>
  rec(0x0002, [...u16(row), ...u16(col), ...attr2, ...u16(value)]);
const number2 = (row: number, col: number, value: number): number[] =>
  rec(0x0003, [...u16(row), ...u16(col), ...attr2, ...f64(value)]);
const label2 = (row: number, col: number, text: string): number[] =>
  rec(0x0004, [...u16(row), ...u16(col), ...attr2, text.length, ...ascii(text)]);
const formula2 = (row: number, col: number, result: Bytes): number[] =>
  rec(0x0006, [...u16(row), ...u16(col), ...attr2, ...result, 0x00, 0x00]);
const string2 = (text: string): number[] => rec(0x0007, [text.length, ...ascii(text)]);

// BIFF3 and BIFF4 cells: row, column, XF index, then the value.
const xf = [0x00, 0x00];
const bof = (id: 0x0209 | 0x0409, type = 0x0010): number[] => rec(id, [0x00, 0x00, ...u16(type), 0x00, 0x00]);
const number3 = (row: number, col: number, value: number): number[] =>
  rec(0x0203, [...u16(row), ...u16(col), ...xf, ...f64(value)]);
const label3 = (row: number, col: number, bytes: Bytes): number[] =>
  rec(0x0204, [...u16(row), ...u16(col), ...xf, ...u16(bytes.length), ...bytes]);
const rk3 = (row: number, col: number, rk: number): number[] =>
  rec(0x027e, [...u16(row), ...u16(col), ...xf, ...u32(rk)]);
const formula = (id: 0x0206 | 0x0406, row: number, col: number, result: Bytes): number[] =>
  rec(id, [...u16(row), ...u16(col), ...xf, ...result, 0x00, 0x00, 0x00, 0x00]);
const string3 = (text: string): number[] => rec(0x0207, [...u16(text.length), ...ascii(text)]);
const boolErr3 = (row: number, col: number, value: number, isError: number): number[] =>
  rec(0x0205, [...u16(row), ...u16(col), ...xf, value, isError]);
const blank3 = (row: number, col: number): number[] => rec(0x0201, [...u16(row), ...u16(col), ...xf]);
const codepage = (page: number): number[] => rec(0x0042, u16(page));
const eof = (): number[] => rec(0x000a);

// A formula's cached result: a double, or 0xFFFF in its last two bytes with the kind in its first byte.
const STRING_RESULT = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff];
const BOOLEAN_RESULT = [0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff];

interface Result {
  readonly xml: string;
  readonly paragraphs: string[];
  readonly metadata: Metadata;
}

async function run(
  data: Uint8Array,
  options: OldExcelOptions = {},
  context = new ParseContext(),
): Promise<Result> {
  const stream = await RipstreamInputStream.from(data);
  const handler = createOutputHandler("xml");
  const metadata = new Metadata();
  try {
    await new OldExcelParser(options).parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  const xml = handler.toString();
  const paragraphs = [...xml.matchAll(/<p>(.*?)<\/p>/gs)].map((match) => match[1]!);
  return { xml, paragraphs, metadata };
}

test("BIFF2 integer, number and label cells are one paragraph each, in file order", async () => {
  const result = await run(
    join(bof2(), integer2(0, 0, 7), number2(0, 1, 2.5), label2(1, 0, "Hello"), eof()),
  );
  assert.deepEqual(result.paragraphs, ["7.0", "2.5", "Hello"]);
});

test("BIFF3 number, RK and label cells; an RK writes an integer, a hundredth or a double", async () => {
  const integerRk = (5 << 2) | 0x02;
  const hundredthsRk = (150 << 2) | 0x03;
  const result = await run(
    join(
      bof(0x0209),
      number3(0, 0, 3),
      rk3(0, 1, integerRk),
      rk3(0, 2, hundredthsRk),
      label3(1, 0, ascii("Tax")),
      eof(),
    ),
  );
  assert.deepEqual(result.paragraphs, ["3.0", "5.0", "1.5", "Tax"]);
});

test("BIFF3 and BIFF4 formulas write a numeric result, and a string result from the STRING record that follows", async () => {
  for (const [bofId, formulaId] of [
    [0x0209, 0x0206],
    [0x0409, 0x0406],
  ] as const) {
    const result = await run(
      join(
        bof(bofId),
        formula(formulaId, 0, 0, f64(12)),
        formula(formulaId, 0, 1, STRING_RESULT),
        string3("from a formula"),
        eof(),
      ),
    );
    assert.deepEqual(result.paragraphs, ["12.0", "from a formula"], `BOF ${bofId.toString(16)}`);
  }
});

test("a BIFF2 formula with a string result takes its text from the BIFF2 STRING record", async () => {
  const result = await run(
    join(bof2(), formula2(0, 0, STRING_RESULT), string2("two"), formula2(0, 1, f64(0.5)), eof()),
  );
  assert.deepEqual(result.paragraphs, ["two", "0.5"]);
});

test("a STRING record that no string-valued formula precedes is not text", async () => {
  const result = await run(join(bof(0x0209), formula(0x0206, 0, 0, f64(1)), string3("stray"), eof()));
  assert.deepEqual(result.paragraphs, ["1.0"]);
});

test("boolean and blank cells, and records that hold no text, are not written", async () => {
  const result = await run(
    join(
      bof(0x0209),
      blank3(0, 0),
      boolErr3(0, 1, 1, 0),
      formula(0x0206, 0, 2, BOOLEAN_RESULT),
      rec(0x0008, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      label3(0, 3, ascii("kept")),
      eof(),
    ),
  );
  assert.deepEqual(result.paragraphs, ["kept"]);
});

test("numbers are written as Java's Double.toString writes them", () => {
  assert.equal(javaDoubleString(5), "5.0");
  assert.equal(javaDoubleString(0.001), "0.001");
  assert.equal(javaDoubleString(0.0001), "1.0E-4");
  assert.equal(javaDoubleString(1e7), "1.0E7");
  assert.equal(javaDoubleString(9999999), "9999999.0");
  assert.equal(javaDoubleString(-123456.789), "-123456.789");
  assert.equal(javaDoubleString(Number.NaN), "NaN");
});

test("a number cell in scientific range is written in Java's notation", async () => {
  const result = await run(join(bof(0x0209), number3(0, 0, 12345678), number3(0, 1, 0.00005), eof()));
  assert.deepEqual(result.paragraphs, ["1.2345678E7", "5.0E-5"]);
});

test("a label is decoded in the code page a CODEPAGE record names", async () => {
  const result = await run(join(bof(0x0209), codepage(1251), label3(0, 0, [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), eof()));
  assert.deepEqual(result.paragraphs, ["Привет"]);
});

test("a label is cut into lines as BufferedReader.readLine cuts the text", async () => {
  const result = await run(
    join(
      bof(0x0209),
      label3(0, 0, ascii("a\rb")),
      label3(0, 1, ascii("")),
      label3(0, 2, ascii("c\r")),
      label3(0, 3, ascii("d\r\ne")),
      eof(),
    ),
  );
  assert.deepEqual(result.paragraphs, ["a", "b", "", "c", "d", "e"]);
});

test("a workspace file has no cells and gives an empty document", async () => {
  const result = await run(join(bof(0x0409, 0x0100), rec(0x003d, [0, 0, 0, 0]), eof()));
  assert.deepEqual(result.paragraphs, []);
  assert.match(result.xml, /<body/);
});

// OldExcelExtractor's source is not in the cache; reading to the end of the data (not stopping at the first EOF record)
// is the choice made here, so a nested substream cannot cut the text short. Pinned so a change is deliberate.
test("the records after an EOF record are read too: reading ends with the data", async () => {
  const result = await run(join(bof(0x0209), label3(0, 0, ascii("one")), eof(), label3(1, 0, ascii("two"))));
  assert.deepEqual(result.paragraphs, ["one", "two"]);
});

test("input that does not open with a BIFF2-4 BOF record is malformed", async () => {
  const notBiff = [new Uint8Array(0), Uint8Array.of(0x09), join(rec(0x0203, [0, 0, 0, 0, 0, 0])), join(rec(0x0809, [0, 6, 5, 0]))];
  for (const data of notBiff) await assert.rejects(run(data), MalformedDocumentError);
});

function prefixesOf(data: Uint8Array): { length: number; recordBoundary: boolean }[] {
  const boundaries = new Set<number>();
  let offset = 0;
  while (offset + 4 <= data.byteLength) {
    offset += 4 + (data[offset + 2]! | (data[offset + 3]! << 8));
    boundaries.add(offset);
  }
  return Array.from({ length: data.byteLength + 1 }, (_, length) => ({
    length,
    recordBoundary: boundaries.has(length),
  }));
}

const VALID_FILES: Record<string, Uint8Array> = {
  BIFF2: join(bof2(), integer2(0, 0, 7), label2(0, 1, "Hi"), formula2(1, 0, STRING_RESULT), string2("fx"), eof()),
  BIFF3: join(bof(0x0209), number3(0, 0, 1), rk3(0, 1, 22), label3(1, 0, ascii("Hi")), formula(0x0206, 1, 1, STRING_RESULT), string3("fx"), eof()),
  BIFF4: join(bof(0x0409), codepage(1252), number3(0, 0, 1), label3(1, 0, ascii("Hi")), formula(0x0406, 1, 1, STRING_RESULT), string3("fx"), eof()),
};

for (const [name, data] of Object.entries(VALID_FILES)) {
  test(`every prefix of a ${name} file parses or is refused as malformed`, async () => {
    for (const { length, recordBoundary } of prefixesOf(data)) {
      const prefix = data.subarray(0, length);
      if (recordBoundary) await run(prefix);
      else await assert.rejects(run(prefix), MalformedDocumentError, `prefix of ${length} bytes`);
    }
  });
}

test("a record that declares more bytes than the file holds is malformed, whatever it declares", async () => {
  const declared = join(bof(0x0209), [0x04, 0x02, 0xff, 0xff, 0x00, 0x00]);
  await assert.rejects(run(declared), MalformedDocumentError);
});

test("a label whose length reaches past its record is malformed, and nothing is allocated by that length", async () => {
  const hostile = join(bof(0x0209), rec(0x0204, [0, 0, 0, 0, 0, 0, ...u16(0xffff), ...ascii("tiny")]));
  await assert.rejects(run(hostile), MalformedDocumentError);
  const hostile2 = join(bof2(), rec(0x0004, [0, 0, 0, 0, 0, 0, 0, 0xff, ...ascii("tiny")]));
  await assert.rejects(run(hostile2), MalformedDocumentError);
});

test("a number record too short for its value is malformed", async () => {
  const hostile = join(bof(0x0209), rec(0x0203, [0, 0, 0, 0, 0, 0, 1, 2, 3]));
  await assert.rejects(run(hostile), MalformedDocumentError);
});

test("more text cells than the cell cap is refused with LimitExceededError, and the cap itself is allowed", async () => {
  const cells = (count: number): Uint8Array =>
    join(bof(0x0209), ...Array.from({ length: count }, (_, i) => number3(0, i, i)));
  const options = { maxCells: 3 };
  assert.equal((await run(cells(3), options)).paragraphs.length, 3);
  await assert.rejects(run(cells(4), options), LimitExceededError);
});

test("more records than the record cap is refused with LimitExceededError", async () => {
  const records = (count: number): Uint8Array =>
    join(bof(0x0209), ...Array.from({ length: count }, () => rec(0x0008)));
  const options = { maxRecords: 5 };
  await run(records(4), options);
  await assert.rejects(run(records(5), options), LimitExceededError);
});

test("an aborted parse stops within the loop and does not read the rest of the records", async () => {
  const controller = new AbortController();
  controller.abort();
  const many = join(bof(0x0209), ...Array.from({ length: 600 }, () => rec(0x0008)));
  await assert.rejects(run(many, {}, new ParseContext({ signal: controller.signal })), AbortError);
});
