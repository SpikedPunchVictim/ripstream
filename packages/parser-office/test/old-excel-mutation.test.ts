import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { OldExcelParser } from "../src/index.ts";
import { javaDoubleString } from "../src/java-double.ts";

/*
 * Pins found by mutation testing the BIFF2-4 reader (tikajs-68os.18): record ids per version, the byte offsets of each
 * field, the exact length each record must have, the formula's string-pending state and the code-page rules. The record
 * layouts are the published BIFF2-4 ones, as in old-excel.test.ts, which these tests do not repeat.
 */

type Bytes = readonly number[];

const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number): number[] => [...u16(value & 0xffff), ...u16(value >>> 16)];

function f64(value: number): number[] {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [...bytes];
}

const rec = (id: number, data: Bytes = []): number[] => [...u16(id), ...u16(data.length), ...data];
const join = (...records: Bytes[]): Uint8Array => Uint8Array.from(records.flat());
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

const cellHead2 = [0, 0, 0, 0, 0, 0, 0]; // row, column, three attribute bytes
const cellHead3 = [0, 0, 0, 0, 0, 0]; // row, column, XF index
const STRING_RESULT = [0, 0, 0, 0, 0, 0, 0xff, 0xff];

const bof = (id: number): number[] => rec(id, [0, 0, 0x10, 0, 0, 0]);
const BOF2 = bof(0x0009);
const BOF3 = bof(0x0209);
const BOF4 = bof(0x0409);
const codepage = (page: number): number[] => rec(0x0042, u16(page));

async function paragraphs(data: Uint8Array): Promise<string[]> {
  const stream = await RipstreamInputStream.from(data);
  const handler = createOutputHandler("xml");
  try {
    await new OldExcelParser().parse(stream, handler, new Metadata(), new ParseContext());
  } finally {
    await stream.close();
  }
  return [...handler.toString().matchAll(/<p>(.*?)<\/p>/gs)].map((match) => match[1]!);
}

test("the parser names itself and the five types it claims, and needs random access", () => {
  const parser = new OldExcelParser();
  assert.equal(parser.name, "OldExcelParser");
  assert.equal(parser.capabilities.requiresRandomAccess, true);
  assert.deepEqual(
    [...parser.getSupportedTypes()].map(String).sort(),
    [
      "application/vnd.ms-excel.sheet.2",
      "application/vnd.ms-excel.sheet.3",
      "application/vnd.ms-excel.sheet.4",
      "application/vnd.ms-excel.workspace.3",
      "application/vnd.ms-excel.workspace.4",
    ],
  );
});

test("a stream of nothing but a BOF record is an empty document, in each version", async () => {
  for (const data of [rec(0x0009), rec(0x0209), rec(0x0409)]) {
    assert.deepEqual(await paragraphs(join(data)), []);
  }
});

test("a label with no CODEPAGE record is read as windows-1252, in each version", async () => {
  assert.deepEqual(await paragraphs(join(BOF2, rec(0x0004, [...cellHead2, 2, 0x80, 0xe9]))), ["€é"]);
  assert.deepEqual(await paragraphs(join(BOF3, rec(0x0204, [...cellHead3, ...u16(2), 0x80, 0xe9]))), ["€é"]);
  assert.deepEqual(await paragraphs(join(BOF4, rec(0x0204, [...cellHead3, ...u16(2), 0x80, 0xe9]))), ["€é"]);
});

test("a CODEPAGE record changes how later labels are read, in each version", async () => {
  const cyrillic = [0xcf, 0xf0, 0xe8];
  assert.deepEqual(await paragraphs(join(BOF2, codepage(1251), rec(0x0004, [...cellHead2, 3, ...cyrillic]))), ["При"]);
  assert.deepEqual(await paragraphs(join(BOF3, codepage(1251), rec(0x0204, [...cellHead3, ...u16(3), ...cyrillic]))), ["При"]);
  assert.deepEqual(await paragraphs(join(BOF4, codepage(1251), rec(0x0204, [...cellHead3, ...u16(3), ...cyrillic]))), ["При"]);
});

test("a record id from another version's table is not read", async () => {
  // BIFF4 numbers its formula 0x0406 and BIFF3 0x0206; BIFF2 has no 0x0203 NUMBER.
  const number3 = (id: number): number[] => rec(id, [...cellHead3, ...f64(5)]);
  assert.deepEqual(await paragraphs(join(BOF4, number3(0x0206))), []);
  assert.deepEqual(await paragraphs(join(BOF3, number3(0x0406))), []);
  assert.deepEqual(await paragraphs(join(BOF2, number3(0x0203))), []);
  assert.deepEqual(await paragraphs(join(BOF3, number3(0x0206))), ["5.0"]);
  assert.deepEqual(await paragraphs(join(BOF4, number3(0x0406))), ["5.0"]);
});

test("BIFF4 reads NUMBER, LABEL and RK records at the offsets BIFF3 does", async () => {
  const result = await paragraphs(
    join(
      BOF4,
      rec(0x0203, [...cellHead3, ...f64(2.5)]),
      rec(0x0204, [...cellHead3, ...u16(2), ...ascii("ok")]),
      rec(0x027e, [...cellHead3, ...u32((7 << 2) | 0x02)]),
    ),
  );
  assert.deepEqual(result, ["2.5", "ok", "7.0"]);
});

test("BIFF4 reads its CODEPAGE and its STRING record", async () => {
  const result = await paragraphs(
    join(
      BOF4,
      codepage(1251),
      rec(0x0406, [...cellHead3, ...STRING_RESULT, 0, 0, 0, 0]),
      rec(0x0207, [...u16(1), 0xcf]),
    ),
  );
  assert.deepEqual(result, ["П"]);
});

// Each record must hold every byte its fields reach, and not one more is asked of it: exactly that many parse, one fewer is
// refused (and no value is read from the bytes of the next record).
const NEEDED: { name: string; bof: number[]; id: number; head: Bytes; tail: Bytes; expected: string }[] = [
  { name: "BIFF2 INTEGER", bof: BOF2, id: 0x0002, head: cellHead2, tail: u16(9), expected: "9.0" },
  { name: "BIFF2 NUMBER", bof: BOF2, id: 0x0003, head: cellHead2, tail: f64(1.5), expected: "1.5" },
  { name: "BIFF3 NUMBER", bof: BOF3, id: 0x0203, head: cellHead3, tail: f64(1.5), expected: "1.5" },
  { name: "BIFF4 NUMBER", bof: BOF4, id: 0x0203, head: cellHead3, tail: f64(1.5), expected: "1.5" },
  { name: "BIFF3 RK", bof: BOF3, id: 0x027e, head: cellHead3, tail: u32((3 << 2) | 0x02), expected: "3.0" },
  { name: "BIFF4 RK", bof: BOF4, id: 0x027e, head: cellHead3, tail: u32((3 << 2) | 0x02), expected: "3.0" },
  { name: "BIFF2 FORMULA", bof: BOF2, id: 0x0006, head: cellHead2, tail: f64(4.5), expected: "4.5" },
  { name: "BIFF3 FORMULA", bof: BOF3, id: 0x0206, head: cellHead3, tail: f64(4.5), expected: "4.5" },
  { name: "BIFF4 FORMULA", bof: BOF4, id: 0x0406, head: cellHead3, tail: f64(4.5), expected: "4.5" },
  { name: "BIFF2 LABEL", bof: BOF2, id: 0x0004, head: cellHead2, tail: [3, ...ascii("abc")], expected: "abc" },
  { name: "BIFF3 LABEL", bof: BOF3, id: 0x0204, head: cellHead3, tail: [...u16(3), ...ascii("abc")], expected: "abc" },
  { name: "BIFF4 LABEL", bof: BOF4, id: 0x0204, head: cellHead3, tail: [...u16(3), ...ascii("abc")], expected: "abc" },
];

for (const { name, bof: opening, id, head, tail, expected } of NEEDED) {
  test(`${name}: a record with exactly the bytes its fields reach is read, one byte fewer is malformed`, async () => {
    const data = [...head, ...tail];
    assert.deepEqual(await paragraphs(join(opening, rec(id, data))), [expected]);
    // the missing byte would be read from the next record's header if the length were not checked
    await assert.rejects(paragraphs(join(opening, rec(id, data.slice(0, -1)), rec(0x000a, [0xff]))), MalformedDocumentError);
  });
}

test("a CODEPAGE record needs both bytes of its page", async () => {
  await paragraphs(join(BOF3, rec(0x0042, [0xe3, 0x04])));
  await assert.rejects(paragraphs(join(BOF3, rec(0x0042, [0xe3]))), MalformedDocumentError);
  await assert.rejects(paragraphs(join(BOF3, rec(0x0042, []))), MalformedDocumentError);
});

test("a STRING record needs the bytes its length names, in each version", async () => {
  const formula2 = rec(0x0006, [...cellHead2, ...STRING_RESULT]);
  const formula3 = rec(0x0206, [...cellHead3, ...STRING_RESULT]);
  assert.deepEqual(await paragraphs(join(BOF2, formula2, rec(0x0007, [3, ...ascii("abc")]))), ["abc"]);
  assert.deepEqual(await paragraphs(join(BOF3, formula3, rec(0x0207, [...u16(3), ...ascii("abc")]))), ["abc"]);
  await assert.rejects(paragraphs(join(BOF2, formula2, rec(0x0007, [3, ...ascii("ab")]))), MalformedDocumentError);
  await assert.rejects(paragraphs(join(BOF3, formula3, rec(0x0207, [...u16(3), ...ascii("ab")]))), MalformedDocumentError);
});

test("a BIFF3 label's length is two bytes, a BIFF2 label's one: the high byte of a BIFF3 length counts", async () => {
  // 0x0102 = 258 characters: if only the low byte were read the label would be two characters long
  const text = "x".repeat(258);
  assert.deepEqual(await paragraphs(join(BOF3, rec(0x0204, [...cellHead3, ...u16(258), ...ascii(text)]))), [text]);
  // BIFF2: the byte after the length is the first character, even if it is zero
  assert.deepEqual(await paragraphs(join(BOF2, rec(0x0004, [...cellHead2, 2, ...ascii("ab")]))), ["ab"]);
});

test("a STRING record is text only for the formula before it: it is used once", async () => {
  const formula = rec(0x0206, [...cellHead3, ...STRING_RESULT]);
  const string = (text: string): number[] => rec(0x0207, [...u16(text.length), ...ascii(text)]);
  assert.deepEqual(await paragraphs(join(BOF3, formula, string("once"), string("stray"))), ["once"]);
});

test("a later formula with a number result ends the wait for a STRING record", async () => {
  const stringFormula = rec(0x0206, [...cellHead3, ...STRING_RESULT]);
  const numberFormula = rec(0x0206, [...cellHead3, ...f64(2), 0, 0, 0, 0]);
  const string = rec(0x0207, [...u16(5), ...ascii("stray")]);
  assert.deepEqual(await paragraphs(join(BOF3, stringFormula, numberFormula, string)), ["2.0"]);
});

test("a boolean, error or empty formula result is not followed by text, whatever STRING record comes", async () => {
  const string = rec(0x0207, [...u16(5), ...ascii("stray")]);
  for (const kind of [1, 2, 3]) {
    const formula = rec(0x0206, [...cellHead3, kind, 0, 0, 0, 0, 0, 0xff, 0xff]);
    assert.deepEqual(await paragraphs(join(BOF3, formula, string)), [], `result kind ${kind}`);
  }
});

test("a formula result is the 0xFFFF marker in its last two bytes together, not either one", async () => {
  // bytes 6 and 7 of these are an ordinary double's: 0x3FFF000000000000 -style patterns that only look like the marker
  const high = [0, 0, 0, 0, 0, 0, 0xff, 0x3f]; // 1.9375
  const low = [0, 0, 0, 0, 0, 0, 0x3f, 0xff]; // a large negative number
  const expected = (bytes: number[]): string =>
    javaDoubleString(new DataView(Uint8Array.from(bytes).buffer).getFloat64(0, true));
  const formula = (result: number[]): number[] => rec(0x0206, [...cellHead3, ...result, 0, 0, 0, 0]);
  assert.deepEqual(await paragraphs(join(BOF3, formula(high), formula(low))), [expected(high), expected(low)]);
  assert.equal(expected(high), "1.9375");
});

test("an integer cell holds sixteen bits, unsigned", async () => {
  assert.deepEqual(await paragraphs(join(BOF2, rec(0x0002, [...cellHead2, 0xff, 0xff]))), ["65535.0"]);
});

test("javaDoubleString: signs, zeros, infinities and the digits Java keeps", () => {
  assert.equal(javaDoubleString(-0), "-0.0");
  assert.equal(javaDoubleString(0), "0.0");
  assert.equal(javaDoubleString(Number.POSITIVE_INFINITY), "Infinity");
  assert.equal(javaDoubleString(Number.NEGATIVE_INFINITY), "-Infinity");
  assert.equal(javaDoubleString(100), "100.0");
  assert.equal(javaDoubleString(1234567), "1234567.0");
  assert.equal(javaDoubleString(12345678), "1.2345678E7");
  assert.equal(javaDoubleString(1e21), "1.0E21");
  assert.equal(javaDoubleString(-1.5e10), "-1.5E10");
  assert.equal(javaDoubleString(0.00123), "0.00123");
  assert.equal(javaDoubleString(0.5), "0.5");
  assert.equal(javaDoubleString(123.456), "123.456");
  assert.equal(javaDoubleString(1e-5), "1.0E-5");
  // two digits at least, and the closest pair when one digit would do: Double.MIN_VALUE is 4.9E-324, not 5.0E-324
  assert.equal(javaDoubleString(Number.MIN_VALUE), "4.9E-324");
  assert.equal(javaDoubleString(1.7976931348623157e308), "1.7976931348623157E308");
  assert.equal(javaDoubleString(2e-323), "2.0E-323");
});
