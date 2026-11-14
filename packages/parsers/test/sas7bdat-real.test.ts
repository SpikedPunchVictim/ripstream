import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRipstream } from "../src/index.ts";
import { readSasFile, type SasValue } from "../src/sas7bdat-file.ts";

/*
 * The layouts and compressions of SAS7BDAT that SAS writes and the synthetic builder does not: 64-bit offsets, big-endian
 * integers and doubles, RLE and RDC rows, deleted rows, and parso's cell formatting. These are real files (see
 * fixtures/sas7bdat/real/README.md); the expected values were checked against Tika 4.2.0's SAS7BDATParser (tikajs-2xff).
 */

const file = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/sas7bdat/real/${name}`, import.meta.url)));

const rowsOf = (name: string): SasValue[][] => [...readSasFile(file(name)).rows()];

const ripstream = createRipstream();
const textOf = async (name: string): Promise<string> =>
  (await ripstream.parse(file(name), { filename: name, limits: { maxOutputChars: 10_000_000 } })).text;

test("64-bit little-endian: the DATE cells are parso's dates, in Java's Julian calendar before the 1582 cutover", async () => {
  const sas = readSasFile(file("sasdate-64le.sas7bdat"));
  assert.equal(sas.properties.bits, 64);
  assert.equal(sas.properties.endian, "Little");
  assert.equal(sas.properties.rowCount, 19);
  assert.equal(sas.properties.encoding, "ISO-8859-1");
  const text = await textOf("sasdate-64le.sas7bdat");
  assert.match(text, /\t22Dec1581\t/);
  assert.match(text, /\t31Dec1959\t/);
  assert.match(text, /\t01Jan1960\t/);
});

test("64-bit big-endian: the column sizes, names, formats and doubles are read the other way round", () => {
  const sas = readSasFile(file("sas-64be-class.sas7bdat"));
  assert.equal(sas.properties.bits, 64);
  assert.equal(sas.properties.endian, "Big");
  assert.equal(sas.properties.encoding, "ISO-8859-15");
  assert.deepEqual(
    sas.columns.map((column) => [column.name, column.type, column.width]),
    [
      ["Name", "character", 8],
      ["Sex", "character", 1],
      ["Age", "numeric", 8],
      ["Height", "numeric", 8],
      ["Weight", "numeric", 8],
    ],
  );
  assert.deepEqual(rowsOf("sas-64be-class.sas7bdat")[0], ["Alfred", "M", 14, 69, 112.5]);
});

test("64-bit big-endian: a mixed page of 729 rows is read from its pointers to the end", async () => {
  const sas = readSasFile(file("sas-64be-mixed.sas7bdat"));
  assert.equal(sas.properties.rowCount, 729);
  const rows = [...sas.rows()];
  assert.equal(rows.length, 729);
  assert.deepEqual(rows[0]!.slice(0, 3), [1, 0.24381116043953746, 0.08947511347451952]);
  assert.deepEqual(rows[728]!.slice(0, 3), [729, 0.04926756864845174, 0.9685910772385965]);
  assert.match(await textOf("sas-64be-mixed.sas7bdat"), /^EXTEND_YES\n/);
});

test("RLE: the CHAR commands, including 0x40, unpack a real compressed file", () => {
  const sas = readSasFile(file("sas-rle-longchar.sas7bdat"));
  assert.equal(sas.properties.bits, 32);
  assert.equal(sas.properties.columnCount, 47);
  const rows = [...sas.rows()];
  assert.equal(rows.length, 50);
  assert.equal(rows[0]![0], "A".repeat(257));
  assert.deepEqual(rows[0]!.slice(1, 4), [-1001, "A", "AA"]);
});

test("RDC: a real Ross-compressed 64-bit file reads its rows and stops at the deleted one", () => {
  const sas = readSasFile(file("sas-rdc-deleted.sas7bdat"));
  assert.equal(sas.properties.bits, 64);
  assert.equal(sas.properties.rowCount, 5);
  const rows = [...sas.rows()];
  assert.deepEqual(
    rows.map((row) => [row[0], row[1]]),
    [
      [1, "CATEGORY_1"],
      [2, "CATEGORY_2"],
      [4, "CATEGORY_4"],
      [5, "CATEGORY_5"],
    ],
  );
});

test("deleted rows: the first deleted row ends the rows, as it does in Tika's reader", () => {
  const rows = rowsOf("sas-deleted.sas7bdat");
  assert.equal(rows.length, 14);
  assert.equal(rows[0]![0], 0);
  assert.equal(rows[13]![0], 40);
  assert.deepEqual(rowsOf("sas-deleted-all.sas7bdat"), []);
});
