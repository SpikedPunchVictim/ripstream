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

/**
 * tikajs-e42s: exifr allocates one typed array (or decoded string) per TIFF tag, sized by the tag's declared value
 * count, and never checks that the values are distinct bytes of the file. A small file whose many tags all declare a
 * large count and point at the same bytes therefore costs hundreds of MB. These tests build such files by hand.
 */

const BYTE = 1;
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;

interface Entry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** The 4-byte value field. "data" means the offset of the shared value region at the end of the file. */
  readonly value: number | "data";
}

interface TiffSpec {
  readonly ifd0: readonly Entry[];
  readonly exif?: readonly Entry[];
  readonly gps?: readonly Entry[];
  /** Bytes of zeros after the IFDs: the one region every hostile tag points at. */
  readonly dataBytes: number;
  /** "MM" instead of "II". */
  readonly bigEndian?: boolean;
}

/** Little-endian TIFF (big-endian when asked): header, IFD0, then the optional Exif and GPS IFDs, then the shared value region. */
function buildTiff(spec: TiffSpec): Uint8Array {
  const pointers = (spec.exif ? 1 : 0) + (spec.gps ? 1 : 0);
  const ifdSize = (entries: number): number => 2 + entries * 12 + 4;
  const ifd0Offset = 8;
  const exifOffset = ifd0Offset + ifdSize(spec.ifd0.length + pointers);
  const gpsOffset = exifOffset + (spec.exif ? ifdSize(spec.exif.length) : 0);
  const dataOffset = gpsOffset + (spec.gps ? ifdSize(spec.gps.length) : 0);
  const bytes = new Uint8Array(dataOffset + spec.dataBytes);
  const view = new DataView(bytes.buffer);
  const little = spec.bigEndian !== true;
  bytes.set(little ? [0x49, 0x49, 0x2a, 0x00] : [0x4d, 0x4d, 0x00, 0x2a]);
  view.setUint32(4, ifd0Offset, little);

  const writeIfd = (offset: number, entries: readonly Entry[]): void => {
    view.setUint16(offset, entries.length, little);
    entries.forEach((entry, index) => {
      const at = offset + 2 + index * 12;
      view.setUint16(at, entry.tag, little);
      view.setUint16(at + 2, entry.type, little);
      view.setUint32(at + 4, entry.count, little);
      view.setUint32(at + 8, entry.value === "data" ? dataOffset : entry.value, little);
    });
  };
  const ifd0 = [...spec.ifd0];
  if (spec.exif) ifd0.push({ tag: 0x8769, type: LONG, count: 1, value: exifOffset });
  if (spec.gps) ifd0.push({ tag: 0x8825, type: LONG, count: 1, value: gpsOffset });
  writeIfd(ifd0Offset, ifd0);
  if (spec.exif) writeIfd(exifOffset, spec.exif);
  if (spec.gps) writeIfd(gpsOffset, spec.gps);
  return bytes;
}

/** `n` entries of one type and count, each with its own tag number, all pointing at the shared value region. */
function manyEntries(n: number, type: number, count: number, firstTag = 0x1000): Entry[] {
  return Array.from({ length: n }, (_, index) => ({ tag: firstTag + index, type, count, value: "data" as const }));
}

/** A JPEG whose APP1 segment carries `tiff` after the "Exif\0\0" header, then SOS and EOI. */
function jpegWithTiff(tiff: Uint8Array): Uint8Array {
  const length = 2 + 6 + tiff.length;
  assert.ok(length <= 0xffff, "TIFF too large for one APP1 segment");
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff,
    0x45, 0x78, 0x69, 0x66, 0, 0,
    ...tiff,
    0xff, 0xda, 0, 2, 0xff, 0xd9,
  ]);
}

/** A PNG whose only metadata is an eXIf chunk (or a chunk of another `name`) holding `tiff`. */
function pngWithTiff(tiff: Uint8Array, name = "eXIf"): Uint8Array {
  const chunk = (type: string, body: Uint8Array): number[] => {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, body.length);
    head.set(new TextEncoder().encode(type), 4);
    return [...head, ...body, 0, 0, 0, 0];
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 8);
  new DataView(ihdr.buffer).setUint32(4, 8);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", ihdr),
    ...chunk(name, tiff),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

function isoBox(type: string, payload: readonly number[] = []): number[] {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return [...out];
}

/**
 * A HEIC whose `Exif` item (found through iinf and iloc, as exifr does) holds `tiff`: ftyp, meta (iinf with one
 * Exif item, iloc with its one extent), then an mdat that carries the item.
 */
function heicWithTiff(tiff: Uint8Array): Uint8Array {
  const ftyp = isoBox("ftyp", [0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x68, 0x65, 0x69, 0x63]);
  const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];
  const infe = isoBox("infe", [2, 0, 0, 0, 0, 1, 0, 0, ...ascii("Exif"), 0]);
  const iinf = isoBox("iinf", [0, 0, 0, 0, 0, 1, ...infe]);
  const ilocOf = (extentOffset: number, extentLength: number): number[] => {
    const extent = new Uint8Array(8);
    new DataView(extent.buffer).setUint32(0, extentOffset);
    new DataView(extent.buffer).setUint32(4, extentLength);
    // v0, offset and length 4 bytes, no base offset or index, one item (id 1, data ref 0) with one extent.
    return isoBox("iloc", [0, 0, 0, 0, 0x44, 0x00, 0, 1, 0, 1, 0, 0, 0, 1, ...extent]);
  };
  // The item: a 4-byte count of the bytes before the TIFF header (6, "Exif\0\0"), then those, then the TIFF.
  const item = [0, 0, 0, 6, ...ascii("Exif"), 0, 0, ...tiff];
  const metaLength = 8 + 4 + iinf.length + ilocOf(0, 0).length;
  const itemOffset = ftyp.length + metaLength + 8;
  const meta = isoBox("meta", [0, 0, 0, 0, ...iinf, ...ilocOf(itemOffset, item.length)]);
  return new Uint8Array([...ftyp, ...meta, ...isoBox("mdat", item)]);
}

/**
 * Elements requested from the typed array constructors while `run` executes. exifr reads these constructors from
 * the global scope each time it allocates a tag's array, so counting construct calls is a deterministic count of
 * what a parse allocates for declared sizes, with no clock or heap reading involved.
 */
const TYPED_ARRAYS = ["Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array"] as const;

async function countTypedArrayElements(run: () => Promise<unknown>): Promise<{ elements: number; error: unknown }> {
  const scope = globalThis as unknown as Record<string, unknown>;
  const originals = TYPED_ARRAYS.map((name) => scope[name]);
  let elements = 0;
  TYPED_ARRAYS.forEach((name, index) => {
    scope[name] = new Proxy(originals[index] as new (...args: unknown[]) => unknown, {
      construct(target, args, newTarget) {
        if (typeof args[0] === "number") elements += args[0];
        return Reflect.construct(target, args, newTarget);
      },
    });
  });
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  } finally {
    TYPED_ARRAYS.forEach((name, index) => {
      scope[name] = originals[index];
    });
  }
  return { elements, error };
}

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

/** The parse must fail with LimitExceededError and allocate nothing for any declared size. */
async function assertRejectedBeforeAllocating(bytes: Uint8Array, label: string): Promise<void> {
  const { elements, error } = await countTypedArrayElements(() => parseBytes(bytes));
  assert.ok(error instanceof LimitExceededError, `${label}: expected LimitExceededError, got ${String(error)}`);
  assert.equal(elements, 0, `${label}: ${elements} typed array elements were allocated before the limit`);
}

// A file of 450 KB. Unguarded, 4000 tags x 100000 LONGs is 1.6 GB of typed arrays: every value is in range, because
// they all overlap on the same 400 KB.
const MANY_LONG_ARRAYS = (): TiffSpec => ({
  ifd0: manyEntries(4000, LONG, 100_000),
  dataBytes: 400_000,
});

test("instrument: counts the typed array a legitimate tag allocates", async () => {
  const bytes = buildTiff({ ifd0: manyEntries(1, LONG, 50_000), dataBytes: 200_000 });
  const { elements, error } = await countTypedArrayElements(() => parseBytes(bytes));
  assert.equal(error, undefined);
  assert.equal(elements, 50_000);
});

test("tiff: many IFD0 tags each declaring a huge array count fail before any allocation", async () => {
  await assertRejectedBeforeAllocating(buildTiff(MANY_LONG_ARRAYS()), "IFD0");
});

test("tiff: the same hostile tags in the Exif sub-IFD are refused", async () => {
  const tiff = buildTiff({ ifd0: [], exif: manyEntries(4000, SHORT, 60_000), dataBytes: 120_000 });
  await assertRejectedBeforeAllocating(tiff, "Exif IFD");
});

test("tiff: the same hostile tags in the GPS sub-IFD are refused", async () => {
  const tiff = buildTiff({ ifd0: [], gps: manyEntries(4000, DOUBLE, 30_000), dataBytes: 240_000 });
  await assertRejectedBeforeAllocating(tiff, "GPS IFD");
});

test("tiff: one tag declaring more bytes than any real tag is refused", async () => {
  // 0x7fffffff doubles is 16 GB in one tag.
  const tiff = buildTiff({ ifd0: manyEntries(1, DOUBLE, 0x7fff_ffff), dataBytes: 16 });
  await assertRejectedBeforeAllocating(tiff, "one huge tag");
});

test("tiff: an ASCII tag is decoded to a string of its declared size, so it counts too", async () => {
  // 4000 strings of 100000 bytes over a 100 KB region: every one is in range and would be decoded.
  const tiff = buildTiff({ ifd0: manyEntries(4000, ASCII, 100_000), dataBytes: 100_000 });
  await assertRejectedBeforeAllocating(tiff, "ASCII");
});

test("tiff: an IFD declaring more entries than any real file is refused", async () => {
  const tiff = buildTiff({ ifd0: manyEntries(5000, SHORT, 1), dataBytes: 16 });
  await assertRejectedBeforeAllocating(tiff, "entry count");
});

test("tiff: a u16 entry count of 65535 with no entries behind it is refused, not walked", async () => {
  const tiff = new Uint8Array(32);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0xff, 0xff]);
  await assertRejectedBeforeAllocating(tiff, "empty 65535");
});

test("tiff: tags that together declare more than the file holds are refused even under the absolute cap", async () => {
  // 2000 tags x 2000 LONGs is 16 MB, under the 16 MiB total cap, but the file is 49 KB: a real file stores each value
  // once, so its values cannot add up to more than itself.
  const tiff = buildTiff({ ifd0: manyEntries(2000, LONG, 2000), dataBytes: 8000 });
  assert.ok(tiff.length < 64 * 1024);
  await assertRejectedBeforeAllocating(tiff, "overlapping values");
});

test("tiff: an Exif pointer that is not a single SHORT or LONG is refused", async () => {
  // An ASCII "Exif pointer" would let exifr read an IFD at any offset the string spells, one the guard cannot see.
  const tiff = buildTiff({ ifd0: [{ tag: 0x8769, type: ASCII, count: 2, value: 0 }], dataBytes: 16 });
  await assert.rejects(parseBytes(tiff), MalformedDocumentError);
});

test("jpeg: the hostile tags are refused inside an APP1 Exif segment", async () => {
  // An APP1 segment holds at most 64 KB, so: 4000 tags x 2000 LONGs (8 KB, all overlapping) is 32 MB declared.
  const tiff = buildTiff({ ifd0: manyEntries(4000, LONG, 2000), dataBytes: 8000 });
  await assertRejectedBeforeAllocating(jpegWithTiff(tiff), "JPEG APP1");
});

test("png: the hostile tags are refused inside an eXIf chunk", async () => {
  await assertRejectedBeforeAllocating(pngWithTiff(buildTiff(MANY_LONG_ARRAYS())), "PNG eXIf");
});

test("heic: the hostile tags are refused inside the Exif item", async () => {
  await assertRejectedBeforeAllocating(heicWithTiff(buildTiff(MANY_LONG_ARRAYS())), "HEIC Exif item");
});

test("heic: the Exif item of a well-formed HEIC is read", async () => {
  // Control for the test above: this builder produces a HEIC exifr finds the TIFF in.
  const tiff = buildTiff({ ifd0: manyEntries(1, LONG, 50_000), dataBytes: 200_000 });
  const { elements, error } = await countTypedArrayElements(() => parseBytes(heicWithTiff(tiff)));
  assert.equal(error, undefined);
  assert.equal(elements, 50_000);
});

test("tiff: byte and undefined tags are views of the file, not copies, and are not counted", async () => {
  // 4000 x 1 MB of BYTE data over one 1 MB region would be 4 GB if copied; exifr takes a view.
  const tiff = buildTiff({ ifd0: manyEntries(4000, BYTE, 1_000_000), dataBytes: 1_000_000 });
  await assert.doesNotReject(parseBytes(tiff));
});

test("tiff: a camera-sized set of tags is not limited", async () => {
  const tiff = buildTiff({
    ifd0: [
      { tag: 0x010f, type: ASCII, count: 8, value: "data" },
      { tag: 0x0111, type: LONG, count: 50_000, value: "data" },
      { tag: 0x0117, type: LONG, count: 50_000, value: "data" },
      ...manyEntries(60, SHORT, 3),
    ],
    exif: manyEntries(60, DOUBLE, 9),
    dataBytes: 400_000,
  });
  const { elements, error } = await countTypedArrayElements(() => parseBytes(tiff));
  assert.equal(error, undefined);
  // Both 50000-entry strip arrays were read, so the guard let exifr run.
  assert.ok(elements >= 100_000, `${elements} elements`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Boundaries and structure: what the caps are exactly, which tag types and containers count, how the walk ends.
// ---------------------------------------------------------------------------------------------------------------------

const MIB4 = 4 * 1024 * 1024;

/** The guard let the bytes through. exifr may still fail on them, which image.ts swallows. */
async function assertAccepted(bytes: Uint8Array, label: string): Promise<void> {
  await assert.doesNotReject(parseBytes(bytes), label);
}

async function assertLimit(bytes: Uint8Array, label: string): Promise<void> {
  await assert.rejects(parseBytes(bytes), LimitExceededError, label);
}

/** One tag that is over the per-tag cap on its own, pointing into the data region: the walk reaches it or it does not. */
const SENTINEL: Entry = { tag: 0x2000, type: ASCII, count: 5_000_000, value: "data" };

const tiffLength = (spec: TiffSpec): number => buildTiff(spec).length;

test("tiff: an IFD of exactly 4096 entries is read, one of 4097 is refused", async () => {
  await assertAccepted(buildTiff({ ifd0: manyEntries(4096, SHORT, 1), dataBytes: 16 }), "4096 entries");
  await assertLimit(buildTiff({ ifd0: manyEntries(4097, SHORT, 1), dataBytes: 16 }), "4097 entries");
});

test("tiff: one tag may ask for exactly 4 MiB of values, not one byte more", async () => {
  await assertAccepted(buildTiff({ ifd0: manyEntries(1, ASCII, MIB4), dataBytes: MIB4 }), "4 MiB");
  await assertLimit(buildTiff({ ifd0: manyEntries(1, ASCII, MIB4 + 1), dataBytes: MIB4 }), "4 MiB + 1");
});

test("tiff: a file whose tags total exactly 16 MiB is read, 16 MiB and one byte is refused", async () => {
  // The file is larger than 16 MiB, so the absolute cap and not the file's size is the limit.
  const four = manyEntries(4, ASCII, MIB4);
  const extra: Entry = { tag: 0x3000, type: ASCII, count: 1, value: 0 };
  await assertAccepted(buildTiff({ ifd0: four, dataBytes: 17 * 1024 * 1024 }), "16 MiB");
  await assertLimit(buildTiff({ ifd0: [...four, extra], dataBytes: 17 * 1024 * 1024 }), "16 MiB + 1");
});

test("tiff: a small file's tags may total its size plus 64 KiB, not one byte more", async () => {
  const withCount = (count: number): TiffSpec => ({ ifd0: manyEntries(1, ASCII, count), dataBytes: 1000 });
  const limit = tiffLength(withCount(1)) + 64 * 1024;
  await assertAccepted(buildTiff(withCount(limit)), "file + 64 KiB");
  await assertLimit(buildTiff(withCount(limit + 1)), "file + 64 KiB + 1");
});

/** An ASCII tag that leaves exactly `room` bytes under the total cap of a small file, then `rest`. */
function nearlyFull(room: number, rest: readonly Entry[]): TiffSpec {
  const first = (count: number): TiffSpec => ({
    ifd0: [{ tag: 0x1000, type: ASCII, count, value: "data" }, ...rest],
    dataBytes: 1000,
  });
  const limit = tiffLength(first(1)) + 64 * 1024;
  return first(limit - room);
}

test("tiff: an ASCII tag of one byte is counted against the total", async () => {
  const one = (tag: number): Entry => ({ tag, type: ASCII, count: 1, value: 0 });
  await assertAccepted(buildTiff(nearlyFull(1, [one(0x1001)])), "fits exactly");
  await assertLimit(buildTiff(nearlyFull(1, [one(0x1001), one(0x1002)])), "one byte over");
});

test("tiff: single values of every numeric type are not copies and are not counted", async () => {
  const single = (tag: number, type: number): Entry => ({ tag, type, count: 1, value: "data" });
  const rest = [single(0x1001, SHORT), single(0x1002, LONG), single(0x1003, 5), single(0x1004, DOUBLE)];
  await assertAccepted(buildTiff(nearlyFull(1, rest)), "single values");
});

test("tiff: UNDEFINED tags are views of the file, not copies, and are not counted", async () => {
  await assertAccepted(buildTiff({ ifd0: manyEntries(1, 7, 5_000_000), dataBytes: 16 }), "UNDEFINED");
});

// Element size by TIFF value type, for the types whose values are copied.
const COPIED_TYPES: ReadonlyArray<readonly [type: number, size: number]> = [
  [2, 1], [3, 2], [4, 4], [5, 8], [6, 1], [8, 2], [9, 4], [10, 8], [11, 4], [12, 8], [13, 4],
];

for (const [type, size] of COPIED_TYPES) {
  test(`tiff: type ${type} counts ${size} byte(s) per value against the 4 MiB tag cap`, async () => {
    const count = MIB4 / size;
    await assertAccepted(buildTiff({ ifd0: manyEntries(1, type, count), dataBytes: MIB4 }), "at the cap");
    await assertLimit(buildTiff({ ifd0: manyEntries(1, type, count + 1), dataBytes: MIB4 }), "over the cap");
  });
}

// Types whose element size is 4 or less: the values that fit the 4-byte value field are inline, the field is no offset.
const INLINE_TYPES = COPIED_TYPES.concat([[1, 1], [7, 1]]).filter(([, size]) => size <= 4);

for (const [type, size] of INLINE_TYPES) {
  test(`tiff: type ${type} values that fit the 4-byte field are inline, so its field is not checked as an offset`, async () => {
    const inline: Entry = { tag: 0x1000, type, count: Math.floor(4 / size), value: 0xffff_ffff };
    await assertLimit(buildTiff({ ifd0: [inline, SENTINEL], dataBytes: 16 }), "walk continues");
  });
}

for (const [type, size] of [[1, 1], [7, 1], ...COPIED_TYPES] as const) {
  test(`tiff: type ${type} values that do not fit the 4-byte field point outside the data, which ends the IFD`, async () => {
    const outside: Entry = { tag: 0x1000, type, count: Math.floor(4 / size) + 1, value: 0xffff_ffff };
    await assertAccepted(buildTiff({ ifd0: [outside, SENTINEL], dataBytes: 16 }), "walk ends");
  });
}

test("tiff: an entry of type 0 or above 13 ends the walk of its IFD, as exifr throws there", async () => {
  for (const type of [0, 14]) {
    const bad: Entry = { tag: 0x1000, type, count: 2, value: 0 };
    await assertAccepted(buildTiff({ ifd0: [bad, SENTINEL], dataBytes: 16 }), `type ${type}`);
  }
});

test("tiff: entries of type 1 and type 13 do not end the walk of their IFD", async () => {
  for (const type of [BYTE, 13]) {
    const fine: Entry = { tag: 0x1000, type, count: 1, value: 0 };
    await assertLimit(buildTiff({ ifd0: [fine, SENTINEL], dataBytes: 16 }), `type ${type}`);
  }
});

test("tiff: a value offset past the end of the data ends the walk, one at the very end does not", async () => {
  const entry = (value: number): Entry => ({ tag: 0x1000, type: SHORT, count: 3, value });
  const length = tiffLength({ ifd0: [entry(0), SENTINEL], dataBytes: 16 });
  await assertLimit(buildTiff({ ifd0: [entry(length), SENTINEL], dataBytes: 16 }), "offset at the end");
  await assertAccepted(buildTiff({ ifd0: [entry(length + 1), SENTINEL], dataBytes: 16 }), "offset past the end");
});

/** A little-endian TIFF header, an IFD0 at 8 that declares `declared` entries, then the given bytes. */
function rawTiff(declared: number, after: readonly number[]): Uint8Array {
  return Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, declared & 0xff, declared >> 8, ...after]);
}

/** One ASCII entry of 5 million bytes (over the tag cap) whose value field is the last four bytes of the data. */
const EXACT_END = (): Uint8Array => rawTiff(1, [0x00, 0x10, 2, 0, 0x40, 0x4b, 0x4c, 0, 0, 0, 0, 0]);

test("tiff: an entry whose value field is the last four bytes of the data is read", async () => {
  await assertLimit(EXACT_END(), "exact end");
});

test("tiff: an entry cut off inside its value field or inside its count ends the walk without a limit", async () => {
  await assertAccepted(rawTiff(1, [0x00, 0x10, 2, 0, 0x40, 0x4b, 0x4c, 0]), "no value field");
  // The cut entry is an Exif pointer: with no count to read it must not be taken for a malformed one.
  await assertAccepted(rawTiff(1, [0x69, 0x87, 4, 0]), "no count");
});

test("tiff: an IFD0 offset below 8 points into the header and is not walked", async () => {
  const withOffset = (offset: number): Uint8Array => {
    const bytes = new Uint8Array(16);
    bytes.set([0x49, 0x49, 0x2a, 0x00, offset, 0, 0, 0, 0xff, 0xff]);
    return bytes;
  };
  await assertAccepted(withOffset(0), "offset 0");
  await assertAccepted(withOffset(7), "offset 7");
  await assertLimit(withOffset(8), "offset 8 is the first valid one");
});

test("tiff: data that ends before or right after the entry count is not read past its end", async () => {
  // 8 bytes: the IFD0 offset points at the end. 9 bytes: half an entry count. 10 bytes: a whole one.
  await assertAccepted(rawTiff(0, []).subarray(0, 8), "8 bytes");
  await assertAccepted(rawTiff(0xff, []).subarray(0, 9), "9 bytes");
  await assertLimit(rawTiff(0xffff, []), "10 bytes");
});

test("tiff: a big-endian file is read big-endian", async () => {
  await assertLimit(buildTiff({ bigEndian: true, ifd0: manyEntries(4000, LONG, 100_000), dataBytes: 400_000 }), "MM");
});

test("jpeg: a TIFF header whose byte order mark is neither II nor MM is read big-endian, as exifr reads it", async () => {
  const tiff = buildTiff({ bigEndian: true, ifd0: manyEntries(1, ASCII, 5_000_000), dataBytes: 16 });
  tiff[0] = 0;
  tiff[1] = 0;
  await assertLimit(jpegWithTiff(tiff), "unknown mark");
});

// Pointer tags. The pointer entry is the first of IFD0, at offset 10: type at 12, count at 14, value field at 18.
const POINTER_TYPE_AT = 12;
const POINTER_COUNT_AT = 14;
const POINTER_VALUE_AT = 18;

test("tiff: a SHORT Exif pointer is the first two bytes of its field and nothing after them", async () => {
  const tiff = buildTiff({ ifd0: [], exif: manyEntries(5000, SHORT, 1), dataBytes: 16 });
  new DataView(tiff.buffer).setUint16(POINTER_TYPE_AT, SHORT, true);
  tiff.fill(0xff, POINTER_VALUE_AT + 2, POINTER_VALUE_AT + 4);
  await assertLimit(tiff, "SHORT pointer");
});

test("tiff: an Exif pointer of the IFD type is a single LONG and is followed", async () => {
  const tiff = buildTiff({ ifd0: [], exif: manyEntries(5000, SHORT, 1), dataBytes: 16 });
  new DataView(tiff.buffer).setUint16(POINTER_TYPE_AT, 13, true);
  await assertLimit(tiff, "IFD pointer");
});

test("tiff: an Exif pointer of 64 KiB or more is read as a whole LONG", async () => {
  const tiff = new Uint8Array(70_000 + 2 + 4);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 1, 0]);
  view.setUint16(10, 0x8769, true);
  view.setUint16(12, LONG, true);
  view.setUint32(14, 1, true);
  view.setUint32(18, 70_000, true);
  view.setUint16(70_000, 5000, true);
  await assertLimit(tiff, "LONG pointer above 64 KiB");
});

test("tiff: an Exif or GPS pointer with more than one value is refused, whatever its type", async () => {
  for (const type of [SHORT, LONG]) {
    for (const tag of [0x8769, 0x8825]) {
      const tiff = buildTiff({ ifd0: [{ tag, type, count: 2, value: 0 }], dataBytes: 16 });
      await assert.rejects(parseBytes(tiff), MalformedDocumentError, `tag ${tag.toString(16)} type ${type}`);
    }
  }
});

test("tiff: a GPS pointer that is not a single SHORT or LONG is refused", async () => {
  const tiff = buildTiff({ ifd0: [{ tag: 0x8825, type: ASCII, count: 2, value: 0 }], dataBytes: 16 });
  await assert.rejects(parseBytes(tiff), MalformedDocumentError);
});

test("tiff: the first bad pointer is the one reported", async () => {
  const tiff = buildTiff({
    ifd0: [
      { tag: 0x8769, type: ASCII, count: 2, value: 0 },
      { tag: 0x8825, type: ASCII, count: 2, value: 0 },
    ],
    dataBytes: 16,
  });
  await assert.rejects(parseBytes(tiff), { name: "MalformedDocumentError", message: /0x8769/ });
});

test("tiff: pointer tags inside the Exif and GPS IFDs are not followed by exifr, so are not checked", async () => {
  const bad = (tag: number): Entry => ({ tag, type: ASCII, count: 2, value: 0 });
  await assertAccepted(buildTiff({ ifd0: [], exif: [bad(0x8825)], dataBytes: 16 }), "in the Exif IFD");
  await assertAccepted(buildTiff({ ifd0: [], gps: [bad(0x8769)], dataBytes: 16 }), "in the GPS IFD");
});

// JPEG: which segments the scan steps over, which it reads.
const HOSTILE = (): Uint8Array => buildTiff({ ifd0: manyEntries(1, ASCII, 5_000_000), dataBytes: 16 });

function segment(marker: number, payload: readonly number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0];

function jpeg(...parts: readonly (readonly number[])[]): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...parts.flat(), 0xff, 0xd9]);
}

test("jpeg: an Exif segment after other segments is found", async () => {
  const jfif = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  await assertLimit(jpeg(jfif, segment(0xe1, [...EXIF_HEADER, ...HOSTILE()])), "after JFIF");
});

for (const marker of [0xe0, 0xe1, 0xe2, 0xef, 0xc0, 0xc2, 0xc4, 0xdb, 0xdd, 0xfe]) {
  test(`jpeg: an Exif segment inside the data of a 0x${marker.toString(16)} segment is stepped over, as exifr does`, async () => {
    const inner = segment(0xe1, [...EXIF_HEADER, ...HOSTILE()]);
    await assertAccepted(jpeg(segment(marker, [0, 0, ...inner])), "inside");
  });
}

for (const marker of [0xe0, 0xe2, 0xef]) {
  test(`jpeg: Exif data at the start of a 0x${marker.toString(16)} segment is not an Exif segment`, async () => {
    await assertAccepted(jpeg(segment(marker, [...EXIF_HEADER, ...HOSTILE()])), "other APPn");
  });
}

test("jpeg: nothing after the start of scan is read", async () => {
  await assertAccepted(jpeg(segment(0xda, []), segment(0xe1, [...EXIF_HEADER, ...HOSTILE()])), "after SOS");
});

test("jpeg: an APP1 segment is Exif only when 'Exif' and two zero bytes follow its length", async () => {
  const header = (...bytes: number[]): number[] => segment(0xe1, [...bytes, ...HOSTILE()]);
  await assertAccepted(jpeg(header(0x45, 0x78, 0x69, 0x67, 0, 0)), "Exig");
  await assertAccepted(jpeg(header(0x45, 0x78, 0x69, 0x66, 0, 1)), "Exif then 0 1");
  await assertLimit(jpeg(header(...EXIF_HEADER)), "Exif then 0 0");
});

test("jpeg: data that ends inside a segment header is not read past its end", async () => {
  await assertAccepted(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00), "cut inside the length");
});

test("jpeg: an Exif segment that ends exactly at the end of the data is read to its last byte", async () => {
  const exact = Uint8Array.from([0xff, 0xd8, ...segment(0xe1, [...EXIF_HEADER, ...EXACT_END()])]);
  await assertLimit(exact, "exact end");
});

test("jpeg: an Exif segment that declares more bytes than the data has is read as far as the data goes", async () => {
  const cut = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, ...EXIF_HEADER, ...rawTiff(255, [0, 0x10, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1])]);
  await assertAccepted(cut, "length past the data");
});

// PNG: which chunks are eXIf.
test("png: an eXIf chunk is found by its name in any letter case", async () => {
  for (const name of ["eXIf", "EXIF", "exif"]) {
    await assertLimit(pngWithTiff(HOSTILE(), name), name);
  }
});

test("png: a chunk that differs from eXIf in any one letter is not an Exif chunk", async () => {
  for (const name of ["zXIf", "eZIf", "eXZf", "eXIz"]) {
    await assertAccepted(pngWithTiff(HOSTILE(), name), name);
  }
});

test("png: an eXIf chunk that ends exactly at the end of its data is read to its last byte", async () => {
  await assertLimit(pngWithTiff(EXACT_END()), "exact end");
});

test("png: an eXIf chunk that declares more bytes than the data has is read as far as the data goes", async () => {
  const tiff = rawTiff(255, [0, 0x10, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0xff, 0xff, 0xff, 0x65, 0x58, 0x49, 0x66,
    ...tiff,
  ]);
  await assertAccepted(bytes, "size past the data");
});

test("image: IPTC is still extracted, so the options the guard assumes are the ones exifr runs with", async () => {
  const text = [...new TextEncoder().encode("a caption")];
  const payload = [
    ...new TextEncoder().encode("Photoshop 3.0\0"),
    ...new TextEncoder().encode("8BIM"),
    0x04, 0x04, 0, 0, 0, 0, 0, 0, 0, text.length + 5,
    0x1c, 0x02, 0x78, 0, text.length, ...text,
  ];
  const metadata = await parseBytes(jpeg(segment(0xed, payload)));
  assert.equal(metadata.get("exif:Caption"), "a caption");
});

test("image: Exif and GPS tags are extracted, and XMP and ICC are not (the options the guard assumes)", async () => {
  const exifTiff = buildTiff({
    ifd0: [],
    exif: [{ tag: 0x8827, type: SHORT, count: 1, value: 400 }],
    gps: [{ tag: 0x0001, type: ASCII, count: 2, value: 0x4e }],
    dataBytes: 16,
  });
  const exif = await parseBytes(jpeg(segment(0xe1, [...EXIF_HEADER, ...exifTiff])));
  assert.equal(exif.get("exif:ISO"), "400");
  assert.equal(exif.get("exif:GPSLatitudeRef"), "N");

  const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="a tool"/></rdf:RDF></x:xmpmeta>`;
  const withXmp = await parseBytes(jpeg(segment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/\0"), ...ascii(xmp)])));
  assert.equal(withXmp.get("exif:CreatorTool"), null);

  const profile = new Array<number>(132).fill(0);
  profile.splice(3, 1, 132);
  profile.splice(12, 12, ...ascii("mntr"), ...ascii("RGB "), ...ascii("XYZ "));
  profile.splice(36, 4, ...ascii("acsp"));
  const withIcc = await parseBytes(jpeg(segment(0xe2, [...ascii("ICC_PROFILE\0"), 1, 1, ...profile])));
  assert.equal(withIcc.get("exif:ProfileClass"), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// HEIF: how the Exif item is found. Each knob is a structure a real writer produces and exifr reads.
// ---------------------------------------------------------------------------------------------------------------------

interface HeicSpec {
  readonly tiff: Uint8Array;
  readonly infeVersion?: 2 | 3;
  readonly ilocVersion?: 0 | 1 | 2;
  readonly offsetSize?: 1 | 2 | 4 | 8;
  /** 0 and 5 are sizes exifr cannot read, which leaves it without a length. */
  readonly lengthSize?: 0 | 1 | 2 | 4 | 5 | 8;
  readonly baseOffsetSize?: 0 | 4;
  /** Bytes of extent index (iloc version 1 and 2 only). */
  readonly indexSize?: 0 | 4;
  /** A first, non-Exif item (id 1, two extents) so the Exif item is the second, id 2. */
  readonly decoy?: boolean;
  /** `mdat` before `meta`, so offsets are small. */
  readonly mdatFirst?: boolean;
  readonly largeMeta?: boolean;
  readonly largeMdat?: boolean;
  /** The item count iinf declares, when not the number of items it holds. */
  readonly iinfCount?: number;
  /** A second `iinf` and `iloc` that list nothing, after the real ones. */
  readonly duplicates?: boolean;
  /** A second item of type Exif, after the real one, that iloc does not place. */
  readonly secondExif?: boolean;
  /** `iloc` before `iinf` in `meta`, so the last bytes of the file are an item entry. */
  readonly iinfLast?: boolean;
  /** Stray bytes at the end of `meta`, too few to be a box. */
  readonly trailingJunk?: number;
  /** Bytes in front of the whole file (a box that is skipped as the first). */
  readonly prefix?: readonly number[];
  /** Bytes the extent claims beyond the item. */
  readonly lengthPad?: number;
  /** Boxes between `ftyp` and the next box. */
  readonly afterFtyp?: readonly number[];
}

const be = (value: number, size: number): number[] =>
  Array.from({ length: size }, (_, index) => Number((BigInt(value) >> BigInt(8 * (size - 1 - index))) & 0xffn));

function heicVariant(spec: HeicSpec): Uint8Array {
  const infeVersion = spec.infeVersion ?? 2;
  const ilocVersion = spec.ilocVersion ?? 0;
  const offsetSize = spec.offsetSize ?? 4;
  const lengthSize = spec.lengthSize ?? 4;
  const baseOffsetSize = spec.baseOffsetSize ?? 0;
  const indexSize = ilocVersion > 0 ? (spec.indexSize ?? 0) : 0;
  const idSize = infeVersion === 3 ? 4 : 2;
  const exifId = spec.decoy === true ? 2 : 1;
  const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];
  const wide = (type: string, payload: readonly number[]): number[] => [
    ...be(1, 4), ...ascii(type), ...be(16 + payload.length, 8), ...payload,
  ];

  const infe = (id: number, type: string): number[] =>
    isoBox("infe", [infeVersion, 0, 0, 0, ...be(id, idSize), 0, 0, ...ascii(type), 0]);
  const infes = [
    ...(spec.decoy === true ? [infe(1, "hvc1")] : []),
    infe(exifId, "Exif"),
    ...(spec.secondExif === true ? [infe(exifId + 1, "Exif")] : []),
  ];
  const iinf = isoBox("iinf", [0, 0, 0, 0, ...be(spec.iinfCount ?? infes.length, 2), ...infes.flat()]);

  const item = [0, 0, 0, 6, ...ascii("Exif"), 0, 0, ...spec.tiff];
  const iloc = (itemOffset: number): number[] => {
    const extent = (offset: number, length: number): number[] => [
      ...be(0, indexSize), ...be(offset, offsetSize), ...be(length, lengthSize),
    ];
    const entry = (id: number, extents: number[][]): number[] => [
      ...be(id, ilocVersion === 2 ? 4 : 2),
      ...(ilocVersion > 0 ? [0, 0] : []),
      0, 0,
      ...be(0, baseOffsetSize),
      ...be(extents.length, 2),
      ...extents.flat(),
    ];
    const entries = [
      ...(spec.decoy === true ? [entry(1, [extent(0, 0), extent(0, 0)])] : []),
      entry(exifId, [extent(itemOffset, item.length + (spec.lengthPad ?? 0))]),
    ];
    return isoBox("iloc", [
      ilocVersion, 0, 0, 0,
      (offsetSize << 4) | lengthSize,
      (baseOffsetSize << 4) | indexSize,
      ...be(entries.length, ilocVersion === 2 ? 4 : 2),
      ...entries.flat(),
    ]);
  };
  const emptyIinf = isoBox("iinf", [0, 0, 0, 0, 0, 0]);
  const emptyIloc = isoBox("iloc", [0, 0, 0, 0, 0x44, 0x00, 0, 0]);

  const ftyp = isoBox("ftyp", [0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x68, 0x65, 0x69, 0x63]);
  const prefix = [...(spec.prefix ?? [])];
  const between = [...(spec.afterFtyp ?? [])];
  const mdat = (): number[] => (spec.largeMdat === true ? wide("mdat", item) : isoBox("mdat", item));
  const mdatHeader = spec.largeMdat === true ? 16 : 8;
  const meta = (itemOffset: number): number[] => {
    const real = [iinf, iloc(itemOffset)];
    if (spec.iinfLast === true) real.reverse();
    const duplicates = spec.duplicates === true ? [emptyIinf, emptyIloc] : [];
    const junk = new Array<number>(spec.trailingJunk ?? 0).fill(0xaa);
    const payload = [0, 0, 0, 0, ...real.flat(), ...duplicates.flat(), ...junk];
    return spec.largeMeta === true ? wide("meta", payload.slice(0)) : isoBox("meta", payload);
  };
  const metaLength = meta(0).length;
  const itemOffset = spec.mdatFirst === true
    ? prefix.length + ftyp.length + between.length + mdatHeader
    : prefix.length + ftyp.length + between.length + metaLength + mdatHeader;
  const body = spec.mdatFirst === true
    ? [...ftyp, ...between, ...mdat(), ...meta(itemOffset)]
    : [...ftyp, ...between, ...meta(itemOffset), ...mdat()];
  return Uint8Array.from([...prefix, ...body]);
}

test("heic: the builder's plain variant is read (control for the variants below)", async () => {
  await assertLimit(heicVariant({ tiff: HOSTILE() }), "plain");
});

const HEIC_VARIANTS: ReadonlyArray<readonly [string, Omit<HeicSpec, "tiff">]> = [
  ["a version 3 infe, with a 4-byte item id", { infeVersion: 3 }],
  ["a version 3 infe after another item", { infeVersion: 3, decoy: true }],
  ["the Exif item after another item", { decoy: true }],
  ["a base offset in iloc", { decoy: true, baseOffsetSize: 4 }],
  ["iloc version 1", { decoy: true, ilocVersion: 1 }],
  ["iloc version 1 with an extent index", { decoy: true, ilocVersion: 1, indexSize: 4 }],
  ["iloc version 2 (4-byte ids and counts)", { decoy: true, ilocVersion: 2 }],
  ["iloc version 2 with an index and a base offset", { decoy: true, ilocVersion: 2, indexSize: 4, baseOffsetSize: 4 }],
  ["an 8-byte offset and a 2-byte length", { decoy: true, offsetSize: 8, lengthSize: 2 }],
  ["a 2-byte offset and an 8-byte length", { decoy: true, offsetSize: 2, lengthSize: 8 }],
  ["1-byte offset and length", { decoy: true, mdatFirst: true, offsetSize: 1, lengthSize: 1 }],
  ["mdat before meta", { mdatFirst: true }],
  ["an 8-byte length that is the last thing in the file", { mdatFirst: true, lengthSize: 8 }],
  ["a 64-bit box size on meta", { largeMeta: true }],
  ["a 64-bit box size on mdat", { largeMdat: true, mdatFirst: true }],
  ["a second iinf and iloc that list nothing", { duplicates: true }],
  ["a second Exif item that iloc does not place", { decoy: true, secondExif: true }],
  ["stray bytes at the end of meta", { mdatFirst: true, trailingJunk: 6 }],
];

for (const [label, spec] of HEIC_VARIANTS) {
  test(`heic: the Exif item is found with ${label}`, async () => {
    await assertLimit(heicVariant({ tiff: HOSTILE(), ...spec }), label);
  });
}

test("heic: a first box is skipped whatever its type", async () => {
  const bogusMeta = isoBox("meta", [0, 0, 0, 0]);
  await assertLimit(heicVariant({ tiff: HOSTILE(), prefix: bogusMeta }), "first box is a meta");
});

test("heic: only as many items as iinf declares are read", async () => {
  await assertAccepted(heicVariant({ tiff: HOSTILE(), decoy: true, iinfCount: 1 }), "count 1, Exif second");
});

test("heic: an Exif item entry cut off right after its type is still read", async () => {
  const whole = heicVariant({ tiff: HOSTILE(), decoy: true, mdatFirst: true, iinfLast: true });
  // The last byte is the infe's name terminator: dropping it leaves the type as the last four bytes.
  await assertLimit(whole.subarray(0, whole.length - 1), "cut after the type");
});

test("heic: an Exif item that ends exactly at the end of the data is read to its last byte", async () => {
  await assertLimit(heicVariant({ tiff: EXACT_END() }), "exact end");
});

test("heic: an Exif item whose extent is longer than the data is read as far as the data goes", async () => {
  const tiff = rawTiff(255, [0, 0x10, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
  await assertAccepted(heicVariant({ tiff, lengthPad: 1000 }), "extent past the data");
});

test("heic: a 64-bit box size is read as exifr reads it, as its high and low words OR-ed together", async () => {
  // exifr evaluates `(high << 32) | low` in 32-bit arithmetic, so high 1 and low 18 is a box of 19 bytes (16 of header
  // and 3 of payload), not 2^32 + 18 and not 18.
  const free = [0, 0, 0, 1, ...new TextEncoder().encode("free"), 0, 0, 0, 1, 0, 0, 0, 18, 0, 0, 0];
  await assertLimit(heicVariant({ tiff: HOSTILE(), afterFtyp: free }), "64-bit size of 1 and 18");
});

// exifr gives a segment `size || 65536` bytes (parser.mjs `ensureSegmentChunk`) and `length || (to the end)` for a HEIF
// item (`BufferView.subarray`), so a size of zero is not an empty segment but a wide one. These tests are what the
// hostile tags look like when they sit in that window. 4000 tags x 3000 LONGs fit the 64 KiB window of the tags'
// values; the file is larger than the window, which exifr requires.
const WINDOWED = (): Uint8Array =>
  buildTiff({ ifd0: manyEntries(4000, LONG, 3000), dataBytes: 20_000 });

test("jpeg: an Exif segment that declares only its header is a 64 KiB window for exifr, which is walked", async () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, ...EXIF_HEADER, ...WINDOWED()]);
  await assertRejectedBeforeAllocating(bytes, "APP1 of size 0");
});

test("png: an eXIf chunk of size 0 is a 64 KiB window for exifr, which is walked", async () => {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x65, 0x58, 0x49, 0x66];
  await assertRejectedBeforeAllocating(Uint8Array.from([...header, ...WINDOWED()]), "eXIf of size 0");
});

test("heic: an Exif extent whose length exifr cannot read, or that has nothing after the name, runs to the end", async () => {
  const tiff = WINDOWED();
  await assertRejectedBeforeAllocating(heicVariant({ tiff, lengthSize: 0 }), "no length");
  await assertRejectedBeforeAllocating(heicVariant({ tiff, lengthSize: 5 }), "unreadable length");
  await assertRejectedBeforeAllocating(heicVariant({ tiff, lengthPad: -tiff.length }), "length equal to the name");
});

/** A TIFF with one over-the-cap ASCII entry whose 12 bytes end `endsAt` bytes after the TIFF header's start. */
function tiffWithEntryEndingAt(endsAt: number): Uint8Array {
  const bytes = new Uint8Array(65_536 + 100);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49, 0x2a, 0x00]);
  view.setUint32(4, endsAt - 14, true);
  view.setUint16(endsAt - 14, 1, true);
  view.setUint16(endsAt - 12, 0x1000, true);
  view.setUint16(endsAt - 10, ASCII, true);
  view.setUint32(endsAt - 8, 5_000_000, true);
  return bytes;
}

test("jpeg: the 64 KiB window of an Exif segment of size 0 ends exactly at 65536 bytes", async () => {
  const jpegOf = (tiff: Uint8Array): Uint8Array =>
    Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, ...EXIF_HEADER, ...tiff]);
  await assertLimit(jpegOf(tiffWithEntryEndingAt(65_536)), "entry ends at the window's end");
  await assertAccepted(jpegOf(tiffWithEntryEndingAt(65_537)), "entry ends one byte past it");
});

test("png: the 64 KiB window of an eXIf chunk of size 0 ends exactly at 65536 bytes", async () => {
  const pngOf = (tiff: Uint8Array): Uint8Array =>
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x65, 0x58, 0x49, 0x66, ...tiff]);
  await assertLimit(pngOf(tiffWithEntryEndingAt(65_536)), "entry ends at the window's end");
  await assertAccepted(pngOf(tiffWithEntryEndingAt(65_537)), "entry ends one byte past it");
});

test("heic: an Exif extent shorter than the bytes before the TIFF is not read to the end", async () => {
  const tiff = WINDOWED();
  await assertAccepted(heicVariant({ tiff, lengthPad: -tiff.length - 1 }), "length below the name");
});

// The Interop IFD: `tiff: true` makes exifr parse it (behind the 0xA005 pointer of IFD0 or of the Exif IFD).
const HOSTILE_IFD = (): TiffSpec => ({ ifd0: [], gps: manyEntries(4000, LONG, 100), dataBytes: 20_000 });

/** Where the GPS IFD of a `buildTiff({ ifd0: [], gps })` starts: the value of its one IFD0 entry (at 10). */
const gpsOffsetOf = (tiff: Uint8Array): number => new DataView(tiff.buffer).getUint32(18, true);

test("tiff: an Interop IFD behind IFD0's pointer is walked", async () => {
  const tiff = buildTiff(HOSTILE_IFD());
  new DataView(tiff.buffer).setUint16(10, 0xa005, true); // the GPS pointer becomes an Interop pointer
  await assertRejectedBeforeAllocating(tiff, "Interop from IFD0");
});

test("tiff: an Interop IFD behind the Exif IFD's pointer is walked", async () => {
  const tiff = buildTiff({ ...HOSTILE_IFD(), exif: [{ tag: 0xa005, type: LONG, count: 1, value: 0 }] });
  const view = new DataView(tiff.buffer);
  const gps = view.getUint32(30, true); // IFD0's second entry, at 22, is the GPS pointer
  view.setUint16(22, 0x1234, true); // made inert, so the GPS IFD is reached only as the Interop IFD
  view.setUint32(48, gps, true); // the Exif IFD's one entry, at 40
  await assertRejectedBeforeAllocating(tiff, "Interop from the Exif IFD");
});

test("tiff: an Interop pointer that is not a single SHORT or LONG is refused, in IFD0 and in the Exif IFD", async () => {
  const bad = { tag: 0xa005, type: ASCII, count: 2, value: 0 };
  await assert.rejects(parseBytes(buildTiff({ ifd0: [bad], dataBytes: 16 })), MalformedDocumentError, "IFD0");
  await assert.rejects(parseBytes(buildTiff({ ifd0: [], exif: [bad], dataBytes: 16 })), MalformedDocumentError, "Exif");
});

test("tiff: an Interop pointer inside the GPS or Interop IFD is not followed, so is not checked", async () => {
  const bad: Entry = { tag: 0xa005, type: ASCII, count: 2, value: 0 };
  await assertAccepted(buildTiff({ ifd0: [], gps: [bad], dataBytes: 16 }), "in the GPS IFD");
});

test("tiff: an Interop pointer inside the Interop IFD is not followed, so is not checked", async () => {
  const tiff = buildTiff({ ifd0: [], gps: [{ tag: 0xa005, type: ASCII, count: 2, value: 0 }], dataBytes: 16 });
  new DataView(tiff.buffer).setUint16(10, 0xa005, true); // the GPS IFD is reached only as the Interop IFD
  await assertAccepted(tiff, "in the Interop IFD");
});

test("tiff: when IFD0 points at an Exif IFD twice, the last pointer is the one exifr follows", async () => {
  const exifOffset = 8 + 2 + 3 * 12 + 4; // IFD0 will hold three entries
  const tiff = buildTiff({
    ifd0: [{ tag: 0x8769, type: LONG, count: 1, value: exifOffset }],
    exif: [],
    gps: manyEntries(4000, LONG, 100),
    dataBytes: 20_000,
  });
  new DataView(tiff.buffer).setUint16(8 + 2 + 2 * 12, 0x8769, true); // the GPS pointer, third, becomes a second Exif pointer
  await assertRejectedBeforeAllocating(tiff, "second Exif pointer");
});

test("heic: an iloc with an extent index and a 4-byte length is read from the length field", async () => {
  await assertRejectedBeforeAllocating(
    heicVariant({ ilocVersion: 1, indexSize: 4, mdatFirst: true, tiff: WINDOWED() }),
    "iloc version 1 with an extent index",
  );
});

test("tiff: the thumbnail IFD behind IFD0 is not parsed by exifr, so allocates nothing", async () => {
  const tiff = buildTiff(HOSTILE_IFD());
  const view = new DataView(tiff.buffer);
  view.setUint32(22, gpsOffsetOf(tiff), true); // the next-IFD offset after IFD0's one entry
  view.setUint16(10, 0x1234, true); // the GPS pointer made inert
  const { elements, error } = await countTypedArrayElements(() => parseBytes(tiff));
  assert.equal(error, undefined);
  assert.equal(elements, 0);
});
