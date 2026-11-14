import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { ImageParser } from "../src/index.ts";

const ASCII = 2;
const LONG = 4;

/** A little-endian TIFF with DateTime in IFD0 and DateTimeOriginal in the Exif IFD (each 20 bytes, NUL included). */
function tiffWithDates(dateTime: string, original: string): Uint8Array {
  const ifd0 = 8;
  const exif = ifd0 + 2 + 2 * 12 + 4;
  const data = exif + 2 + 12 + 4;
  const bytes = new Uint8Array(data + 40);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49, 0x2a, 0x00]);
  view.setUint32(4, ifd0, true);
  const entry = (at: number, tag: number, type: number, count: number, value: number): void => {
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    view.setUint32(at + 8, value, true);
  };
  view.setUint16(ifd0, 2, true);
  entry(ifd0 + 2, 0x0132, ASCII, 20, data);
  entry(ifd0 + 14, 0x8769, LONG, 1, exif);
  view.setUint16(exif, 1, true);
  entry(exif + 2, 0x9003, ASCII, 20, data + 20);
  bytes.set(new TextEncoder().encode(dateTime), data);
  bytes.set(new TextEncoder().encode(original), data + 20);
  return bytes;
}

function jpegWithTiff(tiff: Uint8Array): Uint8Array {
  const length = 2 + 6 + tiff.length;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

// Oracle (Tika 4.2.0 /rmeta, the same file): exif:DateTimeOriginal is "2010-05-04T06:43:54", no zone and no milliseconds, whatever the
// zone of the process. exifr's revived Date was in the process's zone, so the text was 2010-05-04T13:43:54.000Z under Pacific time
// and the previous day under Tokyo's (tikajs-ibvq follow-up, bughunt B34).
test("an EXIF date is written as the zoneless text it is, not as a Date in the process's time zone", async () => {
  const bytes = jpegWithTiff(tiffWithDates("2010:05:04 06:43:55\0", "2010:05:04 06:43:54\0"));
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  try {
    await new ImageParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  assert.equal(metadata.get("exif:DateTimeOriginal"), "2010-05-04T06:43:54");
});
