import { open, type FileHandle } from "node:fs/promises";
import { MediaType } from "@spikedpunch/ripstream-core";
import type { RipstreamInputStream } from "@spikedpunch/ripstream-core";

const BPLIST = MediaType.parse("application/x-bplist") as MediaType;
const MEMGRAPH = MediaType.parse("application/x-bplist-memgraph") as MediaType;
const WEBARCHIVE = MediaType.parse("application/x-bplist-webarchive") as MediaType;
const ITUNES = MediaType.parse("application/x-bplist-itunes") as MediaType;

const TRAILER_BYTES = 32;
/** A root dictionary of a real document has a handful of keys; past this the walk is not worth the reads. */
const MAX_ROOT_KEYS = 4096;
/** The longest key Tika's rules look for is 20 characters. */
const MAX_KEY_CHARS = 64;

/**
 * Port of Tika 4.2.0's `BPListDetector`: a binary plist whose root is a dictionary is named by the keys it holds
 * (`nodes`+`edges`+`graphEncodingVersion` is a memory graph, `WebMainResource` a web archive, `Playlists`+`Tracks`+
 * `Music Folder` an iTunes library), any other binary plist is `application/x-bplist`. Reads only the trailer, the
 * offset-table entries it needs and the key strings, each bounded by the file size; null when the file is not a
 * readable binary plist (Tika throws there).
 */
export async function detectBplist(stream: RipstreamInputStream): Promise<MediaType | null> {
  const handle = await open(await stream.getFile(), "r");
  try {
    const keys = await readRootKeys(handle);
    return keys === null ? null : typeByKeys(keys);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function typeByKeys(keys: ReadonlySet<string> | "not-a-dictionary"): MediaType {
  if (keys === "not-a-dictionary") return BPLIST;
  if (keys.has("nodes") && keys.has("edges") && keys.has("graphEncodingVersion")) return MEMGRAPH;
  if (keys.has("WebMainResource")) return WEBARCHIVE;
  if (keys.has("Playlists") && keys.has("Tracks") && keys.has("Music Folder")) return ITUNES;
  return BPLIST;
}

async function readRootKeys(handle: FileHandle): Promise<ReadonlySet<string> | "not-a-dictionary" | null> {
  const size = (await handle.stat()).size;
  if (size < 8 + TRAILER_BYTES) return null;

  const trailer = await readAt(handle, size - TRAILER_BYTES, TRAILER_BYTES);
  if (trailer === null) return null;
  const offsetSize = trailer[6]!;
  const refSize = trailer[7]!;
  const objectCount = readBigEndian(trailer, 8, 8);
  const topObject = readBigEndian(trailer, 16, 8);
  const tableOffset = readBigEndian(trailer, 24, 8);
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) return null;
  if (topObject >= objectCount || tableOffset + objectCount * offsetSize > size - TRAILER_BYTES) return null;

  const objectOffset = async (index: number): Promise<number | null> => {
    if (index >= objectCount) return null;
    const entry = await readAt(handle, tableOffset + index * offsetSize, offsetSize);
    if (entry === null) return null;
    const offset = readBigEndian(entry, 0, offsetSize);
    return offset < size - TRAILER_BYTES ? offset : null;
  };

  const rootOffset = await objectOffset(topObject);
  if (rootOffset === null) return null;
  const root = await readMarker(handle, rootOffset);
  if (root === null) return null;
  if (root.type !== 0xd) return "not-a-dictionary";
  if (root.count > MAX_ROOT_KEYS) return null;

  const refs = await readAt(handle, root.dataOffset, root.count * refSize);
  if (refs === null) return null;
  const keys = new Set<string>();
  for (let index = 0; index < root.count; index++) {
    const keyOffset = await objectOffset(readBigEndian(refs, index * refSize, refSize));
    if (keyOffset === null) return null;
    const key = await readString(handle, keyOffset);
    if (key !== null) keys.add(key);
  }
  return keys;
}

interface Marker {
  readonly type: number;
  readonly count: number;
  readonly dataOffset: number;
}

/** An object's type nibble and its length or entry count, which the low nibble holds up to 14 and an int object beyond. */
async function readMarker(handle: FileHandle, offset: number): Promise<Marker | null> {
  const first = await readAt(handle, offset, 1);
  if (first === null) return null;
  const type = first[0]! >> 4;
  const info = first[0]! & 0x0f;
  if (info !== 0x0f) return { type, count: info, dataOffset: offset + 1 };

  const intMarker = await readAt(handle, offset + 1, 1);
  if (intMarker === null || intMarker[0]! >> 4 !== 0x1) return null;
  const width = 2 ** (intMarker[0]! & 0x0f);
  if (width > 8) return null;
  const value = await readAt(handle, offset + 2, width);
  if (value === null) return null;
  return { type, count: readBigEndian(value, 0, width), dataOffset: offset + 2 + width };
}

/** An ASCII (0x5), UTF-16BE (0x6) or UTF-8 (0x7) string; null for any other object or one too long to be a rule's key. */
async function readString(handle: FileHandle, offset: number): Promise<string | null> {
  const marker = await readMarker(handle, offset);
  if (marker === null || marker.count > MAX_KEY_CHARS) return null;
  if (marker.type === 0x5 || marker.type === 0x7) {
    const bytes = await readAt(handle, marker.dataOffset, marker.count);
    return bytes === null ? null : new TextDecoder("utf-8").decode(bytes);
  }
  if (marker.type === 0x6) {
    const bytes = await readAt(handle, marker.dataOffset, marker.count * 2);
    return bytes === null ? null : new TextDecoder("utf-16be").decode(bytes);
  }
  return null;
}

/** Big-endian unsigned integer of up to 8 bytes; values past 2^53 saturate, which no in-bounds offset or count reaches. */
function readBigEndian(data: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let index = 0; index < width; index++) value = value * 256 + data[offset + index]!;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

/** Exactly `length` bytes at `offset`, or null when the file ends first or the offset is not a safe position. */
async function readAt(handle: FileHandle, offset: number, length: number): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) return null;
  const buffer = new Uint8Array(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return bytesRead === length ? buffer : null;
}
