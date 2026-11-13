import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { PowerPointBinaryParser } from "../src/index.ts";

const SECTOR = 512;

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

function atom(type: number, payload: number[]): number[] {
  return [...u16(0), ...u16(type), ...u32(payload.length), ...payload];
}

/** A container atom: recVer 0xf and the record instance in the high 12 bits. */
function container(type: number, instance: number, payload: number[]): number[] {
  return [...u16((instance << 4) | 0x000f), ...u16(type), ...u32(payload.length), ...payload];
}

function buildPpt(): Uint8Array {
  const text = new TextEncoder().encode("Slide one\r");
  const utf16 = [...text].flatMap((byte) => [byte, 0]);
  // Slide text lives in the SlideListWithText record, not at the stream root.
  const bytes = container(0x0ff0, 0, [
    ...atom(0x0fa0, utf16),
    ...atom(0x0fa8, [...new TextEncoder().encode("Slide two\r")]),
  ]);
  const stream = new Uint8Array(4096);
  stream.set(bytes);
  return buildCompound(stream);
}

function buildCompound(stream: Uint8Array): Uint8Array {
  const sectors = Math.ceil(4096 / SECTOR);
  const total = 2 + sectors;
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
  for (let index = 0; index < sectors; index++) {
    const sector = 2 + index;
    view.setUint32(fat + sector * 4, index === sectors - 1 ? 0xfffffffe : sector + 1, true);
  }
  const directory = 2 * SECTOR;
  const writeEntry = (index: number, name: string, type: number, start: number, size: number): void => {
    const offset = directory + index * 128;
    for (let char = 0; char < name.length; char++) view.setUint16(offset + char * 2, name.charCodeAt(char), true);
    view.setUint16(offset + 64, (name.length + 1) * 2, true);
    data[offset + 66] = type;
    data[offset + 67] = 1;
    view.setUint32(offset + 68, 0xffffffff, true);
    view.setUint32(offset + 72, 0xffffffff, true);
    view.setUint32(offset + 76, index === 0 ? 1 : 0xffffffff, true);
    view.setUint32(offset + 116, start, true);
    view.setUint32(offset + 120, size, true);
  };
  writeEntry(0, "Root Entry", 5, 0, 0);
  writeEntry(1, "PowerPoint Document", 2, 2, 4096);
  data.set(stream, 3 * SECTOR);
  return data;
}

test("extracts PowerPoint text atoms", async () => {
  const stream = await RipstreamInputStream.from(buildPpt());
  const handler = new BodyContentHandler();
  await new PowerPointBinaryParser().parse(
    stream,
    handler,
    new Metadata(),
    new ParseContext(),
  );
  await stream.close();
  assert.match(handler.toString(), /Slide one/);
  assert.match(handler.toString(), /Slide two/);
});

test("rejects deeply nested containers with MalformedDocumentError", async () => {
  let nested: number[] = atom(0x0fa8, [0x41]);
  for (let level = 0; level < 100; level++) {
    nested = [...u16(0x000f), ...u16(0x03e8), ...u32(nested.length), ...nested];
  }
  const stream = new Uint8Array(4096);
  stream.set(nested);
  const input = await RipstreamInputStream.from(buildCompound(stream));
  await assert.rejects(
    new PowerPointBinaryParser().parse(input, new BodyContentHandler(), new Metadata(), new ParseContext()),
    (error: Error) => error.name === "MalformedDocumentError",
  );
  await input.close();
});
