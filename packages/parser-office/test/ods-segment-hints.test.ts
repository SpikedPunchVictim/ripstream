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
import { strToU8, zipSync } from "fflate";
import { OpenDocumentParser } from "../src/index.ts";

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';

async function parse(rows: string, withHints: boolean): Promise<{ calls: string[]; text: string }> {
  const content = `<office:document-content ${NS}><office:body><office:spreadsheet><table:table table:name="T">${rows}</table:table></office:spreadsheet></office:body></office:document-content>`;
  const calls: string[] = [];
  const hints = {
    row: (number: number) => calls.push(`row ${number}`),
    col: (number: number) => calls.push(`col ${number}`),
  } as unknown as SegmentHints;
  const ctx = new ParseContext();
  if (withHints) ctx.set(CONTEXT_KEYS.SEGMENT_HINTS, hints);
  const stream = await RipstreamInputStream.from(zipSync({ "content.xml": strToU8(content) }));
  const handler = new BodyContentHandler();
  try {
    await new OpenDocumentParser().parse(stream, handler, new Metadata(), ctx);
  } finally {
    await stream.close();
  }
  return { calls, text: handler.toString() };
}

const cell = (text: string, attributes = ""): string => `<table:table-cell ${attributes}><text:p>${text}</text:p></table:table-cell>`;
const ROWS =
  `<table:table-row>${cell("Name")}<table:table-cell table:number-columns-repeated="2"/>${cell("Tax")}</table:table-row>` +
  `<table:table-row table:number-rows-repeated="4"><table:table-cell/></table:table-row>` +
  `<table:table-row><table:covered-table-cell/>${cell("X")}</table:table-row>`;

test("an ods table's hints are its own row and column numbers: repeated rows and columns and covered cells count (tikajs-bwjq)", async () => {
  const { calls } = await parse(ROWS, true);
  assert.deepEqual(calls, ["row 1", "col 1", "col 2", "col 4", "row 2", "col 1", "row 6", "col 2"]);
});

test("the text is the same with the hints off", async () => {
  const on = await parse(ROWS, true);
  const off = await parse(ROWS, false);
  assert.equal(on.text, off.text);
  assert.deepEqual(off.calls, []);
});
