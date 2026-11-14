import assert from "node:assert/strict";
import { test } from "node:test";
import { MalformedDocumentError, Metadata } from "@spikedpunch/ripstream-core";
import { CompoundFile, hasSignature } from "../src/cfb.ts";
import {
  applyPropertySetMetadata,
  parsePropertySets,
} from "../src/property-sets.ts";

const SECTOR = 512;

function writeUInt16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUInt32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function writeName(view: DataView, offset: number, name: string): number {
  for (let index = 0; index < name.length; index++) {
    view.setUint16(offset + index * 2, name.charCodeAt(index), true);
  }
  view.setUint16(offset + name.length * 2, 0, true);
  return (name.length + 1) * 2;
}

function buildCompoundFile(): Uint8Array {
  const sectors = 11;
  const data = new Uint8Array(SECTOR + sectors * SECTOR);
  const view = new DataView(data.buffer);

  data.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  writeUInt16(view, 24, 0x003e);
  writeUInt16(view, 26, 3);
  writeUInt16(view, 28, 0xfffe);
  writeUInt16(view, 30, 9);
  writeUInt16(view, 32, 6);
  writeUInt32(view, 40, 0);
  writeUInt32(view, 44, 1);
  writeUInt32(view, 48, 1);
  writeUInt32(view, 56, 4096);
  writeUInt32(view, 60, 0xfffffffe);
  writeUInt32(view, 64, 0);
  writeUInt32(view, 68, 0xfffffffe);
  writeUInt32(view, 72, 0);
  writeUInt32(view, 76, 0);
  for (let index = 1; index < 109; index++) {
    writeUInt32(view, 76 + index * 4, 0xffffffff);
  }

  const fat = SECTOR;
  writeUInt32(view, fat, 0xfffffffd);
  writeUInt32(view, fat + 4, 0xfffffffe);
  for (let index = 2; index <= 9; index++) {
    writeUInt32(view, fat + index * 4, index + 1);
  }
  writeUInt32(view, fat + 10 * 4, 0xfffffffe);
  for (let index = 11; index < 128; index++) {
    writeUInt32(view, fat + index * 4, 0xffffffff);
  }

  const directory = 2 * SECTOR;
  const rootNameLength = writeName(view, directory, "Root Entry");
  view.setUint16(directory + 64, rootNameLength, true);
  data[directory + 66] = 5;
  data[directory + 67] = 1;
  writeUInt32(view, directory + 68, 0xffffffff);
  writeUInt32(view, directory + 72, 0xffffffff);
  writeUInt32(view, directory + 76, 1);
  writeUInt32(view, directory + 116, 0xfffffffe);
  writeUInt32(view, directory + 120, 0);

  const streamEntry = directory + 128;
  const streamNameLength = writeName(view, streamEntry, "WordDocument");
  view.setUint16(streamEntry + 64, streamNameLength, true);
  data[streamEntry + 66] = 2;
  data[streamEntry + 67] = 1;
  writeUInt32(view, streamEntry + 68, 0xffffffff);
  writeUInt32(view, streamEntry + 72, 0xffffffff);
  writeUInt32(view, streamEntry + 76, 0xffffffff);
  writeUInt32(view, streamEntry + 116, 2);
  writeUInt32(view, streamEntry + 120, 4608);
  writeUInt32(view, streamEntry + 124, 0);

  for (let index = 0; index < 4608; index++) {
    data[3 * SECTOR + index] = index % 251;
  }
  return data;
}

test("reads streams from a compound file", () => {
  const data = buildCompoundFile();
  assert.equal(hasSignature(data), true);
  const file = CompoundFile.parse(data);
  assert.equal(file.has("WordDocument"), true);
  assert.equal(file.get("WordDocument")?.size, 4608);
  const stream = file.read("WordDocument");
  assert.equal(stream.byteLength, 4608);
  assert.equal(stream[0], 0);
  assert.equal(stream[251], 0);
  assert.equal(stream[252], 1);
  assert.equal(stream[4607], 4607 % 251);
});

test("clamps a header mini-stream cutoff above 4096 (the spec fixes it there)", () => {
  // A hostile cutoff of 0xFFFFFFFF would route this 4608-byte stream through the mini FAT, where it reads as zeros
  // (and a multi-GB declared size would allocate that much up front). The cutoff is clamped to 4096.
  const data = buildCompoundFile();
  writeUInt32(new DataView(data.buffer), 56, 0xffffffff);
  const stream = CompoundFile.parse(data).read("WordDocument");
  assert.equal(stream.byteLength, 4608);
  assert.equal(stream[252], 1);
  assert.equal(stream[4607], 4607 % 251);
});

// Oracle (Tika 4.2.0 /rmeta, a .doc, .ppt and .xls whose main stream's chain was cut by an end-of-chain, a free sector, a sector past the
// file, or a cut file): POI's DocumentInputStream fails past the chain ("Can't read past the end of the stream", "Block N not found")
// and Tika records a container-exception with no text. The reader used to give the bytes it had, and the parsers an empty document.
for (const [name, cut] of [
  ["an end-of-chain", (data: Uint8Array) => writeUInt32(new DataView(data.buffer), SECTOR + 5 * 4, 0xfffffffe)],
  ["a free sector", (data: Uint8Array) => writeUInt32(new DataView(data.buffer), SECTOR + 5 * 4, 0xffffffff)],
  ["a sector past the file", (data: Uint8Array) => writeUInt32(new DataView(data.buffer), SECTOR + 5 * 4, 5000)],
] as const) {
  test(`a stream whose chain ends in ${name} before its declared size is truncated, and read says so`, () => {
    const data = buildCompoundFile();
    cut(data);
    const file = CompoundFile.parse(data);
    assert.throws(() => file.read("WordDocument"), (error: unknown) => error instanceof MalformedDocumentError && /truncated/.test(error.message));
    const partial = file.readUpTo("WordDocument");
    assert.equal(partial.truncated, true);
    assert.equal(partial.bytes.byteLength, 4 * SECTOR);
  });
}

test("a file cut inside its stream is truncated, and a stream declared past its chain end is", () => {
  const data = buildCompoundFile();
  const cutFile = CompoundFile.parse(data.slice(0, 6 * SECTOR));
  assert.throws(() => cutFile.read("WordDocument"), MalformedDocumentError);
  const declared = buildCompoundFile();
  writeUInt32(new DataView(declared.buffer), 2 * SECTOR + 128 + 120, 4608 + 4096);
  assert.equal(CompoundFile.parse(declared).readUpTo("WordDocument").truncated, true);
});

test("a whole stream is not truncated", () => {
  assert.equal(CompoundFile.parse(buildCompoundFile()).readUpTo("WordDocument").truncated, false);
});

test("rejects non-compound data and missing streams", () => {
  assert.throws(
    () => CompoundFile.parse(new Uint8Array(64)),
    MalformedDocumentError,
  );
  const file = CompoundFile.parse(buildCompoundFile());
  assert.throws(() => file.read("Missing"), MalformedDocumentError);
});

function buildSummaryInformation(): Uint8Array {
  const section = new Uint8Array(72);
  const view = new DataView(section.buffer);
  const count = 3;
  const entries = 8 + count * 8;
  writeUInt32(view, 0, 72);
  writeUInt32(view, 4, count);

  writeUInt32(view, 8, 1);
  writeUInt32(view, 12, entries);
  writeUInt16(view, entries, 2);
  writeUInt16(view, entries + 4, 1252);

  const title = entries + 8;
  writeUInt32(view, 16, 2);
  writeUInt32(view, 20, title);
  writeUInt16(view, title, 30);
  writeUInt32(view, title + 4, 6);
  section.set(new TextEncoder().encode("Hello\0"), title + 8);

  const created = entries + 24;
  writeUInt32(view, 24, 12);
  writeUInt32(view, 28, created);
  writeUInt16(view, created, 64);
  const filetime = 132_223_104_000_000_000n;
  view.setBigUint64(created + 4, filetime, true);

  const header = new Uint8Array(48);
  const headerView = new DataView(header.buffer);
  writeUInt16(headerView, 0, 0xfffe);
  writeUInt32(headerView, 24, 1);
  header.set(
    [
      0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 0x08, 0x00,
      0x2b, 0x27, 0xb3, 0xd9,
    ],
    28,
  );
  writeUInt32(headerView, 44, 48);

  const data = new Uint8Array(header.byteLength + section.byteLength);
  data.set(header);
  data.set(section, header.byteLength);
  return data;
}

test("parses summary information property sets", () => {
  const sets = parsePropertySets(buildSummaryInformation());
  assert.equal(sets.length, 1);
  const metadata = new Metadata();
  applyPropertySetMetadata(metadata, sets);
  assert.equal(metadata.get("dc:title"), "Hello");
  assert.match(metadata.get("dcterms:created") ?? "", /^2020-01-01/);
});

test("rejects invalid property set headers", () => {
  assert.throws(
    () => parsePropertySets(new Uint8Array(8)),
    MalformedDocumentError,
  );
});

function headerOnly(sectorShift: number, numDifat: number, firstDifat: number): Uint8Array {
  const data = new Uint8Array(1024);
  const view = new DataView(data.buffer);
  data.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  writeUInt16(view, 30, sectorShift);
  writeUInt16(view, 32, 6);
  writeUInt32(view, 44, 1000);
  writeUInt32(view, 48, 0xfffffffe);
  writeUInt32(view, 60, 0xfffffffe);
  writeUInt32(view, 68, firstDifat);
  writeUInt32(view, 72, numDifat);
  for (let index = 0; index < 109; index++) writeUInt32(view, 76 + index * 4, 0xffffffff);
  return data;
}

test("rejects DIFAT self-loop", () => {
  const data = headerOnly(9, 2, 0);
  data.fill(0xff, 512, 1024);
  writeUInt32(new DataView(data.buffer), 1020, 0);
  assert.throws(() => CompoundFile.parse(data), /DIFAT sector loop/);
});

test("rejects oversize DIFAT count and bad sector shifts", () => {
  assert.throws(() => CompoundFile.parse(headerOnly(9, 0xffffffff, 0)), /DIFAT count/);
  assert.throws(() => CompoundFile.parse(headerOnly(31, 0, 0xfffffffe)), /sector shift/);
  assert.throws(() => CompoundFile.parse(headerOnly(30, 0, 0xfffffffe)), /sector shift/);
});

test("rejects directory tree cycle", () => {
  const data = buildCompoundFile();
  const view = new DataView(data.buffer);
  // stream entry (index 1) right sibling points back to itself
  writeUInt32(view, 2 * SECTOR + 128 + 72, 1);
  assert.throws(() => CompoundFile.parse(data), /directory loop/);
});

function buildLeftChain(entryCount: number): Uint8Array {
  const sectorSize = 4096;
  const fatSectors = 4;
  const dirSectors = Math.ceil((entryCount * 128) / sectorSize);
  const data = new Uint8Array(sectorSize * (1 + fatSectors + dirSectors));
  const view = new DataView(data.buffer);
  data.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  writeUInt16(view, 26, 4);
  writeUInt16(view, 30, 12);
  writeUInt16(view, 32, 6);
  writeUInt32(view, 44, fatSectors);
  writeUInt32(view, 48, fatSectors);
  writeUInt32(view, 56, 4096);
  writeUInt32(view, 60, 0xfffffffe);
  writeUInt32(view, 68, 0xfffffffe);
  for (let index = 0; index < 109; index++) {
    writeUInt32(view, 76 + index * 4, index < fatSectors ? index : 0xffffffff);
  }
  const fat = sectorSize;
  const total = fatSectors + dirSectors;
  for (let index = 0; index < fatSectors * 1024; index++) {
    let value = 0xffffffff;
    if (index < fatSectors) value = 0xfffffffd;
    else if (index < total) value = index === total - 1 ? 0xfffffffe : index + 1;
    writeUInt32(view, fat + index * 4, value);
  }
  const directory = (1 + fatSectors) * sectorSize;
  for (let index = 0; index < entryCount; index++) {
    const offset = directory + index * 128;
    const nameLength = writeName(view, offset, index === 0 ? "Root Entry" : "s");
    view.setUint16(offset + 64, nameLength, true);
    data[offset + 66] = index === 0 ? 5 : 2;
    writeUInt32(view, offset + 68, index === 0 || index + 1 >= entryCount ? 0xffffffff : index + 1);
    writeUInt32(view, offset + 72, 0xffffffff);
    writeUInt32(view, offset + 76, index === 0 ? 1 : 0xffffffff);
    writeUInt32(view, offset + 116, 0xfffffffe);
  }
  return data;
}

test("rejects a pathologically deep directory tree without stack overflow", () => {
  assert.throws(
    () => CompoundFile.parse(buildLeftChain(100_000)),
    MalformedDocumentError,
  );
});
