import {
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import exifr from "exifr";

/**
 * Image metadata parser. EXIF/IPTC/XMP via exifr; dimensions from PNG/GIF/JPEG
 * headers when EXIF does not carry them. No pixel decoding.
 */
export class ImageParser implements Parser {
  readonly name = "ImageParser";
  readonly capabilities = { metadataOnly: true } as const;

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
      ].map((type) => MediaType.parse(type)!),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    _handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
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

    let exif: Record<string, unknown> | null = null;
    try {
      exif = (await exifr.parse(data, {
        tiff: true,
        exif: true,
        gps: true,
        iptc: true,
        xmp: true,
        icc: false,
      })) as Record<string, unknown> | null;
    } catch {
      exif = null;
    }

    const dimensions = imageDimensions(data);
    if (dimensions !== null) {
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

  if (data.length >= 22 && data[0] === 0 && data[1] === 0 && (data[2] === 1 || data[2] === 2)) {
    const width = data[6] === 0 ? 256 : data[6]!;
    const height = data[7] === 0 ? 256 : data[7]!;
    return { width, height };
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
    const start = 20;
    const width = ((data[start + 1] ?? 0) | ((data[start + 2] ?? 0) << 8)) & 0x3fff;
    const height = ((data[start + 3] ?? 0) | ((data[start + 4] ?? 0) << 8)) & 0x3fff;
    if (width > 0 && height > 0) return { width, height };
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
