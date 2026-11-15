import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { BodyContentHandler, LimitExceededError, MalformedDocumentError, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { PdfParser } from "../src/index.ts";
import { classicPdf, onePageObjects, streamObject } from "./fixtures.ts";

/** What a PDF whose pages cannot be read says about it (tikajs-6ik0, F17 F18 F19): nothing is dropped without a trace. */

async function parse(text: string): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(new Uint8Array(Buffer.from(text, "latin1")));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await new PdfParser().parse(stream, handler, metadata, new ParseContext());
    return { text: handler.toString(), metadata };
  } finally {
    await stream.close();
  }
}

const page = (contents: number): string => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 5 0 R >> >> >>`;
const font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
const shown = (text: string): string => streamObject(`BT /F1 24 Tf 72 700 Td (${text}) Tj ET`);

test("a page that fails to load is a warning with its number, and a 0 in the characters per page", async () => {
  // A sound xref; the second kid is not a page dictionary.
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 6 0 R 7 0 R] /Count 3 >>", page(4), shown("Page one"), font, "42", page(8), shown("Page three")];
  const { text, metadata } = await parse(classicPdf(objects));
  assert.match(text, /Page one/);
  assert.ok(metadata.getAll("tk:exception:warn").some((warning) => /page 2 could not be read/.test(warning)), JSON.stringify(metadata.getAll("tk:exception:warn")));
  assert.equal(metadata.getAll("pdf:chars-per-page").length, Number(metadata.get("xmpTPg:NPages")), "one value per page, the failed one a 0");
  assert.equal(metadata.getAll("pdf:chars-per-page")[1], "0");
});

test("a PDF whose pages all fail to load is a malformed document, not an empty success", async () => {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [6 0 R] /Count 1 >>", page(4), shown("Only page"), font, "<< /Type /Pages /Kids 5 /Count 1 >>"];
  await assert.rejects(parse(classicPdf(objects)), MalformedDocumentError);
});

test("a content stream that cannot be decoded, or is not in the file, is a warning even when the file is not damaged", async () => {
  const good = deflateSync(Buffer.from("BT /F1 24 Tf 72 700 Td (Card number 4111) Tj ET", "latin1")).toString("latin1");
  const zeroed = good.slice(0, 2) + "\x00".repeat(good.length - 2);
  const unreadable = onePageObjects("x");
  unreadable[3] = `<< /Length ${zeroed.length} /Filter /FlateDecode >>\nstream\n${zeroed}\nendstream`;
  const first = await parse(classicPdf(unreadable));
  assert.ok(first.metadata.getAll("tk:exception:warn").some((warning) => /page 1 content could not be decoded/.test(warning)), JSON.stringify(first.metadata.getAll("tk:exception:warn")));
  const missing = onePageObjects("x");
  missing[2] = missing[2]!.replace("/Contents 4 0 R", "/Contents 9 0 R");
  const second = await parse(classicPdf(missing));
  assert.ok(second.metadata.getAll("tk:exception:warn").some((warning) => /page 1 content is missing/.test(warning)), JSON.stringify(second.metadata.getAll("tk:exception:warn")));
});

test("a sound file with a blank page says nothing", async () => {
  const objects = onePageObjects("x");
  objects[3] = streamObject("q Q");
  const { metadata } = await parse(classicPdf(objects));
  assert.deepEqual(metadata.getAll("tk:exception:warn"), []);
});

test("a PDF with more pages than the parser reads is refused, not cut at the limit", async () => {
  const count = 10_001;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", font];
  const kids: string[] = [];
  for (let i = 0; i < count; i++) {
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>");
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${count} >>`;
  await assert.rejects(parse(classicPdf(objects)), (error: unknown) => error instanceof LimitExceededError && /10001 pages/.test(error.message) && /10000/.test(error.message));
});
