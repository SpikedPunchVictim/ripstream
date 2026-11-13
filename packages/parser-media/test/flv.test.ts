import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { FlvParser } from "../src/index.ts";

type AmfPrimitive = number | boolean | string;

function amfString(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [2, bytes.length >> 8, bytes.length & 0xff, ...bytes];
}
function amfNumber(value: number): number[] {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return [0, ...new Uint8Array(buffer)];
}
function amfValue(value: AmfPrimitive): number[] {
  if (typeof value === "number") return amfNumber(value);
  if (typeof value === "boolean") return [1, value ? 1 : 0];
  return amfString(value);
}
function amfObject(entries: Record<string, AmfPrimitive>): number[] {
  const keys = Object.keys(entries);
  // An ECMA array declares its entry count, like Tika's readAMFEcmaArray.
  const bytes: number[] = [8, (keys.length >>> 24) & 0xff, (keys.length >>> 16) & 0xff, (keys.length >>> 8) & 0xff, keys.length & 0xff];
  for (const [key, value] of Object.entries(entries)) {
    const name = [...new TextEncoder().encode(key)];
    bytes.push(name.length >> 8, name.length & 0xff, ...name, ...amfValue(value));
  }
  return bytes;
}

function flv(entries: Record<string, AmfPrimitive> | null, typeFlags = 5): Uint8Array {
  const header = [0x46, 0x4c, 0x56, 1, typeFlags, 0, 0, 0, 9];
  if (entries === null) return new Uint8Array([...header, 0, 0, 0, 0]);
  const script = [...amfString("onMetaData"), ...amfObject(entries)];
  const tagHeader = [
    18,
    (script.length >> 16) & 0xff,
    (script.length >> 8) & 0xff,
    script.length & 0xff,
    0, 0, 0, 0, 0, 0, 0,
  ];
  const previousTagSize = script.length + 11;
  return new Uint8Array([
    ...header, 0, 0, 0, 0, ...tagHeader, ...script,
    (previousTagSize >>> 24) & 0xff, (previousTagSize >>> 16) & 0xff, (previousTagSize >>> 8) & 0xff, previousTagSize & 0xff,
  ]);
}

async function parse(data: Uint8Array): Promise<Metadata> {
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new FlvParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  return metadata;
}

test("writes the header's audio and video flags as flv:hasAudio and flv:hasVideo", async () => {
  const both = await parse(flv(null, 5));
  assert.equal(both.get("flv:hasAudio"), "true");
  assert.equal(both.get("flv:hasVideo"), "true");
  const audio = await parse(flv(null, 1));
  assert.equal(audio.get("flv:hasAudio"), "true");
  assert.equal(audio.get("flv:hasVideo"), "false");
  const none = await parse(flv(null, 0));
  assert.equal(none.get("flv:hasAudio"), "false");
  assert.equal(none.get("flv:hasVideo"), "false");
});

test("writes every scalar onMetaData entry as flv:<key>, as Java prints it", async () => {
  const metadata = await parse(flv({ duration: 3.5, width: 640, height: 360, framerate: 24, stereo: false, videocodecid: "avc1" }));
  assert.equal(metadata.get("flv:duration"), "3.5");
  assert.equal(metadata.get("flv:width"), "640.0");
  assert.equal(metadata.get("flv:height"), "360.0");
  assert.equal(metadata.get("flv:framerate"), "24.0");
  assert.equal(metadata.get("flv:stereo"), "false");
  assert.equal(metadata.get("flv:videocodecid"), "avc1");
  // Tika's FLVParser writes only the flv:* names, not the XMP or TIFF aliases.
  assert.equal(metadata.get("xmpDM:duration"), null);
  assert.equal(metadata.get("tiff:ImageWidth"), null);
});

test("a malformed metadata tag stops the scan, as Tika aborts the document", async () => {
  const header = [0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9];
  const tag = (script: number[]): number[] => {
    const previous = script.length + 11;
    return [
      18, (script.length >> 16) & 0xff, (script.length >> 8) & 0xff, script.length & 0xff, 0, 0, 0, 0, 0, 0, 0,
      ...script,
      (previous >>> 24) & 0xff, (previous >>> 16) & 0xff, (previous >>> 8) & 0xff, previous & 0xff,
    ];
  };
  // An ECMA array whose entry is a string that declares more bytes than the tag holds: the read fails.
  const malformed = [...amfString("onMetaData"), 8, 0, 0, 0, 1, 0, 4, ...[..."name"].map((c) => c.charCodeAt(0)), 2, 0, 50];
  const good = [...amfString("onMetaData"), ...amfObject({ duration: 1 })];
  const metadata = await parse(new Uint8Array([...header, 0, 0, 0, 0, ...tag(malformed), ...tag(good)]));
  assert.equal(metadata.get("flv:duration"), null);
  assert.equal(metadata.get("flv:hasVideo"), "true");
});
