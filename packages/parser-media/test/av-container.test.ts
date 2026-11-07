import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { AsfParser, AviParser, MatroskaParser } from "../src/index.ts";

function riff(): Uint8Array {
  const data = new Uint8Array(12 + 8 + 40);
  data.set([...new TextEncoder().encode("RIFF")], 0);
  const view = new DataView(data.buffer);
  view.setUint32(4, 48, true);
  data.set([...new TextEncoder().encode("AVI ")], 8);
  data.set([...new TextEncoder().encode("avih")], 12);
  view.setUint32(16, 40, true);
  view.setUint32(20, 40_000, true);
  view.setUint32(36, 100, true);
  view.setUint32(52, 640, true);
  view.setUint32(56, 480, true);
  return data;
}

test("reads AVI metadata", async () => {
  const stream = await RipstreamInputStream.from(riff());
  const metadata = new Metadata();
  await new AviParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("tiff:ImageWidth"), "640");
  assert.equal(metadata.get("audio:spi-duration"), "4");
});

test("reads Matroska duration", async () => {
  const duration = new ArrayBuffer(8);
  new DataView(duration).setFloat64(0, 5000);
  const info = [0x15, 0x49, 0xa9, 0x66, 0x8b, 0x44, 0x89, 0x88, ...new Uint8Array(duration)];
  const segment = [0x18, 0x53, 0x80, 0x67, 0x90, ...info];
  const data = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, ...segment]);
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new MatroskaParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("audio:spi-duration"), "5");
});

test("rejects deeply nested EBML with MalformedDocumentError", async () => {
  let content: number[] = [];
  for (let level = 0; level < 100; level++) {
    content = [0xe0, 0x01, 0, 0, 0, 0, 0, 0, content.length, ...content];
  }
  const data = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, ...content]);
  const stream = await RipstreamInputStream.from(data);
  await assert.rejects(
    new MatroskaParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    (error: Error) => error.name === "MalformedDocumentError",
  );
  await stream.close();
});

test("MatroskaParser lists application/x-matroska", () => {
  const types = [...new MatroskaParser().getSupportedTypes()].map(String);
  assert.ok(types.includes("application/x-matroska"));
});

function chunk(id: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length + (payload.length % 2));
  out.set(new TextEncoder().encode(id), 0);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

function list(type: string, ...children: Uint8Array[]): Uint8Array {
  const body = [...new TextEncoder().encode(type), ...children.flatMap((child) => [...child])];
  return chunk("LIST", new Uint8Array(body));
}

test("reads AVI metadata from avih nested in LIST hdrl (spec layout)", async () => {
  const avih = new Uint8Array(56);
  const avihView = new DataView(avih.buffer);
  avihView.setUint32(0, 40_000, true);
  avihView.setUint32(16, 100, true);
  avihView.setUint32(32, 640, true);
  avihView.setUint32(36, 480, true);
  const movi = list("movi", chunk("00dc", new Uint8Array(4)));
  const body = [
    ...new TextEncoder().encode("AVI "),
    ...list("hdrl", chunk("avih", avih)),
    ...movi,
  ];
  const data = new Uint8Array(8 + body.length);
  data.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(data.buffer).setUint32(4, body.length, true);
  data.set(body, 8);
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new AviParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("tiff:ImageWidth"), "640");
  assert.equal(metadata.get("tiff:ImageLength"), "480");
  assert.equal(metadata.get("audio:spi-duration"), "4");
});

test("AVI without any avih is MalformedDocumentError", async () => {
  const body = [...new TextEncoder().encode("AVI "), ...list("hdrl", chunk("strh", new Uint8Array(8)))];
  const data = new Uint8Array(8 + body.length);
  data.set(new TextEncoder().encode("RIFF"), 0);
  data.set(body, 8);
  const stream = await RipstreamInputStream.from(data);
  await assert.rejects(
    new AviParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    (error: Error) => error.name === "MalformedDocumentError",
  );
  await stream.close();
});

function ebml(id: number[], payload: number[]): number[] {
  return [...id, 0x80 | payload.length, ...payload];
}

test("Matroska reads TrackEntry/Video dimensions without Duration", async () => {
  const video = ebml([0xe0], [0xb0, 0x82, 0x02, 0x80, 0xba, 0x82, 0x01, 0xe0]);
  const entry = ebml([0xae], video);
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], entry);
  const segment = ebml([0x18, 0x53, 0x80, 0x67], tracks);
  const data = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, ...segment]);
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new MatroskaParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("tiff:ImageWidth"), "640");
  assert.equal(metadata.get("tiff:ImageLength"), "480");
});

test("Matroska handles an unknown-size Segment and trailing unknown-size Cluster", async () => {
  const video = ebml([0xe0], [0xb0, 0x82, 0x02, 0x80, 0xba, 0x82, 0x01, 0xe0]);
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], ebml([0xae], video));
  const cluster = [0x1f, 0x43, 0xb6, 0x75, 0xff, 0xe7, 0x81, 0x00];
  const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...tracks, ...cluster];
  const data = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, ...segment]);
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new MatroskaParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("tiff:ImageWidth"), "640");
  assert.equal(metadata.get("tiff:ImageLength"), "480");
});

function asfObject(guid: number[], payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(24 + payload.length);
  out.set(guid, 0);
  new DataView(out.buffer).setBigUint64(16, BigInt(out.length), true);
  out.set(payload, 24);
  return out;
}

test("ASF parses File Properties after a preceding Content Description object", async () => {
  const contentDescription = asfObject(
    [0x33, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c],
    new Uint8Array(10),
  );
  const props = new Uint8Array(80);
  const propsView = new DataView(props.buffer);
  propsView.setBigUint64(40, 50_000_000n, true); // 5 s in 100 ns units
  propsView.setBigUint64(56, 1000n, true); // preroll 1000 ms
  const fileProperties = asfObject(
    [0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11, 0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65],
    props,
  );
  const header = new Uint8Array(30);
  header.set([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c], 0);
  new DataView(header.buffer).setBigUint64(16, BigInt(30 + contentDescription.length + fileProperties.length), true);
  new DataView(header.buffer).setUint32(24, 2, true);
  const data = new Uint8Array([...header, ...contentDescription, ...fileProperties]);
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new AsfParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("audio:spi-duration"), "4");
});
