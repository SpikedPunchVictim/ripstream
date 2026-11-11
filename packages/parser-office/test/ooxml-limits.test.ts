import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { OoxmlParser } from "../src/index.ts";

// tikajs-kpkn: the sheet caps must fire while the sheet is being read, not after a whole-document tree exists.
// Each sheet below ends in text that is not XML. A reader that builds the whole tree first reaches that text and
// fails with MalformedDocumentError; a reader that counts as it goes throws LimitExceededError at the cap and never
// reaches it. That is the deterministic proof that rejection comes before the rest of the sheet is read.
const MALFORMED_TAIL = "<<< not xml";
const SHEET_HEAD = '<worksheet xmlns="x"><sheetData>';

/** Raised by the handler when the parser starts the table, which it does only after the whole sheet is read. */
class SheetWasRead extends Error {}

/**
 * Writing a million cells through the handler is slow, so the handler stops the parse as soon as the sheet has been
 * read in full. parseSheet resolves when that happens and rejects with whatever the reader threw instead.
 */
class StopAtTable implements ContentHandler {
  startDocument(): void {}
  endDocument(): void {}
  startElement(_uri: string, localName: string): void {
    if (localName === "table") throw new SheetWasRead();
  }
}

async function parseSheet(sheetXml: string): Promise<void> {
  const archive = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(
      '<workbook xmlns="x"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>',
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
  });
  const stream = await RipstreamInputStream.from(archive);
  try {
    // The repetitive sheets below compress far past the default ratio limit, which would reject them first.
    const ctx = new ParseContext({ limits: { maxDecompressionRatio: 1_000_000 } });
    await new OoxmlParser().parse(stream, new StopAtTable(), new Metadata(), ctx);
  } catch (error) {
    if (!(error instanceof SheetWasRead)) throw error;
  } finally {
    await stream.close();
  }
}

test("xlsx rejects a sheet over the cell cap before it reads the rest of the sheet", async () => {
  // 1001 rows of 1000 cells is 1,001,000 cells, just over the 1,000,000 cap.
  const row = `<row>${"<c><v>1</v></c>".repeat(1000)}</row>`;
  const xml = SHEET_HEAD + row.repeat(1001) + MALFORMED_TAIL;
  await assert.rejects(parseSheet(xml), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError, `expected LimitExceededError, got ${String(error)}`);
    assert.equal(error.message, "Sheet exceeds 1000000 cells");
    return true;
  });
});

test("xlsx accepts a sheet of exactly the cell cap and rejects one cell more", async () => {
  const row = `<row>${"<c><v>1</v></c>".repeat(1000)}</row>`;
  await parseSheet(SHEET_HEAD + row.repeat(1000) + "</sheetData></worksheet>");
  const oneMore = row.repeat(1000) + "<row><c><v>1</v></c></row>";
  await assert.rejects(parseSheet(SHEET_HEAD + oneMore + "</sheetData></worksheet>"), LimitExceededError);
});

test("xlsx rejects a sheet of empty rows over the row cap before it reads the rest of the sheet", async () => {
  // Excel allows 1,048,576 rows. Empty rows have no cells, so only a row cap bounds them.
  const xml = SHEET_HEAD + "<row/>".repeat(1_048_577) + MALFORMED_TAIL;
  await assert.rejects(parseSheet(xml), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError, `expected LimitExceededError, got ${String(error)}`);
    assert.equal(error.message, "Sheet exceeds 1048576 rows");
    return true;
  });
});

test("xlsx accepts a sheet of exactly the row cap", async () => {
  const xml = SHEET_HEAD + "<row><c><v>1</v></c></row>" + "<row/>".repeat(1_048_575) + "</sheetData></worksheet>";
  await parseSheet(xml);
});

test("xlsx accepts a sheet nested to the depth limit and rejects one level more", async () => {
  // worksheet and sheetData are levels 1 and 2, so 254 more reach the limit of 256.
  const nested = (levels: number): string =>
    SHEET_HEAD + "<g>".repeat(levels) + "</g>".repeat(levels) + "</sheetData></worksheet>";
  await parseSheet(nested(254));
  await assert.rejects(parseSheet(nested(255)), MalformedDocumentError);
});
