import assert from "node:assert/strict";
import { test } from "node:test";
import { bestCsvDelimiter, sniffCsvDelimiters } from "../src/csv-sniffer.ts";

/*
 * Ported from Tika 4.2.0's CSVSnifferTest and its CSVSniffer/TextAndCSVConfig defaults (markLimit 20,000 characters,
 * minimum confidence 0.50, delimiters comma, tab, pipe and semicolon). Read from Tika source, not run against a Tika.
 */

const CSV_BASIC = "the,quick,brown\tfox\njumped \tover,the\tlazy,\tdog\nand then,ran,down\tthe\tstreet";
const CSV_BASIC2 = "the;quick;brown\tfox\njumped \tover;the\tlazy;\tdog\nand then;ran;down\tthe\tstreet";
const CSV_BASIC3 = "the|quick|brown\tfox\njumped \tover|the\tlazy|\tdog\nand then|ran|down\tthe\tstreet";
const TSV_BASIC = "the\tquick\tbrown,fox\njumped ,over\tthe,lazy\t,dog\nand then\tran\tdown,the,street";
const MID_CELL_QUOTE = 'the,quick,brown"fox\njumped over,the lazy,dog\nand then,ran,down the street';
const SPACES_BEFORE_QUOTE = 'the,quick,         "brown""fox"\njumped over,the lazy,dog\nand then,ran,down the street';
const SPACES_AFTER_QUOTE = 'the,"quick"     ,brown  fox\njumped over,the lazy,dog\nand then,ran,down the street';

const rows = (count: number, row: string, end = "\n"): string => `${Array.from({ length: count }, () => row).join("\n")}${end}`;

test("every delimiter gets a result, the most confident first", () => {
  for (const [text, delimiter] of [
    [CSV_BASIC, ","],
    [CSV_BASIC2, ";"],
    [CSV_BASIC3, "|"],
    [TSV_BASIC, "\t"],
  ] as const) {
    const results = sniffCsvDelimiters(text);
    assert.equal(results.length, 4);
    assert.equal(results[0]?.delimiter, delimiter);
  }
});

test("a quote in the middle of a cell rules that delimiter out, and still yields a result for each", () => {
  const results = sniffCsvDelimiters(MID_CELL_QUOTE);
  assert.equal(results.length, 4);
  assert.equal(results.find((result) => result.delimiter === ",")?.confidence, -1);
});

test("spaces around a quoted cell are allowed", () => {
  assert.equal(sniffCsvDelimiters(SPACES_BEFORE_QUOTE)[0]?.delimiter, ",");
  assert.equal(sniffCsvDelimiters(SPACES_AFTER_QUOTE)[0]?.delimiter, ",");
});

test("results tie in Tika's delimiter order: tab, semicolon, comma, pipe", () => {
  assert.deepEqual(
    sniffCsvDelimiters("nothing to see here").map((result) => result.delimiter),
    ["\t", ";", ",", "|"],
  );
});

test("eleven regular rows are a table; ten are not enough evidence", () => {
  assert.equal(bestCsvDelimiter(rows(11, "a,b,c")), ",");
  assert.equal(bestCsvDelimiter(rows(10, "a,b,c")), null);
});

test("three regular rows are text: Tika's own tests lower the minimum confidence to 0.2 to get a table", () => {
  assert.equal(bestCsvDelimiter("a,b\n1,2\n3,4\n"), null);
  assert.equal(bestCsvDelimiter("a,b\n1,2\n3,4\n", { minConfidence: 0.2 }), ",");
});

test("quoted cells outweigh a short table", () => {
  assert.equal(bestCsvDelimiter('"a","b"\n"c","d"\n"e","f"\n'), ",");
});

test("a last row with no newline counts as a row", () => {
  assert.equal(bestCsvDelimiter(rows(10, "a,b,c", "\na,b,c")), ",");
  assert.equal(bestCsvDelimiter(rows(10, "a,b,c", "\n")), null);
});

test("tab, pipe and semicolon tables are found", () => {
  assert.equal(bestCsvDelimiter(rows(12, "a\tb\tc")), "\t");
  assert.equal(bestCsvDelimiter(rows(12, "a|b|c")), "|");
  assert.equal(bestCsvDelimiter(rows(12, "a;b;c")), ";");
});

test("prose, one column and an empty window are text", () => {
  assert.equal(bestCsvDelimiter("The quick brown fox jumps over the lazy dog.\n".repeat(20)), null);
  assert.equal(bestCsvDelimiter(rows(30, "word")), null);
  assert.equal(bestCsvDelimiter(""), null);
});

test("a first row with no delimiter is not credible for a table", () => {
  assert.equal(bestCsvDelimiter(`heading\n${rows(30, "a,b,c")}`), null);
});

test("rows of differing widths weigh by the commonest width", () => {
  // 12 rows of 3 columns and 6 of 2: 12 of 18 agree, (1 - 18^-0.3) * 12/18 = 0.39, under 0.5.
  assert.equal(bestCsvDelimiter(`${rows(12, "a,b,c")}${rows(6, "a,b")}`), null);
  // 30 of 33 agree: (1 - 33^-0.3) * 30/33 = 0.59.
  assert.equal(bestCsvDelimiter(`${rows(30, "a,b,c")}${rows(3, "a,b")}`), ",");
});

test("only the first 20,000 characters are read: an irregular row after them does not count", () => {
  const regular = rows(4000, "a,b,c");
  assert.ok(regular.length > 20_000);
  assert.equal(bestCsvDelimiter(`${regular}this is prose with no columns`), ",");
});

test("the window ends where the mark limit does, without crediting a row cut short", () => {
  // Eleven rows of six characters. Cut at 30 characters, 29 are read: four whole rows and a fifth with no newline,
  // which is not counted, so there are too few rows.
  assert.equal(bestCsvDelimiter(rows(11, "a,b,c"), { markLimit: 30 }), null);
  assert.equal(bestCsvDelimiter(rows(11, "a,b,c"), { markLimit: 200 }), ",");
});

test("the mark limit reads one character fewer than it says: the limit wins over the end of the text", () => {
  // Eleven "a,b,c" rows, no newline at the end: 65 characters. Reading stops at `markLimit - 1` characters, and the limit is
  // checked before the end of the text, so the last row is cut off and not counted (ten rows: not enough) until the limit
  // is two past the length and the text ends first.
  const text = rows(11, "a,b,c", "");
  assert.equal(text.length, 65);
  assert.equal(bestCsvDelimiter(text, { markLimit: 65 }), null);
  assert.equal(bestCsvDelimiter(text, { markLimit: 66 }), null);
  assert.equal(bestCsvDelimiter(text, { markLimit: 67 }), ",");
});

test("rows with a single column count as rows but never as the commonest width", () => {
  assert.equal(bestCsvDelimiter(`a,b\n${rows(40, "word")}`), null);
});

test("a delimiter whose confidence equals the minimum makes a table", () => {
  const eleven = 1 - 1 / Math.pow(11, 0.3);
  assert.equal(bestCsvDelimiter(rows(11, "a,b,c"), { minConfidence: eleven }), ",");
});

test("fewer than three rows carry no confidence, however low the minimum", () => {
  assert.equal(bestCsvDelimiter("a,b\n1,2\n", { minConfidence: 0.1 }), null);
  assert.equal(bestCsvDelimiter("a,b\n1,2\n3,4\n", { minConfidence: 0.1 }), ",");
});

test("a mark limit and a minimum confidence that make no sense are refused", () => {
  assert.throws(() => bestCsvDelimiter("a", { markLimit: 0 }), RangeError);
  assert.throws(() => bestCsvDelimiter("a", { markLimit: 1.5 }), RangeError);
  assert.throws(() => bestCsvDelimiter("a", { minConfidence: Number.NaN }), RangeError);
});
