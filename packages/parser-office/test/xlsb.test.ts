import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  type SegmentHints,
} from "@spikedpunch/ripstream-core";
import { XlsbParser } from "../src/index.ts";
import { buildXlsb, type XlsbCell, type XlsbSheet } from "./xlsb-builder.ts";

const s = (col: number, value: string): XlsbCell => ({ col, type: "string", value });
const sheet = (rows: XlsbSheet["rows"], name = "S"): XlsbSheet => ({ name, rows });

async function parse(sheets: readonly XlsbSheet[], hints?: SegmentHints): Promise<string> {
  const ctx = new ParseContext();
  if (hints !== undefined) ctx.set(CONTEXT_KEYS.SEGMENT_HINTS, hints);
  const stream = await RipstreamInputStream.from(buildXlsb(sheets, ["SHARED"]));
  const handler = new BodyContentHandler();
  try {
    await new XlsbParser().parse(stream, handler, new Metadata(), ctx);
  } finally {
    await stream.close();
  }
  return handler.toString();
}

/*
 * The expected texts are Tika 4.2.0's (/rmeta/body of an .xlsb written with the same builder), recorded for tikajs-bwjq: a
 * cell is a tab and its text, columns left out are empty cells, a row header with no cells is an empty line.
 */
const CASES: readonly { readonly name: string; readonly sheets: XlsbSheet[]; readonly text: string }[] = [
  {
    name: "columns and rows left out, an empty string, a header-only row",
    sheets: [sheet([{ row: 0, cells: [s(1, "a")] }, { row: 2, cells: [s(0, "b"), s(2, "c")] }, { row: 3, cells: [] }, { row: 5, cells: [s(0, "")] }, { row: 6, cells: [s(0, "z")] }])],
    text: "S\n\t\ta\n\tb\t\tc\n\n\t\n\tz\n\n",
  },
  { name: "leading empty columns", sheets: [sheet([{ row: 4, cells: [s(3, "x")] }])], text: "S\n\t\t\t\tx\n\n" },
  {
    name: "a shared string and a boolean",
    sheets: [sheet([{ row: 0, cells: [{ col: 2, type: "shared", value: 0 }, { col: 4, type: "bool", value: true }] }])],
    text: "S\n\t\t\tSHARED\t\ttrue\n\n",
  },
  {
    name: "blank cells are not cells, the cells after them are padded",
    sheets: [sheet([{ row: 0, cells: [s(0, "a"), { col: 1, type: "blank" }, s(2, "c")] }, { row: 1, cells: [{ col: 0, type: "blank" }, s(1, "x")] }, { row: 2, cells: [{ col: 3, type: "blank" }] }])],
    text: "S\n\ta\t\tc\n\t\tx\n\n\n",
  },
  { name: "an error cell is ERROR", sheets: [sheet([{ row: 0, cells: [s(0, "a"), { col: 1, type: "error", value: 7 }, s(2, "c")] }])], text: "S\n\ta\tERROR\tc\n\n" },
  { name: "cells in record order", sheets: [sheet([{ row: 0, cells: [s(2, "c"), s(0, "a")] }])], text: "S\n\t\t\tc\ta\n\n" },
  {
    name: "a row header with the number of the row before it adds to that row",
    sheets: [sheet([{ row: 0, cells: [s(0, "a"), s(0, "b")] }, { row: 0, cells: [s(0, "again")] }])],
    text: "S\n\ta\tb\tagain\n\n",
  },
  { name: "rows in file order", sheets: [sheet([{ row: 3, cells: [s(0, "r4")] }, { row: 1, cells: [s(0, "r2")] }])], text: "S\n\tr4\n\tr2\n\n" },
];

/*
 * Only the cells and rows are compared: after a sheet that has rows ripstream writes one more line break than Tika (the table's end
 * as well as the sheet's), which is the framing of the page and is left as it was.
 */
const cells = (text: string): string => text.replace(/\n+$/, "");

for (const { name, sheets, text } of CASES) {
  test(`xlsb text, as Tika writes it: ${name} (tikajs-bwjq)`, async () => {
    assert.equal(cells(await parse(sheets)), cells(text));
  });
}

test("segment hints give each cell the sheet's own row and column, with the columns and rows left out counted", async () => {
  const calls: string[] = [];
  const hints = {
    row: (number: number) => calls.push(`row ${number}`),
    col: (number: number) => calls.push(`col ${number}`),
  } as unknown as SegmentHints;
  await parse([sheet([{ row: 0, cells: [s(0, "Name"), s(3, "Tax ID")] }, { row: 6, cells: [s(1, "PLANTED-B7"), s(3, "PLANTED-D7")] }])], hints);
  assert.deepEqual(calls, ["row 1", "col 1", "col 4", "row 7", "col 2", "col 4"]);
});
