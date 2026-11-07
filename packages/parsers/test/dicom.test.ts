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
