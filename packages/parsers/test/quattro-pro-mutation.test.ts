import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  UnsupportedFormatError,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { QuattroProParser } from "../src/quattro-pro.ts";
import { buildOle } from "./ole-builder.ts";

/*
 * Mutation tests for the Quattro Pro parser (tikajs-68os.21): what quattro-pro.test.ts leaves open about the reader of the
 * records and the document around it. The parser is constructed directly, so nothing here loads another parser's registration.
 */

const QP9 = "application/x-quattro-pro; version=9";

const short = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const long = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const latin1 = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const qstr = (text: string): number[] => [...short(text.length - 1), 0, ...latin1(text)];
const record = (type: number, body: number[]): number[] => [...short(type), ...short(body.length), ...body];
const label = (text: string): number[] => record(0x0c72, [...short(0), ...long(0), ...short(0), ...qstr(text)]);
const notebook = (records: readonly number[][]): Uint8Array => buildOle([{ name: "NativeContent_MAIN", data: Uint8Array.from(records.flat()) }]);

async function run(bytes: Uint8Array, handler: ReturnType<typeof createOutputHandler>, metadata: Metadata): Promise<void> {
  const stream = await RipstreamInputStream.from(bytes);
  try {
    await new QuattroProParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
}

/** The text and the xhtml of the notebook, and the metadata of the run that wrote the text. */
async function parseNotebook(bytes: Uint8Array, type?: string): Promise<{ text: string; xml: string; metadata: Metadata }> {
  const metadata = new Metadata();
  if (type !== undefined) metadata.set("Content-Type", type);
  const text = createOutputHandler("text");
  const xml = createOutputHandler("xml");
  await run(bytes, text, metadata);
  await run(bytes, xml, new Metadata());
  return { text: text.toString(), xml: xml.toString(), metadata };
}

test("the parser names itself and the type it reads", () => {
  const parser = new QuattroProParser();
  assert.equal(parser.name, "QuattroProParser");
  assert.deepEqual([...parser.getSupportedTypes()].map(String), ["application/x-quattro-pro; version=9"]);
});

test("the text is in a paragraph of the page", async () => {
  const { xml } = await parseNotebook(notebook([label("cell")]));
  assert.equal(xml.slice(xml.indexOf("<body>")), "<body><p>cell</p>\n</body></html>");
});

test("a Content-Type that is already there is left as it is", async () => {
  const given = "application/x-quattro-pro; version=9; build=2";
  const { metadata } = await parseNotebook(notebook([label("cell")]), given);
  assert.deepEqual(metadata.getAll("Content-Type"), [given]);
});

test("a compound file without the notebook stream says which stream it looked for", async () => {
  await assert.rejects(
    parseNotebook(buildOle([{ name: "Other", data: new Uint8Array(8) }]), QP9),
    (error: unknown) =>
      error instanceof UnsupportedFormatError &&
      error.message === 'Unsupported QuattroPro file format. Looking for OLE entry "NativeContent_MAIN"',
  );
});

test("a byte left over after the last record is a record cut short", async () => {
  await assert.rejects(
    parseNotebook(notebook([label("cell"), [0]]), QP9),
    (error: unknown) => error instanceof MalformedDocumentError && error.message === "Truncated Quattro Pro record",
  );
  // Two bytes are a record type with no length; four are a header with no body.
  await assert.rejects(parseNotebook(notebook([label("cell"), short(0x0c72)]), QP9), MalformedDocumentError);
  await assert.rejects(parseNotebook(notebook([label("cell"), record(0x0c72, [])]), QP9), MalformedDocumentError);
  // A record of no body that is not one of the listed types is nothing, and the stream may end after it.
  assert.match((await parseNotebook(notebook([label("cell"), record(0x0002, [])]), QP9)).text, /cell/);
});

test("a count of 256 and one of 65536 are read from their own bytes", async () => {
  const entries = (count: number): number[] => Array.from({ length: count }, () => qstr("x")).flat();
  const table = (count: number): number[][] => [
    record(0x0407, [...long(count), ...long(count), ...long(count), ...entries(count)]),
    label("kept"),
  ];
  for (const count of [256, 257, 65536]) {
    const { text } = await parseNotebook(notebook(table(count)), QP9);
    assert.equal(text.trim(), `${"x\n".repeat(count)}kept`, `${count}`);
  }
});

test("a count is a signed 32-bit number, so one with the top bit set is a count of nothing, as in Tika", async () => {
  const table = (count: number[]): Uint8Array => notebook([record(0x0407, [...count, ...long(0), ...long(0)]), label("kept")]);
  for (const count of [[0xff, 0xff, 0xff, 0xff], [0, 0, 0, 0xff], [0, 0, 0, 0x80], [1, 0, 0, 0x80]]) {
    assert.match((await parseNotebook(table(count), QP9)).text, /kept/, count.join(","));
  }
  // The same bytes with the top bit clear are a count of a billion: quattro-pro-count.test.ts.
});

test("a record that says it is shorter than the fields it holds has the rest of them read, and the next record follows", async () => {
  // The BOF record's body is 14 bytes, and says 12: nothing is skipped, and nothing is given back.
  const bof = [...short(0x0001), ...short(12), ...latin1("QPW9"), ...short(7), ...short(8), ...short(0xffff), ...short(3), ...short(4)];
  const { text, metadata } = await parseNotebook(notebook([bof, label("kept")]), QP9);
  assert.equal(metadata.get("quattropro:id"), "QPW9");
  assert.match(text, /kept/);
});

test("a string is the number of bytes asked for, whatever they are", async () => {
  const { text } = await parseNotebook(notebook([record(0x0c72, [...short(0), ...long(0), ...short(0), ...short(2), 0, ...latin1("abc")])]), QP9);
  assert.equal(text.trim(), "abc");
});
