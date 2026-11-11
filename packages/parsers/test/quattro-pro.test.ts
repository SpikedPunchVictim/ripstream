import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BodyContentHandler,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  ParserDeclinedError,
  RipstreamInputStream,
  UnsupportedFormatError,
} from "@spikedpunch/ripstream-core";
import { QuattroProParser } from "../src/quattro-pro.ts";
import { buildOle } from "./ole-builder.ts";

/*
 * QuattroProParser (tikajs-68os.21). What Tika asserts on testQUATTRO.qpw is in fixtures/misc-data/quattro-qpw.json; this
 * file holds what a fixture cannot say: each record type, the refusals and the hostile lengths. The record layouts are
 * read from Tika 4.2.0's QPWTextExtractor, not run against a Tika.
 */

const QP9 = "application/x-quattro-pro; version=9";
const MAIN = "NativeContent_MAIN";

const short = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const long = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const latin1 = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
/** A QSTR: a count, a type byte, then count + 1 characters, one byte each. */
const qstr = (text: string): number[] => [...short(text.length - 1), 0, ...latin1(text)];
const record = (type: number, body: number[]): number[] => [...short(type), ...short(body.length), ...body];

const bof = (extra = 2): number[] =>
  record(0x0001, [...latin1("QPW9"), ...short(7), ...short(8), ...short(0xffff), ...short(3), ...short(4), ...new Array(extra).fill(0)]);

function notebook(records: readonly number[][]): Uint8Array {
  return buildOle([{ name: MAIN, data: Uint8Array.from(records.flat()) }]);
}

async function parseAs(bytes: Uint8Array, type: string): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  metadata.set("Content-Type", type);
  try {
    await new QuattroProParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

test("the BOF record gives the id, versions and page count, and its extra bytes are skipped", async () => {
  const { metadata } = await parseAs(notebook([bof(6), record(0x0407, [...long(1), ...long(0), ...long(0), ...qstr("after")])]), QP9);
  assert.equal(metadata.get("quattropro:id"), "QPW9");
  assert.equal(metadata.get("quattropro:version"), "7");
  assert.equal(metadata.get("quattropro:build"), "8");
  assert.equal(metadata.get("quattropro:lowest-version"), "3");
  assert.equal(metadata.get("meta:page-count"), "4");
});

test("the USER record gives the creator and the last author", async () => {
  const { metadata } = await parseAs(notebook([record(0x0005, [...qstr("Ada"), ...qstr("Grace")])]), QP9);
  assert.equal(metadata.get("dc:creator"), "Ada");
  assert.equal(metadata.get("meta:last-author"), "Grace");
});

test("the string table, sheet names, headers, footers, links and cells give their text", async () => {
  const text = (await parseAs(
    notebook([
      record(0x0407, [...long(2), ...long(2), ...long(2), ...qstr("Alpha"), ...qstr("Beta")]),
      record(0x0403, [...short(1), ...short(1), ...short(2), ...qstr("other.qpw")]),
      record(0x0601, [...short(0), ...short(0), ...short(3), ...long(0), ...long(9), ...short(0), ...short(0), ...qstr("Sheet One")]),
      record(0x0605, [...short(0), ...qstr("Header text")]),
      record(0x0606, [...short(0), ...qstr("Footer text")]),
      record(0x0c02, [...short(1), ...long(2), ...qstr("formula result")]),
      record(0x0c72, [...short(1), ...long(2), ...short(0), ...qstr("a label")]),
      record(0x0c80, [...short(1), ...long(2), ...long(0), ...qstr("Ada"), ...qstr("a comment")]),
    ]),
    QP9,
  )).text;
  // String table entries, links, sheet names, headers and footers end with a line separator; the cell kinds do not.
  assert.match(text, /Alpha\nBeta\nother\.qpw\nSheet One\nHeader text\nFooter text\nformula resulta labelAdaa comment/);
});

test("a record type that is not listed is skipped by its length", async () => {
  const text = (await parseAs(notebook([record(0x0002, [1, 2, 3, 4, 5]), record(0x0c72, [...short(0), ...long(0), ...short(0), ...qstr("kept")])]), QP9)).text;
  assert.match(text, /kept/);
});

test("Content-Type is reported once, as Tika's QuattroProTest.testQPW asserts", async () => {
  const { metadata } = await parseAs(notebook([bof()]), QP9);
  assert.deepEqual(metadata.getAll("Content-Type"), [QP9]);
});

test("without a Content-Type the parser sets version 9, as Tika does", async () => {
  const stream = await RipstreamInputStream.from(notebook([bof()]));
  const metadata = new Metadata();
  await new QuattroProParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  assert.equal(metadata.get("Content-Type"), QP9);
});

test("a compound file without NativeContent_MAIN is an unsupported Quattro Pro file, as in Tika", async () => {
  await assert.rejects(parseAs(buildOle([{ name: "Other", data: new Uint8Array(8) }]), QP9), UnsupportedFormatError);
});

test("bytes that are not a compound file are malformed", async () => {
  await assert.rejects(parseAs(new TextEncoder().encode("not a compound file at all"), QP9), MalformedDocumentError);
});

test("the other Quattro Pro versions are declined by the version 9 parser", async () => {
  for (const type of ["application/x-quattro-pro; version=7-8", "application/x-quattro-pro"]) {
    await assert.rejects(parseAs(notebook([bof()]), type), ParserDeclinedError, type);
  }
});

test("every prefix of a notebook is parsed or refused", async () => {
  const bytes = notebook([bof(), record(0x0005, [...qstr("Ada"), ...qstr("Grace")]), record(0x0407, [...long(1), ...long(1), ...long(1), ...qstr("cell")])]);
  for (let length = 0; length < bytes.length; length++) {
    try {
      await parseAs(bytes.subarray(0, length), QP9);
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError || error instanceof UnsupportedFormatError, `prefix ${length}: ${String(error)}`);
    }
  }
});

test("every prefix of testQUATTRO.qpw is parsed or refused", async () => {
  const real = readFileSync(new URL("./fixtures/misc-data/testQUATTRO.qpw", import.meta.url));
  for (let length = 0; length < real.length; length++) {
    try {
      await parseAs(real.subarray(0, length), QP9);
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError || error instanceof UnsupportedFormatError, `prefix ${length}: ${String(error)}`);
    }
  }
});

test("a string table declaring many entries stops at the end of the stream", async () => {
  // Enough that a reader that did not stop would be a while, few enough that one that does not stop ends the test quickly.
  const bytes = notebook([record(0x0407, [...long(200_000), ...long(0), ...long(0), ...qstr("only")])]);
  await assert.rejects(parseAs(bytes, QP9), MalformedDocumentError);
});

test("a string declaring 65535 characters in a short record is malformed", async () => {
  const bytes = notebook([record(0x0005, [...short(0xffff), 0, ...latin1("short")])]);
  await assert.rejects(parseAs(bytes, QP9), MalformedDocumentError);
});

test("a record whose length runs past the stream is malformed", async () => {
  const bytes = notebook([[...short(0x0002), ...short(0xffff), 1, 2, 3]]);
  await assert.rejects(parseAs(bytes, QP9), MalformedDocumentError);
});

test("a stream declaring 2 GB below a huge mini cutoff is refused without allocating it", async () => {
  const bytes = buildOle([{ name: MAIN, data: Uint8Array.from(bof()) }], { miniCutoff: 0xffffffff, declaredSize: { [MAIN]: 0x7fffffff } });
  await assert.rejects(parseAs(bytes, QP9), MalformedDocumentError);
});

test("a megabyte of empty records is read in one pass", async () => {
  const records = Array.from({ length: 250_000 }, () => record(0x0002, []));
  const { text } = await parseAs(notebook(records), QP9);
  assert.equal(text.trim(), "");
});
