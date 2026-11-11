import { MalformedDocumentError, type Metadata, type RipstreamInputStream } from "@spikedpunch/ripstream-core";

const ICO_TYPE = "image/vnd.microsoft.icon";
const CUR_TYPE = "image/x-win-bitmap";

const TYPE_ICON = 1;
const TYPE_CURSOR = 2;
const COUNT_OFFSET = 4;
const HEADER_SIZE = 6;
const ENTRY_SIZE = 16;
const BITMAP_INFO_HEADER_SIZE = 40;
/** The signature, then the first chunk's length and type: an IHDR of 13 bytes. */
const PNG_HEADER_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const PNG_IHDR_SIZE = 8 + 8 + 13;
/** ICOParser.MAX_FILE_SIZE: icons are small, and anything bigger is read only this far. */
const MAX_FILE_SIZE = 16 * 1024 * 1024;
/** ICOParser.MAX_DIMENSION: far beyond any real icon; a header that claims more is not believed. */
const MAX_DIMENSION = 65535;

type Encoding = "png" | "bmp" | "unknown";

interface IcoImage {
  width: number;
  height: number;
  bitsPerPixel: number;
  bitsPerSample: number;
  samplesPerPixel: number;
  hotspotX: number;
  hotspotY: number;
  encoding: Encoding;
}

/**
 * Windows icon (ICO) and cursor (CUR), read as Tika 4.2.0's ICOParser reads it: the directory and the header of every
 * image, never the pixels. The directory's own width, height and colour fields are unreliable, so the values come from
 * each image's PNG IHDR or BITMAPINFOHEADER and the directory is only the fallback. The largest image sets the size
 * and the colour depth; every image is listed; a cursor's hotspot is that of the largest. The type is rewritten to
 * the one the header names (`image/x-win-bitmap` for a cursor), as Tika does.
 *
 * Differences: Tika puts a Java stack trace in `tk:exception:warn`, this a `MalformedDocumentError: message` line.
 */
export async function readIco(stream: RipstreamInputStream, metadata: Metadata): Promise<void> {
  // At most 16 MiB, and only the bytes the stream has: a header that claims more allocates nothing.
  const file = await stream.peek(MAX_FILE_SIZE);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (file.length < COUNT_OFFSET || view.getUint16(0, true) !== 0) {
    throw new MalformedDocumentError("Not an ICO or CUR file");
  }
  const type = view.getUint16(2, true);
  if (type !== TYPE_ICON && type !== TYPE_CURSOR) {
    throw new MalformedDocumentError(`Not an ICO or CUR file: type ${type}`);
  }
  const cursor = type === TYPE_CURSOR;
  metadata.set("Content-Type", cursor ? CUR_TYPE : ICO_TYPE);
  if (file.length < HEADER_SIZE) {
    warn(metadata, "The header ends before the image count");
    return;
  }

  const count = view.getUint16(COUNT_OFFSET, true);
  if (count === 0) {
    metadata.set("icon:image-count", 0);
    warn(metadata, "The directory lists no images");
    return;
  }
  let largest: IcoImage | null = null;
  let listed = 0;
  let unreadable = 0;
  for (let i = 0; i < count; i++) {
    const entryOffset = HEADER_SIZE + i * ENTRY_SIZE;
    if (entryOffset + ENTRY_SIZE > file.length) {
      unreadable += count - i;
      break;
    }
    const image = readImage(file, view, entryOffset, cursor);
    if (image === null) {
      unreadable++;
      continue;
    }
    // Still listed with what the directory says, but worth a warning.
    if (image.encoding === "unknown") unreadable++;
    metadata.add("icon:images", describe(image));
    listed++;
    if (largest === null || outranks(image, largest)) largest = image;
  }
  // What the header claims beyond that is in the warning.
  metadata.set("icon:image-count", listed);
  if (largest !== null) {
    metadata.set("tiff:ImageWidth", largest.width);
    metadata.set("tiff:ImageLength", largest.height);
    if (largest.bitsPerSample > 0) {
      metadata.set("tiff:BitsPerSample", String(largest.bitsPerSample));
      metadata.set("tiff:SamplesPerPixel", largest.samplesPerPixel);
    }
    if (cursor) {
      metadata.set("icon:hotspot-x", largest.hotspotX);
      metadata.set("icon:hotspot-y", largest.hotspotY);
    }
  }
  if (unreadable > 0) {
    warn(metadata, `${unreadable} of ${count} images lie outside the file or have no readable header`);
  }
}

function warn(metadata: Metadata, message: string): void {
  metadata.add("tk:exception:warn", `${MalformedDocumentError.name}: ${message}`);
}

/**
 * Reads one ICONDIRENTRY and the header of the image it points to. Without a header that has a usable size, the image
 * keeps the directory's values and an unknown encoding. Null if its data lies outside the file.
 */
function readImage(file: Uint8Array, view: DataView, entryOffset: number, cursor: boolean): IcoImage | null {
  const image: IcoImage = {
    width: directorySize(file[entryOffset]!),
    height: directorySize(file[entryOffset + 1]!),
    bitsPerPixel: 0,
    bitsPerSample: 0,
    samplesPerPixel: 0,
    hotspotX: 0,
    hotspotY: 0,
    encoding: "unknown",
  };
  if (cursor) {
    // A cursor's directory holds the hotspot where an icon's holds planes and bit count.
    image.hotspotX = view.getUint16(entryOffset + 4, true);
    image.hotspotY = view.getUint16(entryOffset + 6, true);
  } else {
    setDepth(image, view.getUint16(entryOffset + 6, true));
  }
  const size = view.getUint32(entryOffset + 8, true);
  const offset = view.getUint32(entryOffset + 12, true);
  if (offset < HEADER_SIZE || offset >= file.length) return null;
  const available = Math.min(size, file.length - offset);
  if (available >= PNG_IHDR_SIZE && startsWithPngHeader(file, offset)) {
    if (trySetSize(image, view.getUint32(offset + 16), view.getUint32(offset + 20))) {
      image.encoding = "png";
      setPngDepth(image, file[offset + 24]!, file[offset + 25]!);
    }
  } else if (available >= BITMAP_INFO_HEADER_SIZE && view.getUint32(offset, true) === BITMAP_INFO_HEADER_SIZE) {
    // The height covers the XOR bitmap and the AND mask; a negative one means top-down.
    const height = Math.trunc(Math.abs(view.getInt32(offset + 8, true)) / 2);
    if (trySetSize(image, view.getInt32(offset + 4, true), height)) {
      image.encoding = "bmp";
      setDepth(image, view.getUint16(offset + 14, true));
    }
  }
  return image;
}

/** 256 px is stored as 0. */
function directorySize(size: number): number {
  return size === 0 ? 256 : size;
}

function startsWithPngHeader(file: Uint8Array, offset: number): boolean {
  return PNG_HEADER_START.every((byte, index) => file[offset + index] === byte);
}

/** False, leaving the size as it was, unless both lie between 1 and 65535. */
function trySetSize(image: IcoImage, width: number, height: number): boolean {
  if (width <= 0 || width > MAX_DIMENSION || height <= 0 || height > MAX_DIMENSION) return false;
  image.width = width;
  image.height = height;
  return true;
}

/**
 * Splits a DIB colour depth into samples: 32 and 24 bit images are 8 bits per channel, 16 bit ones 5, anything below is
 * palette or mono. A bit count no DIB has leaves the depth as it was.
 */
function setDepth(image: IcoImage, bitsPerPixel: number): void {
  switch (bitsPerPixel) {
    case 32:
    case 24:
      image.bitsPerSample = 8;
      image.samplesPerPixel = bitsPerPixel / 8;
      break;
    case 16:
      image.bitsPerSample = 5;
      image.samplesPerPixel = 3;
      break;
    case 8:
    case 4:
    case 1:
      image.bitsPerSample = bitsPerPixel;
      image.samplesPerPixel = 1;
      break;
    default:
      return;
  }
  image.bitsPerPixel = bitsPerPixel;
}

/** A bit depth or colour type PNG does not define leaves the depth as it was. */
function setPngDepth(image: IcoImage, bitDepth: number, colorType: number): void {
  const samples = pngSamplesPerPixel(colorType);
  // A PNG bit depth is 1, 2, 4, 8 or 16: a power of two up to 16.
  if (samples === 0 || bitDepth > 16 || bitDepth === 0 || (bitDepth & (bitDepth - 1)) !== 0) return;
  image.bitsPerSample = bitDepth;
  image.samplesPerPixel = samples;
  image.bitsPerPixel = bitDepth * samples;
}

/** The samples per pixel, or 0 for a colour type PNG does not define. */
function pngSamplesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0: // greyscale
    case 3: // palette
      return 1;
    case 2: // truecolour
      return 3;
    case 4: // greyscale with alpha
      return 2;
    case 6: // truecolour with alpha
      return 4;
    default:
      return 0;
  }
}

/** Larger area wins, then the higher colour depth, like Windows' own choice. */
function outranks(image: IcoImage, other: IcoImage): boolean {
  const area = image.width * image.height;
  const otherArea = other.width * other.height;
  return area > otherArea || (area === otherArea && image.bitsPerPixel > other.bitsPerPixel);
}

function describe(image: IcoImage): string {
  const depth = image.bitsPerPixel > 0 ? `@${image.bitsPerPixel}bpp` : "";
  return `${image.width}x${image.height}${depth} ${image.encoding}`;
}
