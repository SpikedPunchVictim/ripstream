import assert from "node:assert/strict";
import { test } from "node:test";
import { CsvParser, createRipstream } from "../src/index.ts";

const encoder = new TextEncoder();
const ripstream = createRipstream();
/**
 * Tika's own tests lower the minimum confidence to 0.2 (`tika-config-csv.json`): at its default, 0.5, a table needs eleven
 * regular rows (or quoted cells) to be told from text.
 */
const tables = createRipstream({ csv: { minConfidence: 0.2 } });

/** `count` rows of the cells, joined by `delimiter`, one row per line. */
function table(count: number, cells: readonly string[], delimiter = ","): string {
  return Array.from({ length: count }, (_, row) => cells.map((cell) => `${cell}${row}`).join(delimiter)).join("\n") + "\n";
}

test("a regular table is read as a table, with the delimiter named in Content-Type and csv:* metadata", async () => {
  const result = await ripstream.parse(encoder.encode(table(12, ["a", "b", "c"])), { filename: "rows.csv" });
  // Tika's TextAndCSVParser: `text/csv; charset=<detected>; delimiter=<name>`, and Mojibuster detects ASCII as windows-1252.
  assert.equal(result.metadata.get("Content-Type"), "text/csv; charset=windows-1252; delimiter=comma");
  assert.equal(result.metadata.get("Content-Encoding"), "windows-1252");
  assert.equal(result.metadata.get("csv:delimiter"), "comma");
  assert.equal(result.metadata.get("csv:num-columns"), "3");
  assert.equal(result.metadata.get("csv:num-rows"), "12");
  assert.equal(result.text.match(/\t/g)?.length, 36);
});

test("a short table is text at the default confidence: Content-Type is text/plain and there are no csv:* keys", async () => {
  const body = "name,age\nAda,36\nGrace,85\n";
  const result = await ripstream.parse(encoder.encode(body), { filename: "people.csv" });
  assert.equal(result.metadata.get("Content-Type"), "text/plain; charset=windows-1252");
  assert.equal(result.metadata.get("Content-Encoding"), "windows-1252");
  assert.equal(result.metadata.get("csv:delimiter"), null);
  assert.equal(result.metadata.get("csv:num-columns"), null);
  assert.equal(result.metadata.get("csv:num-rows"), null);
  assert.equal(result.text, `${body}\n`);
});

test("plain text that is a regular table is a table too, as in Tika", async () => {
  const result = await ripstream.parse(encoder.encode(table(12, ["x", "y"], ";")), { filename: "notes.txt" });
  assert.equal(result.metadata.get("Content-Type"), "text/csv; charset=windows-1252; delimiter=semicolon");
  assert.equal(result.metadata.get("csv:delimiter"), "semicolon");
  const unnamed = await ripstream.parse(encoder.encode(table(12, ["x", "y"], "|")));
  assert.equal(unnamed.metadata.get("Content-Type"), "text/csv; charset=windows-1252; delimiter=pipe");
});

test("tab-separated columns are text/tsv, whatever the file was named", async () => {
  const result = await ripstream.parse(encoder.encode(table(12, ["a", "b"], "\t")), { filename: "rows.csv" });
  assert.equal(result.metadata.get("Content-Type"), "text/tsv; charset=windows-1252; delimiter=tab");
  assert.equal(result.metadata.get("csv:delimiter"), "tab");
  assert.equal(result.metadata.get("csv:num-columns"), "2");
});

test("a .tsv file is text: Tika's text parser does not sniff text/tab-separated-values", async () => {
  const body = table(12, ["a", "b"], "\t");
  const result = await ripstream.parse(encoder.encode(body), { filename: "rows.tsv" });
  assert.equal(result.metadata.get("Content-Type"), "text/tab-separated-values; charset=windows-1252");
  assert.equal(result.metadata.get("Content-Encoding"), "windows-1252");
  assert.equal(result.metadata.get("csv:delimiter"), null);
  assert.equal(result.metadata.get("csv:num-rows"), null);
  assert.equal(result.text, `${body}\n`);
});

test("the charset is the one detected for the table", async () => {
  const text = table(12, ["a", "b"]);
  const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array(Array.from(text, (c) => c.charCodeAt(0))).buffer)]);
  const result = await ripstream.parse(utf16, { filename: "rows.csv" });
  assert.equal(result.metadata.get("Content-Type"), "text/csv; charset=UTF-16LE; delimiter=comma");
  assert.equal(result.metadata.get("csv:num-rows"), "12");
  const accented = await ripstream.parse(encoder.encode(table(12, ["é", "b"])), { filename: "rows.csv" });
  assert.equal(accented.metadata.get("Content-Type"), "text/csv; charset=UTF-8; delimiter=comma");
});

test("the sniffed window is 20,000 characters of the decoded text, however many bytes that is", async () => {
  // A first row of 10,500 characters, then regular rows: a table only if the window reaches past the first row, which at
  // two bytes a character is 21,000 bytes in.
  const text = `a,${"x".repeat(10_500)}\n${table(2000, ["a", "b", "c"])}`;
  const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array(Array.from(text, (c) => c.charCodeAt(0))).buffer)]);
  const result = await ripstream.parse(utf16, { filename: "wide.csv" });
  assert.equal(result.metadata.get("Content-Type"), "text/csv; charset=UTF-16LE; delimiter=comma");
});

test("a table longer than the sniffed window is read whole", async () => {
  const result = await ripstream.parse(encoder.encode(table(5000, ["a", "b", "c"])), { filename: "big.csv" });
  assert.equal(result.metadata.get("csv:num-rows"), "5000");
  assert.equal(result.metadata.get("csv:num-columns"), "3");
});

test("the minimum confidence and mark limit are options, as Tika's TextAndCSVConfig has them", async () => {
  const body = encoder.encode("a,b\n1,2\n3,4\n");
  assert.equal((await tables.parse(body, { filename: "p.csv" })).metadata.get("csv:num-rows"), "3");
  const strict = createRipstream({ csv: { minConfidence: 0.99 } });
  assert.equal((await strict.parse(encoder.encode(table(40, ["a", "b"])), { filename: "p.csv" })).metadata.get("csv:num-rows"), null);
  const short = createRipstream({ csv: { markLimit: 20 } });
  assert.equal((await short.parse(encoder.encode(table(40, ["a", "b"])), { filename: "p.csv" })).metadata.get("csv:num-rows"), null);
  assert.throws(() => new CsvParser({ minConfidence: Number.NaN }), RangeError);
  assert.throws(() => new CsvParser({ markLimit: 0 }), RangeError);
});

test("the delimiter option reads every document as a table and sniffs nothing", async () => {
  const forced = createRipstream({ csv: { delimiter: ";" } });
  const result = await forced.parse(encoder.encode("one;two\nthree\n"), { filename: "short.csv" });
  assert.equal(result.metadata.get("Content-Type"), "text/csv; charset=windows-1252; delimiter=semicolon");
  assert.equal(result.metadata.get("csv:delimiter"), "semicolon");
  assert.equal(result.metadata.get("csv:num-columns"), "2");
  assert.equal(result.metadata.get("csv:num-rows"), "2");
});

test("the delimiter option wins over what the sniffer would have found, and a single row still counts its columns", async () => {
  const forced = createRipstream({ csv: { delimiter: ";" } });
  const commas = await forced.parse(encoder.encode(table(12, ["a", "b", "c"])), { filename: "commas.csv" });
  assert.equal(commas.metadata.get("csv:delimiter"), "semicolon");
  assert.equal(commas.metadata.get("csv:num-columns"), "1");
  const one = await forced.parse(encoder.encode("x;y;z\n"), { filename: "one.csv" });
  assert.equal(one.metadata.get("csv:num-columns"), "3");
  assert.equal(one.metadata.get("csv:num-rows"), "1");
});

test("a delimiter Tika has no name for is written as its code, and there is no csv:delimiter", async () => {
  const forced = createRipstream({ csv: { delimiter: ":" } });
  const result = await forced.parse(encoder.encode("a:b\n"), { filename: "colon.csv" });
  assert.equal(result.metadata.get("Content-Type"), "text/csv; charset=windows-1252; delimiter=58");
  assert.equal(result.metadata.get("csv:delimiter"), null);
});

test("the delimiter option is one character other than a quote or a line break", async () => {
  for (const bad of ["", ",,", '"', "\n", "\r"]) {
    assert.throws(() => new CsvParser({ delimiter: bad }), RangeError, JSON.stringify(bad));
  }
});

test("a type other than text/plain, text/csv and text/tsv is read as text and keeps its type, even with the delimiter option", async () => {
  const forced = createRipstream({ csv: { delimiter: "," } });
  const result = await forced.parse(encoder.encode('{"a":1,"b":2}\n'), { filename: "data.json" });
  assert.equal(result.metadata.get("Content-Type"), "application/json; charset=windows-1252");
  assert.equal(result.metadata.get("csv:delimiter"), null);
});

test("parses comma CSV", async () => {
  const result = await tables.parse(encoder.encode("name,age\nAda,36\nGrace,85\n"), {
    filename: "people.csv",
  });
  assert.equal(result.metadata.get("Content-Type"), "text/csv; charset=windows-1252; delimiter=comma");
  assert.equal(result.metadata.get("Content-Encoding"), "windows-1252");
  assert.match(result.text, /Ada/);
  assert.match(result.text, /Grace/);
  assert.equal(result.text.match(/\t/g)?.length, 6);
});

test("handles quoted delimiters and doubled quotes", async () => {
  const result = await tables.parse(
    encoder.encode('a,"b,c","say ""hi"""\nx,y,z\np,q,r\n'),
    { filename: "quoted.csv" },
  );
  assert.match(result.text, /b,c/);
  assert.match(result.text, /say "hi"/);
});

test("detects semicolon and tab delimiters", async () => {
  const semicolon = await tables.parse(encoder.encode("a;b\n1;2\n3;4\n"), {
    filename: "semi.csv",
  });
  assert.match(semicolon.text, /a/);
  assert.match(semicolon.text, /b/);
  assert.equal(semicolon.metadata.get("csv:delimiter"), "semicolon");

  const tab = await tables.parse(encoder.encode("a\tb\n1\t2\n3\t4\n"), {
    filename: "tab.csv",
  });
  assert.match(tab.text, /a/);
  assert.equal(tab.metadata.get("csv:delimiter"), "tab");
});

test("preserves newlines inside quoted fields", async () => {
  const result = await tables.parse(encoder.encode('a,"line1\nline2"\nb,"line3\nline4"\nc,"x\ny"\n'), {
    filename: "multi.csv",
  });
  assert.match(result.text, /line1\nline2/);
});
