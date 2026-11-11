import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";

/**
 * Bounds what exifr@7.1.3 allocates for TIFF/EXIF tags, before exifr sees the bytes (tikajs-e42s).
 *
 * For every tag exifr reads the declared value count and allocates for it: a typed array of `count` elements for a
 * numeric tag, a decoded string of `count` bytes for an ASCII tag (`TiffCore.parseTag`). It does not check that the
 * values are distinct bytes of the file, so a file of a few hundred KB whose thousands of tags all declare 100000
 * values and point at the same bytes costs hundreds of MB and seconds of CPU, and a count of 2^32 asks for 32 GB in
 * one tag. exifr runs synchronously, so `maxParseMillis` cannot interrupt it. The IFD chain itself is not the
 * problem (exifr does not follow it), only the per-tag value arrays.
 *
 * This walks exactly the IFDs exifr parses with the options in `EXIFR_OPTIONS` (IFD0, the Exif IFD and the GPS IFD
 * behind IFD0's pointer tags, and the Interop IFD behind the pointer tag of IFD0 or of the Exif IFD) in exactly the containers it reads TIFF from (a raw TIFF, the first APP1 "Exif"
 * segment of a JPEG, a PNG eXIf chunk, the Exif item of a HEIF/AVIF), adds up what exifr would allocate and throws LimitExceededError when a
 * cap is passed. Everything it reads is bounds-checked and every loop advances at least one byte or one entry, so
 * its own cost is linear in the file.
 */

/** The exifr options the guard assumes. `image.ts` passes exactly these, so they cannot drift apart. */
export const EXIFR_OPTIONS = {
  // `tiff: true` makes exifr enable every block, the Interop IFD among them whatever `interop` is set to (exifr
  // `batchEnableWithBool`), so IFD0, the Exif, GPS and Interop IFDs are parsed. IFD1 (the thumbnail) is enabled too,
  // and then disabled again by `mergeOutput`, which is exifr's default and is stated here so the guard's assumption
  // is visible and cannot change with it.
  tiff: true,
  exif: true,
  gps: true,
  iptc: true,
  mergeOutput: true,
  // exifr's XMP extraction runs a quadratic synchronous regex that can freeze the event loop on large or crafted
  // payloads.
  xmp: false,
  icc: false,
} as const;

/**
 * Most entries one IFD may declare. A camera IFD0 has about 30 to 60 tags, the Exif IFD about 50, GPS about 30;
 * DNG and GeoTIFF IFDs reach a few hundred. The field is a u16 (65535). 4096 is more than ten times the largest
 * real IFD known and keeps a walk at 48 KB of entries.
 */
export const MAX_IFD_ENTRIES = 4096;

/**
 * Most bytes one tag may ask exifr to copy (a typed array of the declared count, or a string). The largest real
 * tags are strip/tile offset and byte-count tables: a whole-slide TIFF of 150000 tiles has 600 KB per table, and
 * a 1M-tile table is 4 MiB. A camera JPEG's largest are DNG tone and hue tables of 32 KB to 1 MB.
 * BYTE and UNDEFINED tags (XMP, ICC, IPTC, MakerNote, thumbnails) are not counted: exifr returns a view of the file
 * for them and copies nothing.
 */
export const MAX_TAG_COPY_BYTES = 4 * 1024 * 1024;

/**
 * Most bytes all tags of one file may ask exifr to copy, in total, whatever the file's size: the bound on what a
 * crafted file can make exifr allocate. Real camera and scanner files stay far below it (see MAX_TAG_COPY_BYTES).
 */
export const MAX_TOTAL_COPY_BYTES = 16 * 1024 * 1024;

/**
 * Slack added to the file's own size to make the total cap relative to it. A real file stores every value once,
 * so the values exifr copies add up to at most the file's size (plus the 4 bytes of an inline pair of SHORTs, which
 * take no space of their own: 3 IFDs x 4096 entries x 4 bytes = 48 KB, under this). A crafted file makes tags overlap
 * on the same bytes, and only then does the sum exceed the file. So the total is capped at the file's size plus this,
 * and at MAX_TOTAL_COPY_BYTES when that is smaller, which keeps the amplification at about 1x for small files.
 */
export const COPY_SLACK_BYTES = 64 * 1024;

const BYTE = 1;
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const UNDEFINED = 7;
const IFD = 13;

/** Element size by TIFF value type; index 0 and anything above 13 is not a type (exifr throws on it). */
const VALUE_SIZE: readonly number[] = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_INTEROP_IFD = 0xa005;

interface Budget {
  copiedBytes: number;
  readonly limit: number;
}

interface Block {
  /** Offset of the TIFF header in the data. */
  readonly start: number;
  /** End of the bytes exifr may read for this TIFF. */
  readonly end: number;
}

/** Throws LimitExceededError if exifr would allocate more for a TIFF/EXIF in `data` than the caps allow. */
export function guardExifAmplification(data: Uint8Array): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const budget: Budget = {
    copiedBytes: 0,
    limit: Math.min(MAX_TOTAL_COPY_BYTES, data.length + COPY_SLACK_BYTES),
  };
  for (const block of findTiffBlocks(data, view)) walkTiff(view, block, budget);
}

function findTiffBlocks(data: Uint8Array, view: DataView): Block[] {
  if (data.length < 2) return [];
  // exifr's TIFF file parser accepts any data whose first two bytes are a byte order mark.
  if ((data[0] === 0x49 && data[1] === 0x49) || (data[0] === 0x4d && data[1] === 0x4d)) {
    return [{ start: 0, end: data.length }];
  }
  if (data[0] === 0xff && data[1] === 0xd8) return findJpegExifBlocks(data, view);
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return findPngExifBlocks(data, view);
  }
  // exifr's HEIF parser claims data whose first two bytes are zero and that names a HEIF brand. The brand test is
  // left out here: walking the boxes of other data is bounded and finds nothing.
  if (data[0] === 0 && data[1] === 0) return findHeifExifBlocks(data, view);
  return [];
}

/**
 * exifr reads a JPEG APP1 or PNG eXIf segment of declared size 0 not as empty but as `MAX_APP_SIZE` (65536) bytes from
 * its start (`ensureSegmentChunk`: `seg.size || MAX_APP_SIZE`), so the bytes after such a segment are parsed as TIFF.
 */
const EXIFR_EMPTY_SEGMENT_BYTES = 65536;

/** Markers that exifr's JPEG scan steps over by their length: the APPn range is tested separately. */
const JPEG_STRUCTURE_MARKERS = new Set([0xc0, 0xc2, 0xc4, 0xdb, 0xdd, 0xda, 0xfe]);

/**
 * Ports exifr `JpegFileParser.findAppSegmentsInRange`: a byte scan for 0xFF then a marker, stepping over the
 * segments it knows by their length, stopping at SOS. exifr parses the first APP1 "Exif\0\0" segment; this returns
 * every one it passes, which is a superset and costs nothing extra (the walk is linear in the data).
 */
function findJpegExifBlocks(data: Uint8Array, view: DataView): Block[] {
  const blocks: Block[] = [];
  const last = data.length - 2;
  for (let offset = 0; offset < last; offset++) {
    if (data[offset] !== 0xff) continue;
    const marker = data[offset + 1]!;
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (!isApp && !JPEG_STRUCTURE_MARKERS.has(marker)) continue;
    if (offset + 4 > data.length) break;
    const length = view.getUint16(offset + 2);
    if (marker === 0xda) break;
    if (
      marker === 0xe1 &&
      offset + 10 <= data.length &&
      view.getUint32(offset + 4) === 0x45786966 &&
      view.getUint16(offset + 8) === 0
    ) {
      // The content is the segment's length without the 8 bytes of length field and "Exif\0\0".
      const size = length - 8 === 0 ? EXIFR_EMPTY_SEGMENT_BYTES : length - 8;
      blocks.push({ start: offset + 10, end: Math.min(offset + 10 + size, data.length) });
    }
    offset += length + 1;
  }
  return blocks;
}

/** Ports exifr `PngFileParser.findPngChunksInRange`: every chunk advances by its size plus 12, so at least 12. */
function findPngExifBlocks(data: Uint8Array, view: DataView): Block[] {
  const blocks: Block[] = [];
  let offset = 8;
  while (offset + 8 <= data.length) {
    const size = view.getUint32(offset);
    const isExif =
      (data[offset + 4]! | 0x20) === 0x65 && // e or E
      (data[offset + 5]! | 0x20) === 0x78 && // x or X
      (data[offset + 6]! | 0x20) === 0x69 && // i or I
      (data[offset + 7]! | 0x20) === 0x66; // f or F
    if (isExif) {
      const window = size === 0 ? EXIFR_EMPTY_SEGMENT_BYTES : size;
      blocks.push({ start: offset + 8, end: Math.min(offset + 8 + window, data.length) });
    }
    offset += size + 12;
  }
  return blocks;
}

/** Most boxes walked at one level. image.ts caps the same walks at the same number before exifr sees the data. */
const MAX_BOXES = 4096;

interface BoxHead {
  readonly kind: string;
  readonly length: number;
  /** First byte after the header (and after the version and flags of a full box, once `fullBox` is applied). */
  readonly start: number;
}

/**
 * Ports exifr `HeifFileParser.parse` and `findExif`: the TIFF is the `Exif` item of `meta`, found through the item
 * list in `iinf` and its extent in `iloc`. Every read is bounds-checked (exifr's would throw a RangeError, which
 * ends its walk), the box loops are capped, and the item loops advance by at least 6 bytes per step.
 */
function findHeifExifBlocks(data: Uint8Array, view: DataView): Block[] {
  const u8 = (offset: number): number | undefined => (offset >= 0 && offset < data.length ? data[offset] : undefined);
  const u16 = (offset: number): number | undefined =>
    offset >= 0 && offset + 2 <= data.length ? view.getUint16(offset) : undefined;
  const u32 = (offset: number): number | undefined =>
    offset >= 0 && offset + 4 <= data.length ? view.getUint32(offset) : undefined;
  /**
   * exifr `BufferView.getUint64`: below a high word of 2^20 - 1 it computes `(high << 32) | low` in 32-bit arithmetic,
   * which is `high | low` (negative when bit 31 is set), not the 64-bit value. At or above it exifr switches to BigInt
   * and fails on the next sum with a number, so nothing is read. Reading the true 64-bit value here would walk a
   * different box chain than exifr does, and miss the Exif item it reaches.
   */
  const u64 = (offset: number): number | undefined => {
    if (offset < 0 || offset + 8 > data.length) return undefined;
    const high = view.getUint32(offset);
    return high < 0xfffff ? high | view.getUint32(offset + 4) : undefined;
  };
  /** exifr `getUintBytes`: 1, 2, 4 or 8 bytes; any other size gives it nothing. */
  const uintBytes = (offset: number, size: number): number | undefined =>
    size === 1 ? u8(offset) : size === 2 ? u16(offset) : size === 4 ? u32(offset) : size === 8 ? u64(offset) : undefined;
  const head = (offset: number): BoxHead | undefined => {
    let length = u32(offset);
    if (length === undefined || offset + 8 > data.length) return undefined;
    const kind = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    let start = offset + 8;
    if (length === 1) {
      length = u64(offset + 8);
      start += 8;
    }
    return length === undefined ? undefined : { kind, length, start };
  };
  /** exifr `parseBoxFullHead`: skips the version and flags, returns the version. */
  const fullBox = (box: BoxHead): { start: number; version: number } | undefined => {
    const flags = u32(box.start);
    return flags === undefined ? undefined : { start: box.start + 4, version: flags >>> 24 };
  };

  // The first box is skipped, whatever it is; then the boxes are walked until `meta`.
  let offset = u32(0);
  let meta: BoxHead | undefined;
  for (let step = 0; offset !== undefined && step < MAX_BOXES; step++) {
    const box = head(offset);
    if (box === undefined) return [];
    if (box.kind === "meta") {
      meta = box;
      break;
    }
    if (box.length === 0) return [];
    offset += box.length;
  }
  const metaFull = meta === undefined ? undefined : fullBox(meta);
  if (metaFull === undefined) return [];

  let iinf: BoxHead | undefined;
  let iloc: BoxHead | undefined;
  let childOffset = metaFull.start;
  for (let step = 0; childOffset < data.length - 4 && step < MAX_BOXES; step++) {
    const child = head(childOffset);
    if (child === undefined) break;
    if (child.kind === "iinf") iinf ??= child;
    if (child.kind === "iloc") iloc ??= child;
    if (child.length === 0) break;
    childOffset += child.length;
  }
  if (iinf === undefined || iloc === undefined) return [];

  // exifr `findExifLocIdInIinf`: the id of the first item of type "Exif" (at most 65535 items).
  const iinfFull = fullBox(iinf);
  const itemTotal = iinfFull === undefined ? undefined : u16(iinfFull.start);
  if (iinfFull === undefined || itemTotal === undefined) return [];
  let exifItemId: number | undefined;
  let infeOffset = iinfFull.start + 2;
  for (let remaining = itemTotal; remaining > 0 && exifItemId === undefined; remaining--) {
    const infe = head(infeOffset);
    if (infe === undefined) return [];
    const infeFull = fullBox(infe);
    if (infeFull === undefined) return [];
    if (infeFull.version >= 2) {
      const idSize = infeFull.version === 3 ? 4 : 2;
      const typeAt = infeFull.start + idSize + 2;
      if (typeAt + 4 > data.length) return [];
      if (String.fromCharCode(...data.subarray(typeAt, typeAt + 4)) === "Exif") {
        exifItemId = uintBytes(infeFull.start, idSize);
      }
    }
    infeOffset += infe.length;
  }
  if (exifItemId === undefined) return [];

  // exifr `findExtentInIloc`: the first extent of that item. Each item takes at least 6 bytes.
  const ilocFull = fullBox(iloc);
  if (ilocFull === undefined) return [];
  const sizes = u8(ilocFull.start);
  const baseSizes = u8(ilocFull.start + 1);
  if (sizes === undefined || baseSizes === undefined) return [];
  const [offsetSize, lengthSize] = [sizes >> 4, sizes & 0xf];
  const [baseOffsetSize, indexSize] = [baseSizes >> 4, baseSizes & 0xf];
  const itemIdSize = ilocFull.version === 2 ? 4 : 2;
  const constMethodSize = ilocFull.version === 1 || ilocFull.version === 2 ? 2 : 0;
  const itemCountSize = ilocFull.version === 2 ? 4 : 2;
  const extentSize = indexSize + offsetSize + lengthSize;
  let cursor = ilocFull.start + 2;
  const itemCount = uintBytes(cursor, itemCountSize);
  if (itemCount === undefined) return [];
  cursor += itemCountSize;
  for (let remaining = itemCount; remaining > 0; remaining--) {
    const itemId = uintBytes(cursor, itemIdSize);
    if (itemId === undefined) return [];
    cursor += itemIdSize + constMethodSize + 2 + baseOffsetSize;
    const extentCount = u16(cursor);
    if (extentCount === undefined) return [];
    cursor += 2;
    if (itemId === exifItemId) {
      const extentOffset = uintBytes(cursor + indexSize, offsetSize);
      const extentLength = uintBytes(cursor + indexSize + offsetSize, lengthSize);
      if (extentOffset === undefined) return [];
      // The item starts with a 4-byte count of the bytes before the TIFF header.
      const nameSize = u32(extentOffset);
      if (nameSize === undefined) return [];
      const shift = 4 + nameSize;
      const tiffStart = extentOffset + shift;
      // exifr's `BufferView.subarray` reads a length of 0 or NaN (the extent has no readable length) as "to the end".
      const rawLength = extentLength === undefined ? 0 : extentLength - shift;
      const tiffLength = rawLength === 0 ? data.length - tiffStart : rawLength;
      if (tiffLength < 8 || tiffStart >= data.length) return [];
      return [{ start: tiffStart, end: Math.min(tiffStart + tiffLength, data.length) }];
    }
    cursor += extentCount * extentSize;
  }
  return [];
}

function walkTiff(view: DataView, block: Block, budget: Budget): void {
  const length = block.end - block.start;
  if (length < 8) return;
  // exifr reads little endian only for "II"; any other mark is read big endian.
  const le = view.getUint16(block.start) === 0x4949;
  const u16 = (offset: number): number | undefined =>
    offset >= 0 && offset + 2 <= length ? view.getUint16(block.start + offset, le) : undefined;
  const u32 = (offset: number): number | undefined =>
    offset >= 0 && offset + 4 <= length ? view.getUint32(block.start + offset, le) : undefined;

  /**
   * Walks one IFD as `TiffCore.parseTags` does. Returns where each of the `pointerTags` that exifr follows from this
   * IFD points to.
   */
  const walkIfd = (ifdOffset: number, pointerTags: readonly number[]): Map<number, number> => {
    const pointers = new Map<number, number>();
    let badPointer: number | undefined;
    const entries = u16(ifdOffset);
    if (entries === undefined) return pointers; // exifr: RangeError, bounded.
    if (entries > MAX_IFD_ENTRIES) {
      throw new LimitExceededError(
        `TIFF IFD at offset ${ifdOffset} declares ${entries} entries (limit ${MAX_IFD_ENTRIES})`,
      );
    }
    for (let index = 0; index < entries; index++) {
      const entry = ifdOffset + 2 + index * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const count = u32(entry + 4);
      if (tag === undefined || type === undefined || count === undefined) break;
      // exifr throws on a type outside 1..13, which ends the walk of this IFD.
      if (type < BYTE || type > IFD) break;
      const totalSize = VALUE_SIZE[type]! * count;
      if (totalSize > 4) {
        const valueOffset = u32(entry + 8);
        // exifr throws before allocating when the value offset is unreadable or past the data.
        if (valueOffset === undefined || valueOffset > length) break;
      }
      // BYTE and UNDEFINED come back as a view of the file. Every other type with more than one value allocates
      // `count` elements, and ASCII decodes `count` bytes.
      const copies = type === ASCII || (type !== BYTE && type !== UNDEFINED && count !== 1);
      if (copies) countCopy(budget, tag, totalSize);
      if (pointerTags.includes(tag)) {
        const target = pointerTarget(type, count, u16(entry + 8), u32(entry + 8));
        if (target === undefined) badPointer ??= tag;
        else pointers.set(tag, target);
      }
    }
    // After the loop, so a file that is hostile in other ways reports the limit it passed, not this.
    if (badPointer !== undefined) {
      throw new MalformedDocumentError(
        `TIFF pointer tag 0x${badPointer.toString(16)} is not a single SHORT or LONG`,
      );
    }
    return pointers;
  };

  const ifd0Offset = u32(4);
  if (ifd0Offset === undefined || ifd0Offset < 8) return; // exifr: "Malformed EXIF data", bounded.
  const ifd0 = walkIfd(ifd0Offset, [TAG_EXIF_IFD, TAG_GPS_IFD, TAG_INTEROP_IFD]);
  const exif = ifd0.get(TAG_EXIF_IFD);
  const fromExif = exif === undefined ? undefined : walkIfd(exif, [TAG_INTEROP_IFD]).get(TAG_INTEROP_IFD);
  const gps = ifd0.get(TAG_GPS_IFD);
  if (gps !== undefined) walkIfd(gps, []);
  // exifr takes IFD0's Interop pointer, and the Exif IFD's when IFD0 has none; both are walked here.
  for (const interop of [ifd0.get(TAG_INTEROP_IFD), fromExif]) {
    if (interop !== undefined) walkIfd(interop, []);
  }
}

function countCopy(budget: Budget, tag: number, bytes: number): void {
  if (bytes > MAX_TAG_COPY_BYTES) {
    throw new LimitExceededError(
      `TIFF tag 0x${tag.toString(16)} declares ${bytes} bytes of values (limit ${MAX_TAG_COPY_BYTES})`,
    );
  }
  budget.copiedBytes += bytes;
  if (budget.copiedBytes > budget.limit) {
    throw new LimitExceededError(
      `TIFF tags declare more than ${budget.limit} bytes of values in total (the file's size plus slack, at most ${MAX_TOTAL_COPY_BYTES})`,
    );
  }
}

/**
 * The IFD offset an Exif or GPS pointer tag gives exifr: a single SHORT or LONG. exifr takes whatever the tag
 * decodes to, so a pointer of any other type or count (an ASCII string, a BYTE array) can steer it to an IFD this
 * walk would not see. No writer produces one, so it is refused (undefined) rather than guessed at.
 */
function pointerTarget(
  type: number,
  count: number,
  short: number | undefined,
  long: number | undefined,
): number | undefined {
  if (count === 1 && type === SHORT) return short;
  if (count === 1 && (type === LONG || type === IFD)) return long;
  return undefined;
}
