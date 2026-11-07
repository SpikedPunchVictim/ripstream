import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { MsgParser } from "../src/index.ts";

const SECTOR = 512;
const NO_STREAM = 0xffffffff;

function utf16(value: string): Uint8Array {
  const bytes = new Uint8Array(Math.max(4096, (value.length + 1) * 2));
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >> 8;
  }
  return bytes;
}

function buildMsg(): Uint8Array {
  const streams = [
    { name: "__properties_version1.0", data: new Uint8Array(4096) },
    { name: "__substg1.0_0037001F", data: utf16("Corpus MSG") },
    { name: "__substg1.0_1000001F", data: utf16("Hello from MSG\r\nBody line") },
  ];
  const sectorsPer = streams.map(() => 8);
  const total = 2 + sectorsPer.reduce((a, b) => a + b, 0);
  const data = new Uint8Array(SECTOR + total * SECTOR);
  const view = new DataView(data.buffer);
  data.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 1, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, 0xfffffffe, true);
  view.setUint32(68, 0xfffffffe, true);
  view.setUint32(76, 0, true);
  for (let index = 1; index < 109; index++) view.setUint32(76 + index * 4, 0xffffffff, true);

  const fat = SECTOR;
  view.setUint32(fat, 0xfffffffd, true);
  view.setUint32(fat + 4, 0xfffffffe, true);
  let sector = 2;
  for (const count of sectorsPer) {
    for (let index = 0; index < count; index++) {
      const current = sector + index;
      view.setUint32(fat + current * 4, index === count - 1 ? 0xfffffffe : current + 1, true);
    }
    sector += count;
  }

  const directory = 2 * SECTOR;
  const writeEntry = (index: number, name: string, type: number, right: number, child: number, start: number, size: number): void => {
    const offset = directory + index * 128;
    for (let char = 0; char < name.length; char++) view.setUint16(offset + char * 2, name.charCodeAt(char), true);
    view.setUint16(offset + 64, (name.length + 1) * 2, true);
    data[offset + 66] = type;
    data[offset + 67] = 1;
    view.setUint32(offset + 68, 0xffffffff, true);
    view.setUint32(offset + 72, right, true);
    view.setUint32(offset + 76, child, true);
    view.setUint32(offset + 116, start, true);
    view.setUint32(offset + 120, size, true);
  };
  writeEntry(0, "Root Entry", 5, NO_STREAM, 1, 0, 0);
  sector = 2;
  streams.forEach((stream, index) => {
    writeEntry(index + 1, stream.name, 2, index + 1 < streams.length ? index + 2 : NO_STREAM, NO_STREAM, sector, 4096);
    data.set(stream.data, (sector + 1) * SECTOR);
    sector += 8;
  });
  return data;
}

test("extracts Outlook MSG subject and body", async () => {
  const stream = await RipstreamInputStream.from(buildMsg());
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new MsgParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("dc:title"), "Corpus MSG");
  assert.match(handler.toString(), /Hello from MSG/);
  assert.match(handler.toString(), /Body line/);
});
