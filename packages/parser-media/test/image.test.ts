import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { ImageParser } from "../src/index.ts";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(8 + 25 + 12);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  view.setUint32(8 + 25 + 4, 0);
  bytes.set(new TextEncoder().encode("IEND"), 8 + 25 + 4);
  return bytes;
}

test("reads PNG dimensions and emits no text", async () => {
  const stream = await RipstreamInputStream.from(png(640, 480));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new ImageParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("tiff:ImageWidth"), "640");
  assert.equal(metadata.get("tiff:ImageLength"), "480");
  assert.equal(handler.toString(), "");
});

test("reads BMP and WebP dimensions", async () => {
  const bmp = new Uint8Array(54);
  bmp.set([0x42, 0x4d]);
  const bmpView = new DataView(bmp.buffer);
  bmpView.setInt32(18, 320, true);
  bmpView.setInt32(22, 200, true);

  const webp = new Uint8Array(30);
  webp.set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  webp.set([0x56, 0x50, 0x38, 0x58], 12);
  webp[24] = 0x3f;
  webp[25] = 0x01;
  webp[26] = 0;
  webp[27] = 0x2f;
  webp[28] = 0x01;
  webp[29] = 0;

  for (const [bytes, width, height] of [
    [bmp, "320", "200"],
    [webp, "320", "304"],
  ] as const) {
    const stream = await RipstreamInputStream.from(bytes);
    const metadata = new Metadata();
    await new ImageParser().parse(
      stream,
      new BodyContentHandler(),
      metadata,
      new ParseContext(),
    );
    await stream.close();
    assert.equal(metadata.get("tiff:ImageWidth"), width);
    assert.equal(metadata.get("tiff:ImageLength"), height);
  }
});

test("reads TIFF dimensions", async () => {
  const tiff = new Uint8Array(38);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0], 0);
  tiff.set([2, 0], 8);
  tiff.set([0x00, 0x01, 3, 0, 1, 0, 0, 0, 0x40, 0x01, 0, 0], 10);
  tiff.set([0x01, 0x01, 3, 0, 1, 0, 0, 0, 0x2c, 0x01, 0, 0], 22);
  const stream = await RipstreamInputStream.from(tiff);
  const metadata = new Metadata();
  await new ImageParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("tiff:ImageWidth"), "320");
  assert.equal(metadata.get("tiff:ImageLength"), "300");
});

test("reads PSD and JPEG 2000 dimensions", async () => {
  const psd = new Uint8Array(26);
  psd.set([0x38, 0x42, 0x50, 0x53, 0, 1]);
  const psdView = new DataView(psd.buffer);
  psdView.setUint32(14, 200);
  psdView.setUint32(18, 300);
  const jp2 = new Uint8Array(24);
  const jp2View = new DataView(jp2.buffer);
  jp2View.setUint32(0, 0x0000000c);
  jp2.set([0x6a, 0x50, 0x20, 0x20], 4);
  jp2.set([0x69, 0x68, 0x64, 0x72], 8);
  jp2View.setUint32(12, 480);
  jp2View.setUint32(16, 640);
  const j2c = new Uint8Array(24);
  j2c.set([0xff, 0x4f, 0xff, 0x51]);
  const j2cView = new DataView(j2c.buffer);
  j2cView.setUint32(8, 100);
  j2cView.setUint32(12, 80);
  j2cView.setUint32(16, 10);
  j2cView.setUint32(20, 5);
  for (const [bytes, width, height] of [
    [psd, "300", "200"],
    [jp2, "640", "480"],
    [j2c, "90", "75"],
  ] as const) {
    const stream = await RipstreamInputStream.from(bytes);
    const metadata = new Metadata();
    await new ImageParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
    await stream.close();
    assert.equal(metadata.get("tiff:ImageWidth"), width);
    assert.equal(metadata.get("tiff:ImageLength"), height);
  }
});

test("reads HEIF dimensions from ispe", async () => {
  const data = new Uint8Array(48);
  data.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  data.set([0x69, 0x73, 0x70, 0x65, 0, 0, 0, 0], 12);
  const view = new DataView(data.buffer);
  view.setUint32(20, 1024);
  view.setUint32(24, 768);
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new ImageParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("tiff:ImageWidth"), "1024");
  assert.equal(metadata.get("tiff:ImageLength"), "768");
});

test("reads BPG dimensions", async () => {
  const data = new Uint8Array(16);
  data.set([0x42, 0x50, 0x00, 0x01]);
  const view = new DataView(data.buffer);
  view.setUint32(8, 512);
  view.setUint32(12, 256);
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  await new ImageParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("tiff:ImageWidth"), "512");
  assert.equal(metadata.get("tiff:ImageLength"), "256");
});

async function dimsOf(bytes: Uint8Array): Promise<[string | null, string | null]> {
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  await new ImageParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  return [metadata.get("tiff:ImageWidth"), metadata.get("tiff:ImageLength")];
}

function webpHeader(fourcc: string): Uint8Array {
  const webp = new Uint8Array(40);
  webp.set([0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  webp.set(new TextEncoder().encode(fourcc), 12);
  return webp;
}

test("reads lossy WebP (VP8) dimensions at the correct offset", async () => {
  const webp = webpHeader("VP8 ");
  webp.set([0x30, 0x01, 0x00], 20); // frame tag
  webp.set([0x9d, 0x01, 0x2a], 23); // start code
  webp.set([0x80, 0x02], 26); // width 640
  webp.set([0xe0, 0x01], 28); // height 480
  assert.deepEqual(await dimsOf(webp), ["640", "480"]);
});

test("reads lossless WebP (VP8L) dimensions", async () => {
  const webp = webpHeader("VP8L");
  const bits = (640 - 1) | ((480 - 1) << 14);
  webp[20] = 0x2f;
  new DataView(webp.buffer).setUint32(21, bits >>> 0, true);
  assert.deepEqual(await dimsOf(webp), ["640", "480"]);
});

function isoBox(type: string, payload: number[] = [], size?: number): number[] {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, size ?? out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return [...out];
}

// exifr's HEIF detection needs a "heic" compatible brand at offset 16.
const HEIC_FTYP = isoBox("ftyp", [
  0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x68, 0x65, 0x69, 0x63,
]);

async function parseBytes(bytes: Uint8Array): Promise<Metadata> {
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  try {
    await new ImageParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata;
}

test("HEIC with a zero-size box before meta is rejected without hanging", async () => {
  // exifr spins forever on this: offset += 0 while scanning for "meta".
  const data = new Uint8Array([...HEIC_FTYP, ...isoBox("free", [], 0), ...isoBox("mdat", [1, 2])]);
  await assert.rejects(parseBytes(data), MalformedDocumentError);
});

test("HEIC with only a trailing zero-size box and no meta is rejected without hanging", async () => {
  const data = new Uint8Array([...HEIC_FTYP, ...isoBox("mdat", [1, 2, 3, 4], 0)]);
  await assert.rejects(parseBytes(data), MalformedDocumentError);
});

test("zero-size box before meta is rejected even without an ftyp literal", async () => {
  // exifr routes on first-two-bytes-zero + brand at offset 16, not on "ftyp".
  const data = new Uint8Array(48);
  const view = new DataView(data.buffer);
  view.setUint32(0, 24);
  data.set(new TextEncoder().encode("XXXX"), 4);
  data.set(new TextEncoder().encode("heic"), 16);
  data.set(new TextEncoder().encode("heic"), 20);
  view.setUint32(24, 0);
  data.set(new TextEncoder().encode("free"), 28);
  await assert.rejects(parseBytes(data), MalformedDocumentError);
});

test("HEIC with a box smaller than its header is rejected", async () => {
  const data = new Uint8Array([...HEIC_FTYP, ...isoBox("free", [0, 0, 0, 0], 4)]);
  await assert.rejects(parseBytes(data), MalformedDocumentError);
});

test("HEIC with a 64-bit largesize smaller than its header is rejected", async () => {
  const big = new Uint8Array(16);
  const view = new DataView(big.buffer);
  view.setUint32(0, 1);
  big.set(new TextEncoder().encode("free"), 4);
  view.setUint32(12, 8); // < 16-byte header
  const data = new Uint8Array([...HEIC_FTYP, ...big]);
  await assert.rejects(parseBytes(data), MalformedDocumentError);
});

test("truncated HEIC whose box overruns the data does not hang", async () => {
  const data = new Uint8Array([...HEIC_FTYP, ...isoBox("meta", [0, 0, 0, 0], 0x1000)]);
  await parseBytes(data).catch(() => undefined);
});

test("HEIC with meta followed by a zero-size mdat is accepted", async () => {
  const data = new Uint8Array([
    ...HEIC_FTYP,
    ...isoBox("meta", [0, 0, 0, 0]),
    ...isoBox("mdat", [1, 2, 3, 4], 0),
  ]);
  await assert.doesNotReject(parseBytes(data));
});

test("a non-ISO-BMFF image is not subject to the box walk", async () => {
  const metadata = await parseBytes(png(8, 8));
  assert.equal(metadata.get("tiff:ImageWidth"), "8");
});

function jpegWithExifMake(make: string): Uint8Array {
  const text = new TextEncoder().encode(`${make}\0`);
  // TIFF: II, 42, IFD0 at 8; one entry: Make (0x010f), ASCII, count, value at 26
  const tiff = new Uint8Array(26 + text.length);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 1, 0], 0);
  tiff.set([0x0f, 0x01, 2, 0], 10);
  new DataView(tiff.buffer).setUint32(14, text.length, true);
  new DataView(tiff.buffer).setUint32(18, 26, true);
  tiff.set(text, 26);
  const app1Len = 2 + 6 + tiff.length;
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe1, app1Len >> 8, app1Len & 0xff,
    0x45, 0x78, 0x69, 0x66, 0, 0,
    ...tiff,
    0xff, 0xd9,
  ]);
}

test("EXIF metadata is still extracted from a small JPEG", async () => {
  const metadata = await parseBytes(jpegWithExifMake("Acme"));
  assert.equal(metadata.get("tiff:Make"), "Acme");
});
