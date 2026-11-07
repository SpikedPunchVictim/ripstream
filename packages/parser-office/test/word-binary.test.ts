import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  EncryptedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { WordBinaryParser } from "../src/index.ts";

const SECTOR = 512;
const NO_STREAM = 0xffffffff;

interface Stream {
  readonly name: string;
  readonly data: Uint8Array;
}

function buildCompound(streams: Stream[]): Uint8Array {
  const sectorsPerStream = streams.map((stream) =>
    Math.ceil(Math.max(stream.data.byteLength, 4096) / SECTOR),
  );
  const directorySectors = Math.ceil(((streams.length + 1) * 128) / SECTOR);
  const firstDataSector = 2 + directorySectors;
  const totalSectors =
    firstDataSector + sectorsPerStream.reduce((sum, count) => sum + count, 0);
  const data = new Uint8Array(SECTOR + totalSectors * SECTOR);
  const view = new DataView(data.buffer);

  data.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(40, directorySectors, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 1, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, 0xfffffffe, true);
  view.setUint32(64, 0, true);
  view.setUint32(68, 0xfffffffe, true);
  view.setUint32(72, 0, true);
  view.setUint32(76, 0, true);
  for (let index = 1; index < 109; index++) {
    view.setUint32(76 + index * 4, 0xffffffff, true);
  }

  const fat = SECTOR;
  const fatEntries = totalSectors + 1;
  for (let index = 0; index < fatEntries; index++) {
    view.setUint32(fat + index * 4, 0xffffffff, true);
  }
  view.setUint32(fat, 0xfffffffd, true);
  view.setUint32(fat + 4, 0xfffffffe, true);

  const directory = 2 * SECTOR;
  const nameLength = (name: string): number => (name.length + 1) * 2;
  const writeEntry = (
    index: number,
    name: string,
    type: number,
    right: number,
    child: number,
    start: number,
    size: number,
  ): void => {
    const offset = directory + index * 128;
    for (let char = 0; char < name.length; char++) {
      view.setUint16(offset + char * 2, name.charCodeAt(char), true);
    }
    view.setUint16(offset + 64, nameLength(name), true);
    data[offset + 66] = type;
    data[offset + 67] = 1;
    view.setUint32(offset + 68, 0xffffffff, true);
    view.setUint32(offset + 72, right, true);
    view.setUint32(offset + 76, child, true);
    view.setUint32(offset + 116, start, true);
    view.setUint32(offset + 120, size, true);
    view.setUint32(offset + 124, 0, true);
  };
  writeEntry(0, "Root Entry", 5, NO_STREAM, 1, 0, 0);

  let sector = firstDataSector;
  streams.forEach((stream, index) => {
    const count = sectorsPerStream[index]!;
    for (let offset = 0; offset < count; offset++) {
      const current = sector + offset;
      view.setUint32(
        fat + current * 4,
        offset === count - 1 ? 0xfffffffe : current + 1,
        true,
      );
    }
    const size = Math.max(stream.data.byteLength, 4096);
    const start = (sector + 1) * SECTOR;
    data.set(stream.data, start);
    const entry = directory + (index + 1) * 128;
    void entry;
    writeEntry(
      index + 1,
      stream.name,
      2,
      index + 1 < streams.length ? index + 2 : NO_STREAM,
      NO_STREAM,
      sector,
      size,
    );
    sector += count;
  });

  return data;
}

function buildSummaryInformation(title: string): Uint8Array {
  const section = new Uint8Array(40);
  const view = new DataView(section.buffer);
  const entries = 16;
  view.setUint32(0, 40, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 2, true);
  view.setUint32(12, entries, true);
  view.setUint16(entries, 30, true);
  const text = new TextEncoder().encode(`${title}\0`);
  view.setUint32(entries + 4, text.byteLength, true);
  section.set(text, entries + 8);

  const header = new Uint8Array(48);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(0, 0xfffe, true);
  headerView.setUint32(24, 1, true);
  header.set(
    [
      0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 0x08, 0x00,
      0x2b, 0x27, 0xb3, 0xd9,
    ],
    28,
  );
  headerView.setUint32(44, 48, true);

  const result = new Uint8Array(4096);
  result.set(header);
  result.set(section, header.byteLength);
  return result;
}

function buildWordDocument(
  text: string,
  encrypted = false,
): { word: Uint8Array; table: Uint8Array } {
  const data = new Uint8Array(4096);
  const view = new DataView(data.buffer);
  const table = new Uint8Array(4096);
  const tableView = new DataView(table.buffer);

  view.setUint16(0, 0xa5ec, true);
  view.setUint16(2, 0x00c1, true);
  view.setUint16(10, encrypted ? 0x0300 : 0x0200, true);

  const textOffset = 0x800;
  const encoded = new TextEncoder().encode(text);
  data.set(encoded, textOffset);

  tableView.setUint8(0, 0x02);
  tableView.setUint32(1, 16, true);
  tableView.setUint32(5, 0, true);
  tableView.setUint32(9, encoded.byteLength, true);
  tableView.setUint32(15, 0x40000000 | (textOffset * 2), true);

  view.setUint32(0x01a2, 0, true);
  view.setUint32(0x01a6, 21, true);
  return { word: data, table };
}

function wordDocumentFiles(text: string, encrypted = false): Uint8Array {
  const built = buildWordDocument(text, encrypted);
  return buildCompound([
    { name: "WordDocument", data: built.word },
    { name: "1Table", data: built.table },
    {
      name: "\u0005SummaryInformation",
      data: buildSummaryInformation("Doc Title"),
    },
  ]);
}

async function parse(data: Uint8Array): Promise<{
  text: string;
  metadata: Metadata;
}> {
  const stream = await RipstreamInputStream.from(data);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new WordBinaryParser().parse(
    stream,
    handler,
    metadata,
    new ParseContext(),
  );
  await stream.close();
  return { text: handler.toString(), metadata };
}

test("extracts Word 97 text through the piece table", async () => {
  const result = await parse(
    wordDocumentFiles("Hello DOC\rSecond paragraph\r"),
  );
  assert.match(result.text, /Hello DOC/);
  assert.match(result.text, /Second paragraph/);
  assert.equal(result.metadata.get("dc:title"), "Doc Title");
});

test("strips field instructions and keeps results", async () => {
  const result = await parse(
    wordDocumentFiles("Before \u0013 PAGE \u0014 7 \u0015 after\r"),
  );
  assert.match(result.text, /Before\s+7\s+after/);
  assert.doesNotMatch(result.text, /PAGE/);
});

test("rejects encrypted Word documents", async () => {
  await assert.rejects(
    parse(wordDocumentFiles("secret\r", true)),
    EncryptedDocumentError,
  );
});

test("detects OLE encryption streams for Word", async () => {
  const built = buildWordDocument("secret\r");
  const data = buildCompound([
    { name: "WordDocument", data: built.word },
    { name: "1Table", data: built.table },
    { name: "EncryptionInfo", data: new Uint8Array(4096) },
  ]);
  await assert.rejects(parse(data), EncryptedDocumentError);
});
