import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { ImageParser } from "../src/index.ts";

/**
 * tikajs-68os.45: for PNG, GIF and BMP, Tika's ImageParser.extractMetadata (read from Tika source, not run) writes
 * `tk:num-images`, `tiff:ImageWidth`/`tiff:ImageLength` and `img:height`/`img:width` from the ImageIO reader, as it
 * does for ICNS, ICO, WBMP, PPM and JBIG2 (see setImageReaderMetadata).
 */

async function parseBytes(bytes: Uint8Array, contentType?: string): Promise<Metadata> {
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  if (contentType !== undefined) metadata.set("Content-Type", contentType);
  try {
    await new ImageParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata;
}

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
  bytes.set(new TextEncoder().encode("IEND"), 8 + 25 + 4);
  return bytes;
}

function bmp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(54);
  bytes.set([0x42, 0x4d]);
  const view = new DataView(bytes.buffer);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  return bytes;
}

const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];

interface GifFrame {
  readonly width: number;
  readonly height: number;
  /** Colours in a local colour table, a power of two from 2 to 256; omitted for none. */
  readonly localColors?: number;
  /** The LZW minimum code size byte; 2 when omitted. */
  readonly lzwMinimum?: number;
  /** The image data sub-blocks (each at most 255 bytes); a block of three bytes and one of one byte when omitted. */
  readonly subBlocks?: readonly (readonly number[])[];
}

/** A GIF with the given logical screen, then a Graphic Control Extension and an image for each frame. */
function gif(
  screen: { width: number; height: number; globalColors?: number },
  frames: readonly GifFrame[],
  tail: readonly number[] = [0x3b],
): Uint8Array {
  const le16 = (value: number): number[] => [value & 0xff, value >> 8];
  const globalBits = screen.globalColors === undefined ? 0 : Math.log2(screen.globalColors) - 1;
  const out: number[] = [
    ...ascii("GIF89a"), ...le16(screen.width), ...le16(screen.height),
    screen.globalColors === undefined ? 0x00 : 0x80 | globalBits, 0, 0,
  ];
  if (screen.globalColors !== undefined) out.push(...new Array<number>(3 * screen.globalColors).fill(0x66));
  for (const frame of frames) {
    // Graphic Control Extension, then a comment extension of two sub-blocks, so the walk has blocks to step over.
    out.push(0x21, 0xf9, 4, 0, 0, 0, 0, 0);
    out.push(0x21, 0xfe, 3, ...ascii("abc"), 2, ...ascii("de"), 0);
    const colors = frame.localColors;
    const tableBits = colors === undefined ? 0 : Math.log2(colors) - 1;
    out.push(0x2c, ...le16(0), ...le16(0), ...le16(frame.width), ...le16(frame.height));
    out.push(colors === undefined ? 0x00 : 0x80 | tableBits);
    if (colors !== undefined) out.push(...new Array<number>(3 * colors).fill(0x55));
    // LZW minimum code size, then image data in sub-blocks, then the zero-length block that ends them.
    out.push(frame.lzwMinimum ?? 2);
    for (const block of frame.subBlocks ?? [[0x4c, 0x01, 0x00], [0x3b]]) out.push(block.length, ...block);
    out.push(0);
  }
  out.push(...tail);
  return Uint8Array.from(out);
}

test("png: the image size is written under img:width and img:height, and one image counted", async () => {
  const metadata = await parseBytes(png(640, 480), "image/png");
  assert.equal(metadata.get("img:width"), "640");
  assert.equal(metadata.get("img:height"), "480");
  assert.equal(metadata.get("tk:num-images"), "1");
  assert.equal(metadata.get("tiff:ImageWidth"), "640");
  assert.equal(metadata.get("tiff:ImageLength"), "480");
});

test("bmp: the size is written, the sign of a top-down height dropped, and one image counted", async () => {
  const bottomUp = await parseBytes(bmp(320, 200), "image/bmp");
  assert.equal(bottomUp.get("img:width"), "320");
  assert.equal(bottomUp.get("img:height"), "200");
  assert.equal(bottomUp.get("tk:num-images"), "1");
  assert.equal(bottomUp.get("tiff:ImageWidth"), "320");
  assert.equal(bottomUp.get("tiff:ImageLength"), "200");

  const topDown = await parseBytes(bmp(320, -200), "image/x-ms-bmp");
  assert.equal(topDown.get("img:height"), "200");
});

test("gif: one frame", async () => {
  const metadata = await parseBytes(gif({ width: 100, height: 75 }, [{ width: 100, height: 75 }]), "image/gif");
  assert.equal(metadata.get("img:width"), "100");
  assert.equal(metadata.get("img:height"), "75");
  assert.equal(metadata.get("tk:num-images"), "1");
  assert.equal(metadata.get("tiff:ImageWidth"), "100");
  assert.equal(metadata.get("tiff:ImageLength"), "75");
});

test("gif: every frame is counted, and the size is that of the first", async () => {
  // ImageIO's GIF reader sizes image 0 by its image descriptor, not by the logical screen.
  const frames = [
    { width: 60, height: 40 },
    { width: 10, height: 10, localColors: 4 },
    { width: 100, height: 75 },
  ];
  const metadata = await parseBytes(gif({ width: 100, height: 75 }, frames), "image/gif");
  assert.equal(metadata.get("tk:num-images"), "3");
  assert.equal(metadata.get("img:width"), "60");
  assert.equal(metadata.get("img:height"), "40");
  assert.equal(metadata.get("tiff:ImageWidth"), "60");
  assert.equal(metadata.get("tiff:ImageLength"), "40");
});

test("gif: a missing trailer still counts the frames walked", async () => {
  const metadata = await parseBytes(gif({ width: 8, height: 8 }, [{ width: 8, height: 8 }, { width: 8, height: 8 }], []));
  assert.equal(metadata.get("tk:num-images"), "2");
});

test("gif: a frame cut off inside its image data is counted, one cut off inside its descriptor is not", async () => {
  const full = gif({ width: 8, height: 8 }, [{ width: 8, height: 8 }, { width: 8, height: 8 }]);
  const lastDescriptor = full.lastIndexOf(0x2c);
  const inData = await parseBytes(full.subarray(0, lastDescriptor + 12));
  assert.equal(inData.get("tk:num-images"), "2");
  const inDescriptor = await parseBytes(full.subarray(0, lastDescriptor + 5));
  assert.equal(inDescriptor.get("tk:num-images"), "1");
});

test("gif: a block type of zero writes nothing from the reader, as Tika ignores that ImageIO error (TIKA-619)", async () => {
  const metadata = await parseBytes(gif({ width: 8, height: 8 }, [{ width: 8, height: 8 }], [0x00, 0x3b]), "image/gif");
  assert.equal(metadata.get("tk:num-images"), null);
  assert.equal(metadata.get("img:width"), null);
  assert.equal(metadata.get("img:height"), null);
});

test("gif: no frame at all writes no image keys, and the logical screen still sizes the document", async () => {
  const metadata = await parseBytes(gif({ width: 8, height: 6 }, []), "image/gif");
  assert.equal(metadata.get("tk:num-images"), null);
  assert.equal(metadata.get("img:width"), null);
  assert.equal(metadata.get("tiff:ImageWidth"), "8");
  assert.equal(metadata.get("tiff:ImageLength"), "6");
});

test("gif: a long run of empty sub-blocks and extensions ends at the data's end", async () => {
  // Each block takes at least one byte, so the walk cannot outrun the data: 200000 bytes of extension introducers.
  const body = new Array<number>(200_000).fill(0x21);
  const bytes = Uint8Array.from([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0, ...body]);
  const metadata = await parseBytes(bytes, "image/gif");
  assert.equal(metadata.get("tk:num-images"), null);
});

test("jpeg and tiff are not read by Tika's ImageParser, so they carry no img keys", async () => {
  const tiff = new Uint8Array(38);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0], 0);
  tiff.set([2, 0], 8);
  tiff.set([0x00, 0x01, 3, 0, 1, 0, 0, 0, 0x40, 0x01, 0, 0], 10);
  tiff.set([0x01, 0x01, 3, 0, 1, 0, 0, 0, 0x2c, 0x01, 0, 0], 22);
  const metadata = await parseBytes(tiff, "image/tiff");
  assert.equal(metadata.get("tiff:ImageWidth"), "320");
  assert.equal(metadata.get("img:width"), null);
  assert.equal(metadata.get("tk:num-images"), null);
});

test("gif: colour tables of 2, 16 and 256 entries, global and local, are stepped over", async () => {
  for (const colors of [2, 16, 256]) {
    const frames = [{ width: 8, height: 8, localColors: colors }, { width: 8, height: 8, localColors: colors }];
    const metadata = await parseBytes(gif({ width: 100, height: 75, globalColors: colors }, frames), "image/gif");
    assert.equal(metadata.get("tk:num-images"), "2", `${colors} colours`);
  }
});

test("gif: a width or height above 255 uses both bytes", async () => {
  const metadata = await parseBytes(gif({ width: 100, height: 75 }, [{ width: 0x123, height: 0x245 }]), "image/gif");
  assert.equal(metadata.get("img:width"), String(0x123));
  assert.equal(metadata.get("img:height"), String(0x245));
});

test("gif: a descriptor that ends exactly at the end of the data is counted, one without its packed byte is not", async () => {
  const full = gif({ width: 8, height: 8 }, [{ width: 8, height: 8 }, { width: 8, height: 8 }]);
  const lastDescriptor = full.lastIndexOf(0x2c);
  const whole = await parseBytes(full.subarray(0, lastDescriptor + 10));
  assert.equal(whole.get("tk:num-images"), "2");
  const noPackedByte = await parseBytes(full.subarray(0, lastDescriptor + 9));
  assert.equal(noPackedByte.get("tk:num-images"), "1");
});

test("gif: image data whose bytes look like block ids is stepped over by its sub-block sizes", async () => {
  const lookalike = { width: 8, height: 8, lzwMinimum: 8, subBlocks: [[0x2c, 0x2c, 0x3b, 0x21, 0x00], [0x3b, 0x3b, 0x3b]] };
  const metadata = await parseBytes(gif({ width: 8, height: 8 }, [lookalike, lookalike, lookalike]), "image/gif");
  assert.equal(metadata.get("tk:num-images"), "3");
});

test("gif: nothing after the trailer is counted", async () => {
  const frame = gif({ width: 8, height: 8 }, [{ width: 8, height: 8 }], []).subarray(13);
  const metadata = await parseBytes(gif({ width: 8, height: 8 }, [{ width: 8, height: 8 }], [0x3b, ...frame]));
  assert.equal(metadata.get("tk:num-images"), "1");
});

test("gif: nothing after a block of an unknown type is counted", async () => {
  const frame = gif({ width: 8, height: 8 }, [{ width: 8, height: 8 }], []).subarray(13);
  const metadata = await parseBytes(gif({ width: 8, height: 8 }, [{ width: 8, height: 8 }], [0x99, ...frame]));
  assert.equal(metadata.get("tk:num-images"), "1");
});

test("png and bmp: the shortest data that holds a size is read, as ImageIO reads it", async () => {
  const shortPng = await parseBytes(png(640, 480).subarray(0, 24));
  assert.equal(shortPng.get("img:width"), "640");
  assert.equal(shortPng.get("tk:num-images"), "1");
  const shortBmp = await parseBytes(bmp(320, 200).subarray(0, 26));
  assert.equal(shortBmp.get("img:width"), "320");
  assert.equal(shortBmp.get("tk:num-images"), "1");
});

test("a jpeg with no size writes no image keys at all", async () => {
  const metadata = await parseBytes(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), "image/jpeg");
  assert.equal(metadata.get("tk:num-images"), null);
  assert.equal(metadata.get("img:width"), null);
  assert.equal(metadata.get("tiff:ImageWidth"), null);
});
