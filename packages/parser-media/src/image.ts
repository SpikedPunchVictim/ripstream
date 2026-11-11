import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  RipstreamError,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import exifr from "exifr";
import { EXIFR_OPTIONS, guardExifAmplification } from "./exif-guard.ts";
import { readIcns } from "./icns.ts";
import { readIco } from "./ico.ts";
import { readJbig2 } from "./jbig2.ts";
import { readPnm } from "./pnm.ts";
import { readWbmp } from "./wbmp.ts";
import { readGifImages } from "./gif.ts";
import { setImageReaderMetadata, type HeaderReader } from "./imageio-metadata.ts";

/**
 * The formats read from their header alone, by the type the document was detected as, as Tika picks a parser or an
 * ImageIO reader by `Content-Type`. Each reads only a bounded prefix of the stream. XCF has no reader in Tika's
 * ImageParser (the module carries no XCF reader for javax.imageio), which then writes nothing but the type, so
 * nothing is read.
 */
const HEADER_READERS: ReadonlyMap<string, HeaderReader> = new Map<string, HeaderReader>([
  ["image/icns", readIcns],
  ["image/vnd.microsoft.icon", readIco],
  ["image/x-icon", readIco],
  ["image/x-win-bitmap", readIco],
  ["image/vnd.wap.wbmp", readWbmp],
  ["image/x-jbig2", readJbig2],
  ["image/x-jb2", readJbig2],
  ["image/x-portable-pixmap", readPnm],
  ["image/x-xcf", async () => {}],
  ["image/xcf", async () => {}],
]);

/**
 * Image metadata parser. EXIF/IPTC/XMP via exifr; dimensions from PNG/GIF/JPEG
 * headers when EXIF does not carry them. No pixel decoding. ICNS, ICO/CUR, WBMP,
 * JBIG2, PPM and XCF are read from their headers alone (see HEADER_READERS).
 */
export class ImageParser implements Parser {
  readonly name = "ImageParser";
  readonly capabilities = { metadataOnly: true, unsafe: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "image/jpeg",
        "image/tiff",
        "image/png",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/x-ms-bmp",
        "image/vnd.microsoft.icon",
        "image/x-icon",
        "image/vnd.adobe.photoshop",
        "image/jp2",
        "image/jpx",
        "image/j2c",
        "image/heic",
        "image/heif",
        "image/heic-sequence",
        "image/heif-sequence",
        "image/avif",
        "image/x-canon-cr2",
        "image/x-canon-crw",
        "image/x-nikon-nef",
        "image/x-sony-arw",
        "image/x-adobe-dng",
        "image/x-olympus-orf",
        "image/x-pentax-pef",
        "image/x-fuji-raf",
        "image/x-panasonic-rw2",
        "image/icns",
        "image/x-win-bitmap",
        "image/vnd.wap.wbmp",
        "image/x-jbig2",
        "image/x-portable-pixmap",
        "image/x-xcf",
      ].map((type) => MediaType.parse(type)!),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    _handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const type = MediaType.parse(metadata.get("Content-Type"))?.getBaseType().toString();
    const readHeader = type === undefined ? undefined : HEADER_READERS.get(type);
    if (readHeader !== undefined) {
      await readHeader(stream, metadata);
      return;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // exifr's HEIF box walker can spin forever on a mid-file size-0 box, so
    // reject malformed top-level box structure before it ever sees the bytes.
    validateIsoBmffTopLevel(data);
    // exifr allocates per tag by declared value count: bound that before it runs (tikajs-e42s).
    guardExifAmplification(data);

    let exif: Record<string, unknown> | null = null;
    try {
      exif = (await exifr.parse(data, EXIFR_OPTIONS)) as Record<string, unknown> | null;
    } catch (error) {
      // Only swallow genuine library/parse failures; aborts and ripstream
      // errors (timeouts, limits) must reach the caller.
      if (isAbortError(error) || error instanceof RipstreamError) throw error;
      exif = null;
    }

    const dimensions = imageDimensions(data);
    const readerImages = imageReaderImages(data, dimensions);
    if (readerImages !== null) {
      setImageReaderMetadata(metadata, readerImages.width, readerImages.height, readerImages.count);
    } else if (dimensions !== null) {
      metadata.set("tiff:ImageWidth", dimensions.width);
      metadata.set("tiff:ImageLength", dimensions.height);
    }

    if (exif !== null && typeof exif === "object" && !Array.isArray(exif)) {
      applyExif(metadata, exif as Record<string, unknown>);
    }

    const comments = jpegComments(data);
    for (const comment of comments) metadata.add("comments", comment);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

const HEIF_BRANDS = new Set([
  "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs",
  "mif1", "msf1", "avif", "avis",
]);

/**
 * Mirrors exifr@7.1.3 `HeifFileParser.canHandle`, which does NOT require the
 * "ftyp" literal: first two bytes zero, a 16-bit length at offset 2 of at most
 * 50, and a known brand among the 4-byte slots from offset 16 up to that length.
 */
function exifrRoutesToHeif(data: Uint8Array): boolean {
  if (data.length < 12 || data[0] !== 0 || data[1] !== 0) return false;
  const ftypLength = (data[2]! << 8) | data[3]!;
  if (ftypLength > 50) return false;
  for (let offset = 16; offset < ftypLength && offset + 4 <= data.length; offset += 4) {
    const brand = String.fromCharCode(...data.subarray(offset, offset + 4));
    if (HEIF_BRANDS.has(brand)) return true;
  }
  return false;
}

/**
 * Most boxes exifr's HEIF parser will visit in one walk. A real HEIC has about
 * ten direct children of `meta` and one or two boxes after it (`mdat`), so
 * 4096 is far above anything legitimate while keeping the worst case (one
 * object per box) at a few hundred KB.
 */
const MAX_ISO_BMFF_BOXES = 4096;

interface IsoBoxHead {
  readonly isMeta: boolean;
  /** Stride exifr advances by; 0 ends its walk. Mirrors exifr, so may be negative. */
  readonly length: number;
  /** Bytes of header: 8, or 16 with a 64-bit largesize. */
  readonly header: number;
  readonly offset: number;
}

/**
 * Reads a box header exactly as exifr@7.1.3 `parseBoxHead` does, including its
 * 64-bit quirk: `(hi << 32) | lo` is evaluated in int32 arithmetic, so the
 * length is `hi | lo`, and wraps negative when bit 31 is set.
 *
 * Returns null only where exifr throws a bounded RangeError (header past the
 * data). When the high word is >= 0xfffff exifr does NOT throw: it silently
 * switches to BigInt (its `typeof BigInt !== undefined` check is always true)
 * and, for a `meta` box, still walks the children to EOF. A box above 2^52
 * bytes is never legitimate, so that is rejected here rather than left
 * unvalidated.
 */
function readIsoBoxHead(view: DataView, data: Uint8Array, offset: number): IsoBoxHead | null {
  if (offset + 8 > data.length) return null;
  let length = view.getUint32(offset);
  let header = 8;
  if (length === 1) {
    if (offset + 16 > data.length) return null;
    const high = view.getUint32(offset + 8);
    if (high >= 0xfffff) {
      throw new MalformedDocumentError(
        `ISO-BMFF box at offset ${offset} has an unrepresentable 64-bit size`,
      );
    }
    length = high | view.getUint32(offset + 12);
    header = 16;
  }
  // Compare the 4 type bytes in place: this runs once per box in a hot loop.
  const isMeta =
    data[offset + 4] === 0x6d &&
    data[offset + 5] === 0x65 &&
    data[offset + 6] === 0x74 &&
    data[offset + 7] === 0x61;
  return { isMeta, length, header, offset };
}

/** A non-zero stride below the header can never advance usefully. */
function checkIsoBoxStride(box: IsoBoxHead): void {
  if (box.length !== 0 && box.length < box.header) {
    throw new MalformedDocumentError(
      `ISO-BMFF box at offset ${box.offset} has invalid size ${box.length}`,
    );
  }
}

/**
 * Mirrors exifr `parseBoxes`: walks sibling boxes from `start` to the end of
 * the data (NOT to the end of the parent box), calling `checkIsoBoxStride`
 * and capping the box count. Returns the boxes walked.
 */
function walkIsoBoxes(view: DataView, data: Uint8Array, start: number): IsoBoxHead[] {
  const boxes: IsoBoxHead[] = [];
  let offset = start;
  while (offset < data.length - 4) {
    const box = readIsoBoxHead(view, data, offset);
    if (box === null) break;
    checkIsoBoxStride(box);
    boxes.push(box);
    if (boxes.length > MAX_ISO_BMFF_BOXES) {
      throw new LimitExceededError(
        `ISO-BMFF walk from offset ${start} exceeds ${MAX_ISO_BMFF_BOXES} boxes`,
      );
    }
    if (box.length === 0) break;
    offset += box.length;
  }
  return boxes;
}

/**
 * Validates, before exifr sees the bytes, every ISO-BMFF box walk its HEIF
 * parser performs, so each is bounded:
 *
 * 1. Top-level scan for `meta` (`offset += box.length`). A size-0 box ahead of
 *    `meta` makes exifr loop forever (and, being async, starve timers). A size
 *    of 0 means "to EOF" and is only meaningful for a final box after `meta`;
 *    a size below the header size can never advance. A box that overruns the
 *    data just ends the walk (a truncated file); exifr fails on that with a
 *    bounded range error. A 64-bit size that exifr cannot represent as a
 *    number is rejected (see `readIsoBoxHead`). The scan is capped at
 *    `MAX_ISO_BMFF_BOXES` boxes.
 * 2. The children of `meta`. exifr walks them synchronously from the first
 *    child (after the 4-byte FullBox version/flags) to EOF, allocating one
 *    object per box, so a chain of tiny boxes is a CPU/memory DoS that
 *    `maxParseMillis` cannot preempt. They get the same stride rules plus a
 *    cap on the box count. This is done for the first `meta` even if its own
 *    size overruns, because exifr walks its children regardless.
 *
 * Not walked: exifr only descends into `iprp`/`ipco` when ICC extraction is
 * enabled (`icc: false` here). It also loops over `iinf` items (at most 65535,
 * from a 16-bit count) and `iloc` items (a count of up to 2^32 on version 2,
 * but each step consumes at least 6 bytes and allocates nothing, so it is
 * bounded by the data size).
 */
function validateIsoBmffTopLevel(data: Uint8Array): void {
  if (!exifrRoutesToHeif(data)) return;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  let scanned = 0;
  while (offset + 8 <= data.length) {
    // Real files have at most a few boxes (ftyp, free, ...) before `meta`;
    // the shared cap keeps a crafted chain of tiny boxes from burning CPU here
    // and in exifr's own scan.
    if (++scanned > MAX_ISO_BMFF_BOXES) {
      throw new LimitExceededError(
        `ISO-BMFF top-level scan exceeds ${MAX_ISO_BMFF_BOXES} boxes before any meta box`,
      );
    }
    const box = readIsoBoxHead(view, data, offset);
    // Every early return below ends in an exifr exception before it can reach
    // `parseSubBoxes`: an unreadable head, a box that overruns the data (its
    // next head is out of range), or running out of boxes without a `meta`.
    if (box === null) return;
    if (box.length === 0) {
      throw new MalformedDocumentError(
        `ISO-BMFF zero-size box at offset ${offset} before any meta box`,
      );
    }
    checkIsoBoxStride(box);
    // exifr starts scanning for `meta` after the first box, whatever its kind.
    if (offset > 0 && box.isMeta) {
      // Walk the children before any overrun check: exifr walks them
      // regardless of `meta`'s own size. Nothing exifr does after this point
      // can reach unvalidated bytes (see the doc comment), so we are done.
      walkIsoBoxes(view, data, offset + box.header + 4);
      return;
    }
    if (offset + box.length > data.length) return;
    offset += box.length;
  }
}

function applyExif(metadata: Metadata, exif: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(exif)) {
    if (value === null || value === undefined) continue;
    const text = exifValue(value);
    if (text === null) continue;

    const mapped = EXIF_KEYS[key] ?? `exif:${key}`;
    metadata.set(mapped, text);
  }
}

function exifValue(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => exifValue(item))
      .filter((item): item is string => item !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

const EXIF_KEYS: Record<string, string> = {
  Make: "tiff:Make",
  Model: "tiff:Model",
  ImageWidth: "tiff:ImageWidth",
  ImageHeight: "tiff:ImageLength",
  ExifImageWidth: "tiff:ImageWidth",
  ExifImageHeight: "tiff:ImageLength",
  DateTimeOriginal: "exif:DateTimeOriginal",
  DateTimeDigitized: "exif:DateTimeDigitized",
  CreateDate: "exif:CreateDate",
  ModifyDate: "exif:ModifyDate",
  ExposureTime: "exif:ExposureTime",
  FNumber: "exif:FNumber",
  ISO: "exif:ISO",
  ISOSpeedRatings: "exif:ISO",
  FocalLength: "exif:FocalLength",
  Orientation: "tiff:Orientation",
  Software: "xmp:CreatorTool",
  ImageDescription: "dc:description",
  Artist: "dc:creator",
  Copyright: "dc:rights",
  GPSLatitude: "exif:GPSLatitude",
  GPSLongitude: "exif:GPSLongitude",
  GPSAltitude: "exif:GPSAltitude",
  latitude: "exif:GPSLatitude",
  longitude: "exif:GPSLongitude",
  ObjectName: "dc:title",
  Keywords: "dc:subject",
  "Caption-Abstract": "dc:description",
  "By-line": "dc:creator",
  CopyrightNotice: "dc:rights",
};

const JPEG_COMMENT_MARKER = 0xfe;

function jpegComments(data: Uint8Array): string[] {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return [];
  const comments: string[] = [];
  let offset = 2;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (offset + 3 < data.length) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = data[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) break;
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) break;
    if (marker === JPEG_COMMENT_MARKER) {
      const text = new TextDecoder("windows-1252")
        .decode(data.subarray(offset + 4, offset + 2 + length))
        .trim();
      if (text.length > 0) comments.push(text);
    }
    offset += 2 + length;
  }
  return comments;
}

function imageDimensions(
  data: Uint8Array,
): { width: number; height: number } | null {
  if (
    data.length >= 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  if (
    data.length >= 8 &&
    ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a) ||
      (data[0] === 0x4d && data[1] === 0x4d && data[3] === 0x2a))
  ) {
    const dimensions = tiffDimensions(data);
    if (dimensions !== null) return dimensions;
  }

  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    return jpegDimensions(data);
  }

  if (
    data.length >= 26 &&
    data[0] === 0x38 &&
    data[1] === 0x42 &&
    data[2] === 0x50 &&
    data[3] === 0x53
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint32(18), height: view.getUint32(14) };
  }

  if (
    data.length >= 4 &&
    data[0] === 0xff &&
    data[1] === 0x4f &&
    data[2] === 0xff &&
    data[3] === 0x51
  ) {
    return jpeg2000Dimensions(data);
  }

  if (
    data.length >= 12 &&
    data[4] === 0x66 &&
    data[5] === 0x74 &&
    data[6] === 0x79 &&
    data[7] === 0x70
  ) {
    const brand = String.fromCharCode(...data.subarray(8, 12));
    if (["heic", "heix", "hevc", "mif1", "msf1", "avif", "avis"].includes(brand)) {
      const dimensions = heifDimensions(data);
      if (dimensions !== null) return dimensions;
    }
  }

  if (
    data.length >= 24 &&
    data[4] === 0x6a &&
    data[5] === 0x50 &&
    data[6] === 0x20
  ) {
    for (let offset = 0; offset + 16 <= data.length; offset++) {
      if (
        data[offset] === 0x69 &&
        data[offset + 1] === 0x68 &&
        data[offset + 2] === 0x64 &&
        data[offset + 3] === 0x72
      ) {
        const view = new DataView(data.buffer, data.byteOffset);
        return {
          height: view.getUint32(offset + 4),
          width: view.getUint32(offset + 8),
        };
      }
    }
  }

  if (data.length >= 16 && data[0] === 0x42 && data[1] === 0x50 && data[2] === 0x00) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint32(8), height: view.getUint32(12) };
  }

  if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      width: Math.abs(view.getInt32(18, true)),
      height: Math.abs(view.getInt32(22, true)),
    };
  }

  if (
    data.length >= 30 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return webpDimensions(data);
  }

  return null;
}

/**
 * PNG, GIF and BMP are the formats of this path that Tika's ImageParser serves through an ImageIO reader (its
 * supported types, read from Tika source; JPEG, TIFF, WebP and the rest go to other parsers or none). For those
 * it writes the image count and the size of image 0 under `tk:num-images`, `tiff:ImageWidth`/`tiff:ImageLength`
 * and `img:height`/`img:width`, as `setImageReaderMetadata` does. Chosen by the bytes, as `imageDimensions` is.
 *
 * `dimensions` is what `imageDimensions` read from the same data. PNG and BMP have one image. GIF is counted by
 * walking its blocks and sized by the first image's descriptor.
 */
function imageReaderImages(
  data: Uint8Array,
  dimensions: { width: number; height: number } | null,
): { width: number; height: number; count: number } | null {
  if (dimensions === null) return null;
  const isPng = data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  const isBmp = data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d;
  if (isPng || isBmp) return { ...dimensions, count: 1 };
  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    const gif = readGifImages(data);
    if (gif.count === 0 || gif.blockTypeZero) return null;
    return { width: gif.firstWidth, height: gif.firstHeight, count: gif.count };
  }
  return null;
}

function heifDimensions(
  data: Uint8Array,
): { width: number; height: number } | null {
  for (let offset = 0; offset + 16 <= data.length; offset++) {
    if (
      data[offset] === 0x69 &&
      data[offset + 1] === 0x73 &&
      data[offset + 2] === 0x70 &&
      data[offset + 3] === 0x65
    ) {
      const view = new DataView(data.buffer, data.byteOffset);
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (width > 0 && height > 0) return { width, height };
    }
  }
  return null;
}

function jpeg2000Dimensions(
  data: Uint8Array,
): { width: number; height: number } | null {
  if (data.length < 24) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const xsiz = view.getUint32(8);
  const ysiz = view.getUint32(12);
  const xosiz = view.getUint32(16);
  const yosiz = view.getUint32(20);
  const width = xsiz - xosiz;
  const height = ysiz - yosiz;
  return width > 0 && height > 0 ? { width, height } : null;
}

function tiffDimensions(
  data: Uint8Array,
): { width: number; height: number } | null {
  if (data.byteLength < 8) return null;
  const little = data[0] === 0x49;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (offset: number): number => view.getUint16(offset, little);
  const u32 = (offset: number): number => view.getUint32(offset, little);
  const ifd = u32(4);
  if (ifd + 2 > data.byteLength) return null;
  const count = u16(ifd);
  let width: number | null = null;
  let height: number | null = null;
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > data.byteLength) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    if (tag !== 0x0100 && tag !== 0x0101) continue;
    const value = type === 3 ? u16(entry + 8) : u32(entry + 8);
    if (tag === 0x0100) width = value;
    else height = value;
  }
  return width !== null && height !== null ? { width, height } : null;
}

function webpDimensions(
  data: Uint8Array,
): { width: number; height: number } | null {
  const chunk = String.fromCharCode(...data.subarray(12, 16));
  if (chunk === "VP8X" && data.length >= 30) {
    const width = 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16));
    const height = 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16));
    return { width, height };
  }
  if (chunk === "VP8 " && data.length >= 30) {
    // Payload starts at 20: 3-byte frame tag, 3-byte start code (9d 01 2a),
    // then 14-bit width and 14-bit height (upper 2 bits of each are scaling).
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null;
    const width = (data[26]! | (data[27]! << 8)) & 0x3fff;
    const height = (data[28]! | (data[29]! << 8)) & 0x3fff;
    if (width > 0 && height > 0) return { width, height };
  }
  if (chunk === "VP8L" && data.length >= 30) {
    // Payload starts at 20: signature 0x2f, then 14-bit (width-1) and
    // 14-bit (height-1) packed little-endian in the next 32 bits.
    if (data[20] !== 0x2f) return null;
    const bits = (data[21]! | (data[22]! << 8) | (data[23]! << 16) | (data[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function jpegDimensions(data: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = data[offset + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(
      offset + 2,
    );
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
