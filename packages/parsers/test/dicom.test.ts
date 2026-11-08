import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DicomParser } from "../src/index.ts";

function element(group: number, element: number, vr: string, value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  const padded = bytes.length % 2 === 0 ? bytes : [...bytes, 0x20];
  return [
    group & 0xff, group >> 8, element & 0xff, element >> 8,
    ...[...vr].map((c) => c.charCodeAt(0)),
    padded.length & 0xff, (padded.length >> 8) & 0xff,
    ...padded,
  ];
}

function dicom(): Uint8Array {
  const data = new Uint8Array(132);
  data.set([0x44, 0x49, 0x43, 0x4d], 128);
  const rest = [
    ...element(0x0008, 0x0060, "CS", "MR"),
    ...element(0x0010, 0x0010, "PN", "Doe^Jane"),
    ...element(0x0008, 0x1030, "LO", "Head scan"),
  ];
  const result = new Uint8Array(data.length + rest.length);
  result.set(data);
  result.set(rest, data.length);
  return result;
}

test("extracts DICOM metadata", async () => {
  const stream = await RipstreamInputStream.from(dicom());
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new DicomParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("dicom:Modality"), "MR");
  assert.equal(metadata.get("dicom:PatientName"), "Doe^Jane");
  assert.match(handler.toString(), /Head scan/);
});

function u16(value: number): number[] {
  return [value & 0xff, value >> 8];
}
function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}
const UNDEFINED = [0xff, 0xff, 0xff, 0xff];
const ITEM = [...u16(0xfffe), ...u16(0xe000)];
const ITEM_END = [...u16(0xfffe), ...u16(0xe00d), ...u32(0)];
const SEQ_END = [...u16(0xfffe), ...u16(0xe0dd), ...u32(0)];

function withBody(rest: number[]): Uint8Array {
  const result = new Uint8Array(132 + rest.length);
  result.set([0x44, 0x49, 0x43, 0x4d], 128);
  result.set(rest, 132);
  return result;
}

async function parseDicom(bytes: Uint8Array): Promise<Metadata> {
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  await new DicomParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  return metadata;
}

test("walks past an undefined-length sequence to later tags", async () => {
  // (0008,1111) SQ, undefined length: one undefined-length item holding a nested
  // undefined-length SQ and a decoy PatientName, then a defined-length item.
  const nested = [
    ...u16(0x0008), ...u16(0x1140), ...[0x53, 0x51, 0, 0], ...UNDEFINED,
    ...ITEM, ...u32(0), ...SEQ_END,
  ];
  const sequence = [
    ...u16(0x0008), ...u16(0x1111), ...[0x53, 0x51, 0, 0], ...UNDEFINED,
    ...ITEM, ...UNDEFINED,
    ...element(0x0010, 0x0010, "PN", "Decoy^Name"),
    ...nested,
    ...ITEM_END,
    ...ITEM, ...u32(12), ...element(0x0008, 0x1030, "LO", "Dec"),
    ...SEQ_END,
  ];
  const metadata = await parseDicom(
    withBody([
      ...element(0x0008, 0x0060, "CS", "MR"),
      ...sequence,
      ...element(0x0010, 0x0010, "PN", "Doe^Jane"),
    ]),
  );
  assert.equal(metadata.get("dicom:Modality"), "MR");
  assert.equal(metadata.get("dicom:PatientName"), "Doe^Jane");
});

test("an unterminated undefined-length sequence stops the walk without throwing", async () => {
  const metadata = await parseDicom(
    withBody([
      ...element(0x0008, 0x0060, "CS", "MR"),
      ...u16(0x0008), ...u16(0x1111), ...[0x53, 0x51, 0, 0], ...UNDEFINED,
      ...ITEM, ...UNDEFINED,
    ]),
  );
  assert.equal(metadata.get("dicom:Modality"), "MR");
});

test("a file truncated inside a long-VR header stops the walk without throwing", async () => {
  // OB is a long VR: 2-byte VR, 2 reserved bytes, then a 4-byte length. Cut the
  // file after the reserved bytes so the length field is missing entirely.
  const metadata = await parseDicom(
    withBody([
      ...element(0x0008, 0x0060, "CS", "MR"),
      ...u16(0x0008), ...u16(0x1111), ...[0x4f, 0x42, 0, 0],
    ]),
  );
  assert.equal(metadata.get("dicom:Modality"), "MR");
});
