import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { FlvParser } from "../src/index.ts";

function amfString(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [2, bytes.length >> 8, bytes.length & 0xff, ...bytes];
}
function amfNumber(value: number): number[] {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return [0, ...new Uint8Array(buffer)];
}
function amfObject(entries: Record<string, number>): number[] {
  const bytes: number[] = [8, 0, 0, 0, 0];
  for (const [key, value] of Object.entries(entries)) {
    const name = [...new TextEncoder().encode(key)];
    bytes.push(name.length >> 8, name.length & 0xff, ...name, ...amfNumber(value));
  }
  bytes.push(0, 0, 9);
  return bytes;
}

test("reads FLV onMetaData", async () => {
  const script = [...amfString("onMetaData"), ...amfObject({ duration: 3.5, width: 640, height: 360 })];
  const header = [0x46, 0x4c, 0x56, 1, 0, 0, 0, 0, 9];
  const tagHeader = [
    18,
    (script.length >> 16) & 0xff,
    (script.length >> 8) & 0xff,
    script.length & 0xff,
    0, 0, 0, 0, 0, 0, 0,
  ];
  const data = new Uint8Array([...header, 0, 0, 0, 0, ...tagHeader, ...script]);
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new FlvParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("xmpDM:duration"), "3.5");
  assert.equal(metadata.get("tiff:ImageWidth"), "640");
});
