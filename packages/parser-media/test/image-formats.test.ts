import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { ImageParser } from "../src/index.ts";

/*
 * ICNS, ICO/CUR, WBMP, JBIG2, PPM and XCF, each on a hand-made header of a few dozen bytes. Tika's ICNSParser and
 * ICOParser are read from their source; its ImageParser hands WBMP, JBIG2, PPM and XCF to javax.imageio, whose output
 * is reproduced here only as far as the keys ImageParser itself writes (see imageio-metadata.ts).
 */

const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];
const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const le32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

async function parseAs(type: string | null, bytes: Uint8Array): Promise<Metadata> {
  const metadata = new Metadata();
  if (type !== null) metadata.set("Content-Type", type);
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  try {
    await new ImageParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  assert.equal(handler.toString(), "", "an image has no text");
  return metadata;
}

function patch(file: Uint8Array, offset: number, ...bytes: number[]): Uint8Array {
  const copy = file.slice();
  copy.set(bytes, offset);
  return copy;
}

/** Every prefix of a file parses or fails with MalformedDocumentError. */
async function assertPrefixesSafe(type: string, full: Uint8Array, label: string): Promise<void> {
  for (let length = 0; length <= full.length; length++) {
    try {
      await parseAs(type, full.slice(0, length));
    } catch (error) {
      assert.ok(
        error instanceof MalformedDocumentError,
        `${label} prefix ${length}: ${error instanceof Error ? error.constructor.name : String(error)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------------- claims

test("ImageParser claims the types of ICNSParser, ICOParser and the ImageParser formats it did not serve", () => {
  const supported = new Set([...new ImageParser().getSupportedTypes()].map((type) => type.toString()));
  for (const type of [
    "image/icns",
    "image/vnd.microsoft.icon",
    "image/x-icon",
    "image/x-win-bitmap",
    "image/vnd.wap.wbmp",
    "image/x-jbig2",
    "image/x-portable-pixmap",
    "image/x-xcf",
  ]) {
    assert.ok(supported.has(type), type);
  }
});

// ---------------------------------------------------------------------------------------------------- ICNS

function icns(entries: ReadonlyArray<readonly [string, number]>, declaredLength?: number): Uint8Array {
  const body = entries.flatMap(([type, payloadLength]) => [
    ...ascii(type),
    ...be32(8 + payloadLength),
    ...new Array<number>(payloadLength).fill(0),
  ]);
  return Uint8Array.from([...ascii("icns"), ...be32(declaredLength ?? 8 + body.length), ...body]);
}

test("icns: one PNG/JPEG 2000 icon", async () => {
  const metadata = await parseAs("image/icns", icns([["ic09", 16]]));
  assert.equal(metadata.get("Content-Type"), "image/icns");
  assert.equal(metadata.get("Icon count"), "1");
  assert.equal(metadata.get("Icon details"), "512x512 (JPEG 2000 or PNG format)");
  assert.equal(metadata.get("Masked icon count"), null);
  assert.equal(metadata.get("Masked icon details"), null);
});

test("icns: icons and masks are listed apart, each in file order", async () => {
  const metadata = await parseAs(
    "image/icns",
    icns([
      ["is32", 16],
      ["s8mk", 16],
      ["il32", 16],
      ["l8mk", 16],
    ]),
  );
  assert.equal(metadata.get("Icon count"), "2");
  assert.equal(metadata.get("Icon details"), "16x16 (24 bpp), 32x32 (24 bpp)");
  assert.equal(metadata.get("Masked icon count"), "2");
  assert.equal(metadata.get("Masked icon details"), "16x16 (8 bpp), 32x32 (8 bpp)");
});

test("icns: details print height before width, and mark a retina icon", async () => {
  // icm4 is 16 wide and 12 high; ic10 is 1024 at twice the density.
  const metadata = await parseAs(
    "image/icns",
    icns([
      ["icm4", 16],
      ["icm#", 16],
      ["ic10", 16],
      ["ic11", 16],
    ]),
  );
  assert.equal(metadata.get("Icon details"), "12x16 (4 bpp), 1024x1024@2X (JPEG 2000 or PNG format), 16x16@2X (JPEG 2000 or PNG format)");
  assert.equal(metadata.get("Masked icon details"), "12x16 (1 bpp)");
});

test("icns: an unknown sub-icon type ends the walk, and so does a length of zero", async () => {
  const unknown = await parseAs("image/icns", icns([["ic09", 16], ["zzzz", 16], ["is32", 16]]));
  assert.equal(unknown.get("Icon count"), "1");

  // The icon is recorded before its length is read, so a zero length keeps the icon and stops the walk.
  const zero = Uint8Array.from([...ascii("icns"), ...be32(8 + 12), ...ascii("is32"), ...be32(0), 0, 0, 0, 0]);
  assert.equal((await parseAs("image/icns", zero)).get("Icon count"), "1");
});

test("icns: an entry that starts in the last 8 bytes is not read, as in Tika's loop bound", async () => {
  assert.equal((await parseAs("image/icns", icns([["ic09", 0]]))).get("Icon count"), null);
  assert.equal((await parseAs("image/icns", icns([["ic09", 1]]))).get("Icon count"), "1");
});

test("icns: no sub-icons still reports the type", async () => {
  const metadata = await parseAs("image/icns", icns([]));
  assert.equal(metadata.get("Content-Type"), "image/icns");
  assert.equal(metadata.get("Icon count"), null);
});

test("icns: a wrong signature, a short header and a negative length are refused", async () => {
  await assert.rejects(parseAs("image/icns", Uint8Array.from([...ascii("icnz"), ...be32(8)])), MalformedDocumentError);
  await assert.rejects(parseAs("image/icns", Uint8Array.from(ascii("icns"))), MalformedDocumentError);
  // Tika: "image length must be >= 0" for a declared length below the 8 header bytes.
  await assert.rejects(parseAs("image/icns", Uint8Array.from([...ascii("icns"), ...be32(7)])), MalformedDocumentError);
  await assert.rejects(parseAs("image/icns", Uint8Array.from([...ascii("icns"), ...be32(0xffffffff)])), MalformedDocumentError);
});

test("icns: a declared length above 10 MiB is a limit, below it only the bytes present are read", async () => {
  const limit = 10 * 1024 * 1024;
  await assert.rejects(parseAs("image/icns", icns([], 8 + limit + 1)), LimitExceededError);
  await assert.rejects(parseAs("image/icns", icns([], 0x7fffffff)), LimitExceededError);
  // 2^31 as a signed int is negative; minus the 8 header bytes it wraps to a huge positive, as in Java's int.
  await assert.rejects(parseAs("image/icns", icns([], 0x80000000)), LimitExceededError);

  // Exactly the limit is allowed, but the file holds 16 bytes: refused as truncated, without a 10 MiB buffer.
  const before = process.memoryUsage().arrayBuffers;
  await assert.rejects(parseAs("image/icns", icns([["ic09", 0]], 8 + limit)), MalformedDocumentError);
  assert.ok(process.memoryUsage().arrayBuffers - before < 5 * 1024 * 1024, "the declared length was not allocated");
});

test("icns: more sub-icons than any real file has are a limit, not a giant metadata value", async () => {
  const entries: Array<readonly [string, number]> = Array.from({ length: 2000 }, () => ["ic09", 0] as const);
  await assert.rejects(parseAs("image/icns", icns(entries)), LimitExceededError);
});

test("icns: a sub-icon length that wraps the offset negative is refused (Tika: ArrayIndexOutOfBounds)", async () => {
  const bytes = Uint8Array.from([
    ...ascii("icns"), ...be32(8 + 8 + 12),
    ...ascii("ic09"), ...be32(8),
    ...ascii("ic09"), ...be32(0x7fffffff), 0, 0, 0, 0,
  ]);
  await assert.rejects(parseAs("image/icns", bytes), MalformedDocumentError);
});

test("icns: every prefix parses or is refused as malformed or a limit", async () => {
  const full = icns([["is32", 20], ["s8mk", 20], ["ic10", 20]]);
  for (let length = 0; length <= full.length; length++) {
    try {
      await parseAs("image/icns", full.slice(0, length));
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix ${length}: ${String(error)}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------- ICO / CUR

function bmpImage(width: number, height: number, bitCount: number): number[] {
  // A BITMAPINFOHEADER; the height covers the XOR bitmap and the AND mask. 60 bytes of "pixels" follow.
  return [
    ...le32(40), ...le32(width), ...le32(height * 2), ...le16(1), ...le16(bitCount),
    ...new Array<number>(24).fill(0), ...new Array<number>(60).fill(0),
  ];
}

function pngImage(width: number, height: number, bitDepth: number, colorType: number): number[] {
  return [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii("IHDR"),
    ...be32(width), ...be32(height), bitDepth, colorType, 0, 0, 0, ...new Array<number>(100).fill(0),
  ];
}

interface IcoImage {
  readonly data: number[];
  readonly width: number;
  readonly height: number;
  /** An icon's directory bit count. */
  readonly bits?: number;
  /** A cursor's hotspot. */
  readonly hotspot?: readonly [number, number];
}

function ico(images: readonly IcoImage[], cursor = false): Uint8Array {
  let offset = 6 + images.length * 16;
  const entries: number[] = [];
  const bodies: number[] = [];
  for (const image of images) {
    const [hx, hy] = image.hotspot ?? [0, 0];
    entries.push(
      image.width >= 256 ? 0 : image.width,
      image.height >= 256 ? 0 : image.height,
      0, 0,
      ...(cursor ? [...le16(hx), ...le16(hy)] : [...le16(1), ...le16(image.bits ?? 0)]),
      ...le32(image.data.length), ...le32(offset),
    );
    bodies.push(...image.data);
    offset += image.data.length;
  }
  return Uint8Array.from([0, 0, cursor ? 2 : 1, 0, ...le16(images.length), ...entries, ...bodies]);
}

/** Tika's testICO.ico: 16 and 32 px BMPs and a 256 px PNG, all 32 bpp. */
const ICON = ico([
  { data: bmpImage(16, 16, 32), width: 16, height: 16, bits: 32 },
  { data: bmpImage(32, 32, 32), width: 32, height: 32, bits: 32 },
  { data: pngImage(256, 256, 8, 6), width: 256, height: 256, bits: 32 },
]);
/** Tika's testICO_bmpOnly.ico: 16 and 48 px BMPs. */
const BMP_ONLY = ico([
  { data: bmpImage(16, 16, 32), width: 16, height: 16, bits: 32 },
  { data: bmpImage(48, 48, 32), width: 48, height: 48, bits: 32 },
]);
/** Tika's testCUR.cur: 16 px (hotspot 3,2) and 32 px (hotspot 7,5). */
const CURSOR = ico(
  [
    { data: bmpImage(16, 16, 32), width: 16, height: 16, hotspot: [3, 2] },
    { data: bmpImage(32, 32, 32), width: 32, height: 32, hotspot: [7, 5] },
  ],
  true,
);

/** Where the image with the given index starts, as its directory entry says. */
function imageOffset(file: Uint8Array, index: number): number {
  return new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(6 + index * 16 + 12, true);
}

const ICO_TYPE = "image/vnd.microsoft.icon";
const warnings = (metadata: Metadata): string => metadata.getAll("tk:exception:warn").join("\n");

test("ico: the largest image sets the size, every image is listed, depth is bits per sample and samples", async () => {
  const metadata = await parseAs(ICO_TYPE, ICON);
  assert.equal(metadata.get("Content-Type"), ICO_TYPE);
  // The 256 px entry is stored as 0x0 in the directory; the size comes from the PNG header.
  assert.equal(metadata.get("tiff:ImageWidth"), "256");
  assert.equal(metadata.get("tiff:ImageLength"), "256");
  assert.equal(metadata.get("tiff:BitsPerSample"), "8");
  assert.equal(metadata.get("tiff:SamplesPerPixel"), "4");
  assert.equal(metadata.get("icon:image-count"), "3");
  assert.deepEqual(metadata.getAll("icon:images"), ["16x16@32bpp bmp", "32x32@32bpp bmp", "256x256@32bpp png"]);
  assert.equal(metadata.get("icon:hotspot-x"), null);
  assert.equal(metadata.get("tk:exception:warn"), null);
});

test("ico: bmp-only icon, and the alias image/x-icon routes the same", async () => {
  const metadata = await parseAs("image/x-icon", BMP_ONLY);
  assert.equal(metadata.get("tiff:ImageWidth"), "48");
  assert.equal(metadata.get("icon:image-count"), "2");
  assert.deepEqual(metadata.getAll("icon:images"), ["16x16@32bpp bmp", "48x48@32bpp bmp"]);
});

test("cur: the type becomes image/x-win-bitmap, with the hotspot of the largest image", async () => {
  const metadata = await parseAs("image/x-win-bitmap", CURSOR);
  assert.equal(metadata.get("Content-Type"), "image/x-win-bitmap");
  assert.equal(metadata.get("tiff:ImageWidth"), "32");
  assert.equal(metadata.get("tiff:BitsPerSample"), "8");
  assert.equal(metadata.get("tiff:SamplesPerPixel"), "4");
  assert.equal(metadata.get("icon:hotspot-x"), "7");
  assert.equal(metadata.get("icon:hotspot-y"), "5");
  assert.deepEqual(metadata.getAll("icon:images"), ["16x16@32bpp bmp", "32x32@32bpp bmp"]);
});

test("ico: the type in the header, not the one passed in, decides icon or cursor (Tika rewrites Content-Type)", async () => {
  assert.equal((await parseAs(ICO_TYPE, CURSOR)).get("Content-Type"), "image/x-win-bitmap");
  assert.equal((await parseAs("image/x-win-bitmap", ICON)).get("Content-Type"), ICO_TYPE);
});

test("cur: a cut image header leaves the hotspot but no colour depth", async () => {
  const cut = CURSOR.slice(0, imageOffset(CURSOR, 1) + 10);
  const metadata = await parseAs("image/x-win-bitmap", cut);
  assert.equal(metadata.get("tiff:ImageWidth"), "32");
  assert.equal(metadata.get("tiff:BitsPerSample"), null);
  assert.equal(metadata.get("icon:hotspot-x"), "7");
  assert.equal(metadata.get("icon:hotspot-y"), "5");
  assert.deepEqual(metadata.getAll("icon:images"), ["16x16@32bpp bmp", "32x32 unknown"]);
  assert.match(warnings(metadata), /1 of 2 images/);
});

test("ico: a truncated file reports what survives and warns about the rest", async () => {
  // The third image, the PNG, is cut, but its 29 byte header survives, and headers are all that is read.
  let metadata = await parseAs(ICO_TYPE, ICON.slice(0, imageOffset(ICON, 2) + 100));
  assert.equal(metadata.get("tiff:ImageWidth"), "256");
  assert.equal(metadata.get("icon:image-count"), "3");
  assert.equal(metadata.get("tk:exception:warn"), null);

  // The second image's header is cut: its directory entry still says 32x32, and the third lies beyond the end.
  metadata = await parseAs(ICO_TYPE, ICON.slice(0, imageOffset(ICON, 1) + 10));
  assert.equal(metadata.get("tiff:ImageWidth"), "32");
  assert.deepEqual(metadata.getAll("icon:images"), ["16x16@32bpp bmp", "32x32@32bpp unknown"]);
  assert.equal(metadata.get("tiff:BitsPerSample"), "8");
  assert.match(warnings(metadata), /2 of 3 images/);
  assert.equal(metadata.get("icon:image-count"), "2");

  // Cut inside the directory itself.
  metadata = await parseAs(ICO_TYPE, ICON.slice(0, 30));
  assert.equal(metadata.get("tiff:ImageWidth"), null);
  assert.equal(metadata.get("icon:image-count"), "0");
  assert.match(warnings(metadata), /3 of 3 images/);
});

test("ico: a PNG signature without a 13 byte IHDR first chunk is no PNG header", async () => {
  const png = imageOffset(ICON, 2);
  for (const broken of [patch(ICON, png + 12, 0x58, 0x58, 0x58, 0x58), patch(ICON, png + 8, 0, 0, 0, 12)]) {
    const metadata = await parseAs(ICO_TYPE, broken);
    assert.ok(metadata.getAll("icon:images").includes("256x256@32bpp unknown"));
    assert.equal(metadata.get("tiff:ImageWidth"), "256");
    assert.match(warnings(metadata), /1 of 3 images/);
  }
});

test("ico: of two images of one size the deeper one is reported, wherever it stands", async () => {
  const header = imageOffset(BMP_ONLY, 0);
  const sameSize = patch(patch(patch(BMP_ONLY, header + 4, 48), header + 8, 96), header + 14, 24);
  const metadata = await parseAs(ICO_TYPE, sameSize);
  assert.deepEqual(metadata.getAll("icon:images"), ["48x48@24bpp bmp", "48x48@32bpp bmp"]);
  assert.equal(metadata.get("tiff:SamplesPerPixel"), "4");
});

test("ico: an image whose data lies outside the file is not listed", async () => {
  const metadata = await parseAs(ICO_TYPE, patch(ICON, 6 + 2 * 16 + 12, 0xff, 0xff, 0, 0));
  assert.equal(metadata.get("tiff:ImageWidth"), "32");
  assert.deepEqual(metadata.getAll("icon:images"), ["16x16@32bpp bmp", "32x32@32bpp bmp"]);
  assert.match(warnings(metadata), /1 of 3 images/);
});

test("ico: an OS/2 bitmap array is not an icon", async () => {
  const bitmapArray = new Uint8Array(64);
  bitmapArray.set([0x42, 0x41, 0x28], 0);
  await assert.rejects(parseAs(ICO_TYPE, bitmapArray), MalformedDocumentError);
});

test("ico: a width or height that is zero, negative or beyond any icon falls back to the directory", async () => {
  const bmpWidth = imageOffset(ICON, 0) + 4;
  const bmpHeight = imageOffset(ICON, 0) + 8;
  const pngWidth = imageOffset(ICON, 2) + 16;
  const pngHeight = imageOffset(ICON, 2) + 20;
  const fallsBack = async (file: Uint8Array, expected: string): Promise<void> => {
    const metadata = await parseAs(ICO_TYPE, file);
    assert.ok(metadata.getAll("icon:images").includes(expected), `${expected} in ${metadata.getAll("icon:images").join("|")}`);
    assert.equal(metadata.get("tiff:ImageWidth"), "256");
    assert.equal(metadata.get("tiff:ImageLength"), "256");
    assert.match(warnings(metadata), /1 of 3 images/);
  };
  // Little endian -1, Integer.MIN_VALUE and zero.
  await fallsBack(patch(ICON, bmpWidth, 0xff, 0xff, 0xff, 0xff), "16x16@32bpp unknown");
  await fallsBack(patch(ICON, bmpWidth, 0, 0, 0, 0x80), "16x16@32bpp unknown");
  await fallsBack(patch(ICON, bmpHeight, 0, 0, 0, 0), "16x16@32bpp unknown");
  await fallsBack(patch(ICON, bmpHeight, 0, 0, 0, 0x80), "16x16@32bpp unknown");
  // Big endian Integer.MIN_VALUE, Integer.MAX_VALUE, 0xffffffff, zero and one past the largest size believed.
  await fallsBack(patch(ICON, pngWidth, 0x80, 0, 0, 0), "256x256@32bpp unknown");
  await fallsBack(patch(ICON, pngHeight, 0x80, 0, 0, 0), "256x256@32bpp unknown");
  await fallsBack(patch(ICON, pngHeight, 0, 0, 0, 0), "256x256@32bpp unknown");
  await fallsBack(patch(ICON, pngWidth, 0x7f, 0xff, 0xff, 0xff), "256x256@32bpp unknown");
  await fallsBack(patch(ICON, pngWidth, 0xff, 0xff, 0xff, 0xff), "256x256@32bpp unknown");
  await fallsBack(patch(ICON, pngWidth, 0, 1, 0, 0), "256x256@32bpp unknown");
  // Two negative dimensions have a positive product, which must not win.
  await fallsBack(patch(patch(ICON, pngWidth, 0x80, 0, 0, 0), pngHeight, 0x80, 0, 0, 0), "256x256@32bpp unknown");
});

test("ico: colour depths are split into bits per sample and samples per pixel", async () => {
  const bitCount = imageOffset(BMP_ONLY, 1) + 14;
  const depth = async (file: Uint8Array, image: string, bitsPerSample: string, samples: string): Promise<void> => {
    const metadata = await parseAs(ICO_TYPE, file);
    assert.ok(metadata.getAll("icon:images").includes(image), `${image} in ${metadata.getAll("icon:images").join("|")}`);
    assert.equal(metadata.get("tiff:BitsPerSample"), bitsPerSample);
    assert.equal(metadata.get("tiff:SamplesPerPixel"), samples);
  };
  await depth(patch(BMP_ONLY, bitCount, 24, 0), "48x48@24bpp bmp", "8", "3");
  await depth(patch(BMP_ONLY, bitCount, 16, 0), "48x48@16bpp bmp", "5", "3");
  await depth(patch(BMP_ONLY, bitCount, 8, 0), "48x48@8bpp bmp", "8", "1");
  await depth(patch(BMP_ONLY, bitCount, 1, 0), "48x48@1bpp bmp", "1", "1");

  const bitDepth = imageOffset(ICON, 2) + 24;
  await depth(patch(ICON, bitDepth, 8, 2), "256x256@24bpp png", "8", "3");
  await depth(patch(ICON, bitDepth, 8, 4), "256x256@16bpp png", "8", "2");
  await depth(patch(ICON, bitDepth, 8, 3), "256x256@8bpp png", "8", "1");
  await depth(patch(ICON, bitDepth, 16, 6), "256x256@64bpp png", "16", "4");

  // A depth no DIB or PNG can have is ignored: the directory's 32 bpp stands in.
  await depth(patch(BMP_ONLY, bitCount, 0xff, 0xff), "48x48@32bpp bmp", "8", "4");
  await depth(patch(BMP_ONLY, bitCount, 7, 0), "48x48@32bpp bmp", "8", "4");
  await depth(patch(ICON, bitDepth, 0xff, 6), "256x256@32bpp png", "8", "4");
  await depth(patch(ICON, bitDepth, 8, 5), "256x256@32bpp png", "8", "4");
  // A PNG bit depth is 1, 2, 4, 8 or 16: 0, 3, 5, 6, 12 and 17 are none of them.
  for (const odd of [0, 3, 5, 6, 12, 17]) {
    await depth(patch(ICON, bitDepth, odd, 6), "256x256@32bpp png", "8", "4");
  }
  // The directory's own bit count is no more trusted: the 32 px image is cut and has no other.
  const cut = patch(ICON, 6 + 16 + 6, 0xff, 0xff).slice(0, imageOffset(ICON, 1) + 10);
  assert.ok((await parseAs(ICO_TYPE, cut)).getAll("icon:images").includes("32x32 unknown"));
});

test("ico: an empty directory, a header cut before the count, and a non-icon", async () => {
  const empty = await parseAs(ICO_TYPE, Uint8Array.from([0, 0, 1, 0, 0, 0]));
  assert.equal(empty.get("Content-Type"), ICO_TYPE);
  assert.equal(empty.get("icon:image-count"), "0");
  assert.match(warnings(empty), /no images/);

  for (const header of [[0, 0, 2, 0], [0, 0, 2, 0, 1]]) {
    const metadata = await parseAs(ICO_TYPE, Uint8Array.from(header));
    assert.equal(metadata.get("Content-Type"), "image/x-win-bitmap");
    assert.equal(metadata.get("icon:image-count"), null);
    assert.match(warnings(metadata), /image count/);
  }

  await assert.rejects(parseAs(ICO_TYPE, Uint8Array.from([0, 0, 3, 0, 1, 0])), MalformedDocumentError);
  await assert.rejects(parseAs(ICO_TYPE, Uint8Array.from([1, 2, 3])), MalformedDocumentError);
  await assert.rejects(parseAs(ICO_TYPE, new Uint8Array(0)), MalformedDocumentError);
});

test("ico: an image whose header lies beyond 16 MiB is as unreadable as one beyond the end of the file", async () => {
  const limit = 16 * 1024 * 1024;
  const large = new Uint8Array(limit + 64);
  large.set(ICON.subarray(0, imageOffset(ICON, 2)));
  large.set(ICON.subarray(imageOffset(ICON, 2), imageOffset(ICON, 2) + 29), limit);
  large.set(le32(limit), 6 + 2 * 16 + 12);
  const metadata = await parseAs(ICO_TYPE, large);
  assert.equal(metadata.get("tiff:ImageWidth"), "32");
  assert.deepEqual(metadata.getAll("icon:images"), ["16x16@32bpp bmp", "32x32@32bpp bmp"]);
  assert.match(warnings(metadata), /1 of 3 images/);
});

test("ico: a hostile image count and sizes are bounded by the bytes present", async () => {
  // 65535 images claimed, one present: it is read, every other claim is warned about, none is allocated.
  const one = ico([{ data: bmpImage(16, 16, 32), width: 16, height: 16, bits: 32 }]);
  const metadata = await parseAs(ICO_TYPE, patch(one, 4, 0xff, 0xff));
  assert.equal(metadata.get("icon:image-count"), "1");
  assert.match(warnings(metadata), /65534 of 65535 images/);
  // A directory entry whose size claims 4 GiB reads only what the file holds.
  const huge = patch(ICON, 6 + 8, 0xff, 0xff, 0xff, 0xff);
  assert.equal((await parseAs(ICO_TYPE, huge)).get("tiff:ImageWidth"), "256");
});

test("ico: every prefix parses or is refused as malformed", async () => {
  await assertPrefixesSafe(ICO_TYPE, ICON.slice(0, 150), "icon");
  await assertPrefixesSafe("image/x-win-bitmap", CURSOR.slice(0, 150), "cursor");
});

// ---------------------------------------------------------------------------------------------------- WBMP

/** Type 0, fixed header 0, then width and height as WBMP multi-byte integers, then bitmap rows. */
const wbmp = (width: number[], height: number[], rows = 4): Uint8Array =>
  Uint8Array.from([0, 0, ...width, ...height, ...new Array<number>(rows).fill(0)]);

const WBMP = "image/vnd.wap.wbmp";

test("wbmp: width and height as multi-byte integers, written under the keys ImageParser writes", async () => {
  // 300 = 0b10_0101100 -> 0x82 0x2c
  const metadata = await parseAs(WBMP, wbmp([0x82, 0x2c], [0x05]));
  assert.equal(metadata.get("Content-Type"), WBMP);
  assert.equal(metadata.get("tiff:ImageWidth"), "300");
  assert.equal(metadata.get("tiff:ImageLength"), "5");
  assert.equal(metadata.get("img:width"), "300");
  assert.equal(metadata.get("img:height"), "5");
  assert.equal(metadata.get("tk:num-images"), "1");
});

test("wbmp: a nonzero type or fixed header field is refused", async () => {
  await assert.rejects(parseAs(WBMP, Uint8Array.from([1, 0, 8, 8, 0])), MalformedDocumentError);
  await assert.rejects(parseAs(WBMP, Uint8Array.from([0, 1, 8, 8, 0])), MalformedDocumentError);
  await assert.rejects(parseAs(WBMP, new Uint8Array(0)), MalformedDocumentError);
});

test("wbmp: a multi-byte integer cut short is refused", async () => {
  await assert.rejects(parseAs(WBMP, Uint8Array.from([0, 0, 0x82])), MalformedDocumentError);
  await assert.rejects(parseAs(WBMP, Uint8Array.from([0, 0, 0x08])), MalformedDocumentError);
  await assert.rejects(parseAs(WBMP, Uint8Array.from([0, 0, 0x08, 0x80, 0x80])), MalformedDocumentError);
});

test("wbmp: 2^31-1 is reported without allocating, 2^31 and anything longer than 5 bytes are refused", async () => {
  const max = await parseAs(WBMP, wbmp([0x87, 0xff, 0xff, 0xff, 0x7f], [0x01]));
  assert.equal(max.get("tiff:ImageWidth"), "2147483647");
  // 2^31 wraps to Integer.MIN_VALUE in the reader's int arithmetic.
  await assert.rejects(parseAs(WBMP, wbmp([0x88, 0x80, 0x80, 0x80, 0x00], [0x01])), MalformedDocumentError);
  await assert.rejects(parseAs(WBMP, wbmp([0xff, 0xff, 0xff, 0xff, 0x7f], [0x01])), MalformedDocumentError);
  await assert.rejects(parseAs(WBMP, wbmp(new Array<number>(70).fill(0xff), [0x01])), MalformedDocumentError);
  // Six bytes of which the first five add no bits still hold the value 1: a width no real encoder writes.
  await assert.rejects(parseAs(WBMP, wbmp([0x80, 0x80, 0x80, 0x80, 0x80, 0x01], [0x01])), MalformedDocumentError);
  const five = await parseAs(WBMP, wbmp([0x80, 0x80, 0x80, 0x80, 0x01], [0x01]));
  assert.equal(five.get("tiff:ImageWidth"), "1");
});

test("wbmp: every prefix parses or is refused as malformed", async () => {
  await assertPrefixesSafe(WBMP, wbmp([0x82, 0x2c], [0x85, 0x01]), "wbmp");
});

// ---------------------------------------------------------------------------------------------------- PPM

const PPM = "image/x-portable-pixmap";
const text = (value: string): Uint8Array => Uint8Array.from(ascii(value));

test("ppm: P6 and P3 headers, with comments and any whitespace between the numbers", async () => {
  for (const header of ["P6\n3 2\n255\n", "P3\n3 2\n255\n", "P6 3 2 255 ", "P6\r\n# made by hand\n3\n# a second comment\n2\n255\n"]) {
    const metadata = await parseAs(PPM, text(`${header}\u0000\u0000\u0000`));
    assert.equal(metadata.get("tiff:ImageWidth"), "3", header);
    assert.equal(metadata.get("tiff:ImageLength"), "2", header);
    assert.equal(metadata.get("img:width"), "3", header);
    assert.equal(metadata.get("img:height"), "2", header);
    assert.equal(metadata.get("tk:num-images"), "1", header);
    assert.equal(metadata.get("Content-Type"), PPM);
  }
});

test("ppm: a wrong magic, a missing number or a zero size is refused", async () => {
  for (const bad of ["P7\n3 2\n255\n", "X6\n3 2\n255\n", "P6\n3\n", "P6\n", "P6\n0 2\n255\n", "P6\n3 0\n255\n", "P6\nthree 2\n255\n", ""]) {
    await assert.rejects(parseAs(PPM, text(bad)), MalformedDocumentError, JSON.stringify(bad));
  }
});

test("ppm: a size beyond int32, or a number of absurd length, is refused without allocating", async () => {
  await assert.rejects(parseAs(PPM, text("P6\n2147483648 1\n255\n")), MalformedDocumentError);
  await assert.rejects(parseAs(PPM, text("P6\n1 4294967296\n255\n")), MalformedDocumentError);
  await assert.rejects(parseAs(PPM, text(`P6\n${"9".repeat(500)} 1\n255\n`)), MalformedDocumentError);
  // Leading zeros keep the value small, but a number is at most 10 digits.
  await assert.rejects(parseAs(PPM, text("P6\n00000000001 1\n255\n")), MalformedDocumentError);
  const max = await parseAs(PPM, text("P6\n2147483647 2147483647\n255\n"));
  assert.equal(max.get("tiff:ImageWidth"), "2147483647");
  assert.equal(max.get("tiff:ImageLength"), "2147483647");
});

test("ppm: a number that is cut off, or runs into a letter, is not believed", async () => {
  // The header ends on "4" with nothing after it: it may have been "4096".
  await assert.rejects(parseAs(PPM, text("P6 3 4")), MalformedDocumentError);
  await assert.rejects(parseAs(PPM, text("P6 3x 4 255 ")), MalformedDocumentError);
  await assert.rejects(parseAs(PPM, text("P6 3 4x 255 ")), MalformedDocumentError);
});

test("ppm: a comment that never ends before the size is refused, not scanned without bound", async () => {
  await assert.rejects(parseAs(PPM, Uint8Array.from([...ascii("P6\n#"), ...new Array<number>(100_000).fill(0x61)])), MalformedDocumentError);
});

test("ppm: every prefix parses or is refused as malformed", async () => {
  await assertPrefixesSafe(PPM, text("P6\n# c\n30 20\n255\n\u0001\u0002\u0003"), "ppm");
});

// ---------------------------------------------------------------------------------------------------- JBIG2

const JBIG2 = "image/x-jbig2";
const JBIG2_ID = [0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a];

interface Jbig2Segment {
  readonly number: number;
  readonly type: number;
  readonly data: number[];
  /** Segment numbers this one refers to. */
  readonly refers?: readonly number[];
  readonly longAssociation?: boolean;
  readonly dataLength?: number;
}

function segmentHeader(segment: Jbig2Segment): number[] {
  const refers = segment.refers ?? [];
  const count = refers.length <= 4
    ? [(refers.length << 5) & 0xe0]
    : [...be32(0xe0000000 + refers.length), ...new Array<number>(Math.ceil((refers.length + 1) / 8)).fill(0)];
  const referenceSize = segment.number <= 256 ? 1 : segment.number <= 65536 ? 2 : 4;
  const referenceBytes = refers.flatMap((reference) => (referenceSize === 1 ? [reference] : referenceSize === 2 ? [reference >> 8, reference & 255] : be32(reference)));
  const association = segment.longAssociation === true ? [...be32(1)] : [1];
  return [
    ...be32(segment.number),
    segment.type | (segment.longAssociation === true ? 0x40 : 0),
    ...count,
    ...referenceBytes,
    ...association,
    ...be32(segment.dataLength ?? segment.data.length),
  ];
}

/** A file header with a known page count, then each segment's header and data in turn. */
function jbig2Sequential(segments: readonly Jbig2Segment[], pages: number | null = 1): Uint8Array {
  return Uint8Array.from([
    ...JBIG2_ID,
    0x01 | (pages === null ? 0x02 : 0),
    ...(pages === null ? [] : be32(pages)),
    ...segments.flatMap((segment) => [...segmentHeader(segment), ...segment.data]),
  ]);
}

/** Random-access organisation: every header (ending with the end-of-file segment), then every segment's data. */
function jbig2RandomAccess(segments: readonly Jbig2Segment[], pages = 1): Uint8Array {
  const end: Jbig2Segment = { number: 99, type: 51, data: [] };
  return Uint8Array.from([
    ...JBIG2_ID,
    0x00,
    ...be32(pages),
    ...[...segments, end].flatMap(segmentHeader),
    ...segments.flatMap((segment) => segment.data),
  ]);
}

function pageInfo(width: number, height: number): number[] {
  // width, height, x and y resolution, flags, striping
  return [...be32(width), ...be32(height), ...be32(0), ...be32(0), 0, 0, 0];
}

const SYMBOLS: Jbig2Segment = { number: 0, type: 0, data: new Array<number>(20).fill(0) };

test("jbig2: the size comes from the first page information segment, after segments it skips by length", async () => {
  const bytes = jbig2Sequential([SYMBOLS, { number: 1, type: 48, data: pageInfo(328, 78) }, { number: 2, type: 49, data: [] }]);
  const metadata = await parseAs(JBIG2, bytes);
  assert.equal(metadata.get("Content-Type"), JBIG2);
  assert.equal(metadata.get("tiff:ImageWidth"), "328");
  assert.equal(metadata.get("tiff:ImageLength"), "78");
  assert.equal(metadata.get("img:width"), "328");
  assert.equal(metadata.get("img:height"), "78");
  assert.equal(metadata.get("tk:num-images"), "1");
});

test("jbig2: segments with referred-to segments, in the short and the long form, are skipped correctly", async () => {
  const text: Jbig2Segment = { number: 1, type: 6, data: [1, 2, 3], refers: [0] };
  const manyReferences: Jbig2Segment = { number: 2, type: 6, data: [4, 5], refers: [0, 0, 0, 0, 0, 1] };
  const wide: Jbig2Segment = { number: 300, type: 6, data: [6], refers: [0, 1], longAssociation: true };
  const bytes = jbig2Sequential([SYMBOLS, text, manyReferences, wide, { number: 301, type: 48, data: pageInfo(640, 480) }]);
  const metadata = await parseAs(JBIG2, bytes);
  assert.equal(metadata.get("tiff:ImageWidth"), "640");
  assert.equal(metadata.get("tiff:ImageLength"), "480");
});

test("jbig2: the long form's retain bits are ceil((count + 1) / 8) bytes, so 8 references take 2", async () => {
  // 8 and 16 references are where one byte too few would still look right for 7 and 15.
  for (const count of [5, 7, 8, 15, 16]) {
    const references = Array.from({ length: count }, () => 0);
    const bytes = jbig2Sequential([SYMBOLS, { number: 1, type: 6, data: [1], refers: references }, { number: 2, type: 48, data: pageInfo(77, 55) }]);
    const metadata = await parseAs(JBIG2, bytes);
    assert.equal(metadata.get("tiff:ImageWidth"), "77", `${count} references`);
    assert.equal(metadata.get("tiff:ImageLength"), "55", `${count} references`);
  }
});

test("jbig2: the random-access organisation finds the page information after the headers", async () => {
  const bytes = jbig2RandomAccess([SYMBOLS, { number: 1, type: 48, data: pageInfo(200, 100) }], 1);
  const metadata = await parseAs(JBIG2, bytes);
  assert.equal(metadata.get("tiff:ImageWidth"), "200");
  assert.equal(metadata.get("tiff:ImageLength"), "100");
});

test("jbig2: the page count is written only when the file header declares it", async () => {
  const unknown = await parseAs(JBIG2, jbig2Sequential([{ number: 0, type: 48, data: pageInfo(8, 8) }], null));
  assert.equal(unknown.get("tiff:ImageWidth"), "8");
  assert.equal(unknown.get("tk:num-images"), null);
  const three = await parseAs(JBIG2, jbig2Sequential([{ number: 0, type: 48, data: pageInfo(8, 8) }], 3));
  assert.equal(three.get("tk:num-images"), "3");
});

test("jbig2: a page of unknown height (striped) is typed but not measured", async () => {
  const metadata = await parseAs(JBIG2, jbig2Sequential([{ number: 0, type: 48, data: pageInfo(8, 0xffffffff) }]));
  assert.equal(metadata.get("Content-Type"), JBIG2);
  assert.equal(metadata.get("tiff:ImageWidth"), null);
});

test("jbig2: no signature, no page information, or a size of zero or beyond int32 is refused", async () => {
  await assert.rejects(parseAs(JBIG2, Uint8Array.from([...JBIG2_ID.slice(0, 7), 0, 1, ...be32(1)])), MalformedDocumentError);
  await assert.rejects(parseAs(JBIG2, jbig2Sequential([SYMBOLS])), MalformedDocumentError);
  for (const [width, height] of [[0, 8], [8, 0], [0x80000000, 8], [8, 0x80000000], [0xffffffff, 8]] as const) {
    await assert.rejects(parseAs(JBIG2, jbig2Sequential([{ number: 0, type: 48, data: pageInfo(width, height) }])), MalformedDocumentError, `${width}x${height}`);
  }
  await assert.rejects(parseAs(JBIG2, jbig2Sequential([{ number: 0, type: 48, data: [0, 0, 0, 8] }])), MalformedDocumentError);
});

test("jbig2: a segment claiming 4 GiB of data is skipped past the end, not read", async () => {
  const claims: Jbig2Segment = { number: 0, type: 0, data: [], dataLength: 0xfffffff0 };
  await assert.rejects(parseAs(JBIG2, jbig2Sequential([claims, { number: 1, type: 48, data: pageInfo(8, 8) }])), MalformedDocumentError);
  // 0xffffffff means unknown length, which only an immediate generic region may have; it cannot be skipped.
  const unknownLength: Jbig2Segment = { number: 0, type: 38, data: [], dataLength: 0xffffffff };
  await assert.rejects(parseAs(JBIG2, jbig2Sequential([unknownLength, { number: 1, type: 48, data: pageInfo(8, 8) }])), MalformedDocumentError);
});

test("jbig2: a chain of tiny segments ahead of any page information is a limit", async () => {
  const segments: Jbig2Segment[] = Array.from({ length: 5000 }, (_, number) => ({ number, type: 49, data: [] }));
  await assert.rejects(parseAs(JBIG2, jbig2Sequential(segments)), LimitExceededError);
});

test("jbig2: every prefix parses or is refused as malformed", async () => {
  await assertPrefixesSafe(JBIG2, jbig2Sequential([SYMBOLS, { number: 1, type: 6, data: [1, 2], refers: [0] }, { number: 2, type: 48, data: pageInfo(64, 32) }]), "jbig2");
  await assertPrefixesSafe(JBIG2, jbig2RandomAccess([SYMBOLS, { number: 1, type: 48, data: pageInfo(64, 32) }]), "jbig2 random");
});

// ---------------------------------------------------------------------------------------------------- XCF

test("xcf: Tika's ImageParser has no reader for it and writes nothing but the type, so nothing is read", async () => {
  let pulled = 0;
  const hostile = (async function* (): AsyncGenerator<Uint8Array> {
    for (;;) {
      pulled++;
      // A parser that reads on would never return: stop it instead of hanging the run.
      if (pulled > 1000) throw new Error("the stream was read past 64 MiB");
      yield new Uint8Array(65536);
    }
  })();
  const stream = await RipstreamInputStream.from(hostile);
  const metadata = new Metadata();
  metadata.set("Content-Type", "image/x-xcf");
  try {
    await new ImageParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  assert.equal(pulled, 0, "the stream was not read");
  assert.deepEqual(metadata.toObject(), { "Content-Type": "image/x-xcf" });
});

test("xcf: a real GIMP header is not interpreted either", async () => {
  const header = Uint8Array.from([...ascii("gimp xcf v011"), 0, ...be32(8), ...be32(8), ...be32(0)]);
  assert.deepEqual((await parseAs("image/x-xcf", header)).toObject(), { "Content-Type": "image/x-xcf" });
});

test("BMP with a 12-byte OS/2 core header reads 16-bit dimensions", async () => {
  const bytes = new Uint8Array([
    ...ascii("BM"), ...le32(26), ...le16(0), ...le16(0), ...le32(0),
    ...le32(12), ...le16(10), ...le16(20), ...le16(1), ...le16(24),
  ]);
  const metadata = await parseAs("image/bmp", bytes);
  assert.equal(metadata.get("tiff:ImageWidth"), "10");
  assert.equal(metadata.get("tiff:ImageLength"), "20");
});

test("PNG width above 2^31 writes no dimensions, as Java ImageIO fails on it", async () => {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), ...ascii("IHDR"), ...be32(0x8000_0001), ...be32(10),
  ]);
  const metadata = await parseAs("image/png", bytes);
  assert.equal(metadata.get("tiff:ImageWidth"), null);
});
