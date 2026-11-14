import { open, type FileHandle } from "node:fs/promises";
import { createInflateRaw, crc32 } from "node:zlib";
import { inflateBounded } from "@spikedpunch/ripstream-core";

export interface ZipEntry {
  readonly name: string;
  readonly compression: number;
  readonly compressedSize: number;
  readonly localOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_RECORD = 0x06064b50;
const EOCD_LENGTH = 22;
const ZIP64_LOCATOR_LENGTH = 20;
/** General-purpose bit 11: the writer says the name is UTF-8. */
const UTF8_NAME_FLAG = 0x0800;
/** The Info-ZIP Unicode Path extra field. */
const UNICODE_PATH_FIELD = 0x7075;

/**
 * Detection happens in the caller's process, before any parser limit applies, and the central directory sits at the
 * end of the input where a hostile one can claim millions of entries (a 92 MB file took 20 s and 290 MB to walk).
 * Past either bound the walk stops and the type stays plain `application/zip`; a genuine container is far below both.
 * The entry bound is core's default `maxZipEntries`: a zip over it is refused by the archive parser anyway.
 */
const MAX_DETECT_ENTRIES = 10_000;
const MAX_DETECT_DIRECTORY_BYTES = 8 * 1024 * 1024;

/**
 * A read-only view of a ZIP's central directory, opened once for a whole detection pass. Names are exact and the
 * first of any duplicate wins, as in commons-compress `ZipFile.getEntry`. Every content read is bounded, and the
 * attacker-controlled sizes are checked before anything is read or inflated.
 */
export class ZipArchive {
  readonly entries: readonly ZipEntry[];
  private readonly handle: FileHandle;
  private readonly byName: ReadonlyMap<string, ZipEntry>;

  private constructor(handle: FileHandle, entries: readonly ZipEntry[]) {
    this.handle = handle;
    this.entries = entries;
    const byName = new Map<string, ZipEntry>();
    for (const entry of entries) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
    this.byName = byName;
  }

  /** Null when the file has no readable central directory, or one past the detection bounds. */
  static async open(path: string): Promise<ZipArchive | null> {
    const handle = await open(path, "r");
    try {
      const entries = await readCentralDirectory(handle);
      if (entries === null) {
        await handle.close();
        return null;
      }
      return new ZipArchive(handle, entries);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * The whole entry, or null when it is absent, unreadable, or larger than `maxBytes` compressed or inflated.
   */
  async read(name: string, maxBytes: number): Promise<Uint8Array | null> {
    const entry = this.byName.get(name);
    if (entry === undefined || entry.compressedSize > maxBytes) return null;
    const compressed = await this.readCompressed(entry, entry.compressedSize);
    if (compressed === null) return null;
    if (entry.compression === 0) return compressed;
    if (entry.compression === 8) {
      try {
        return inflateBounded(compressed, "deflate-raw", { maxOutputBytes: maxBytes });
      } catch {
        // A bomb (LimitExceededError) or a corrupt entry reads as absent.
        return null;
      }
    }
    return null;
  }

  /**
   * At most the first `maxBytes` of an entry that may be far larger (an iWork index is tens of MB). Reads only the
   * leading compressed bytes and stops inflating at the cap.
   */
  async readPrefix(name: string, maxBytes: number): Promise<Uint8Array | null> {
    const entry = this.byName.get(name);
    if (entry === undefined) return null;
    const compressed = await this.readCompressed(entry, Math.min(entry.compressedSize, maxBytes));
    if (compressed === null) return null;
    if (entry.compression === 0) return compressed;
    if (entry.compression === 8) return inflatePrefix(compressed, maxBytes);
    return null;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  /** Exactly `length` bytes of the entry's data, or null when the file ends first (a truncated entry is not read short). */
  private async readCompressed(entry: ZipEntry, length: number): Promise<Uint8Array | null> {
    // A ZIP64 extra field can name an offset above 2^53: Number() has already lost precision, and FileHandle.read
    // throws a raw RangeError for it. Detection reads a hostile container as not a container, so the entry is absent.
    if (!Number.isSafeInteger(entry.localOffset) || entry.localOffset < 0) return null;
    const header = await readAt(this.handle, entry.localOffset, 30);
    if (header.length < 30) return null;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, true) !== LOCAL) return null;
    const dataOffset = entry.localOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const data = await readAt(this.handle, dataOffset, length);
    return data.length === length ? data : null;
  }
}

async function readCentralDirectory(handle: FileHandle): Promise<ZipEntry[] | null> {
  const stat = await handle.stat();
  if (stat.size < EOCD_LENGTH) return null;

  const tailLength = Math.min(stat.size, 65_557);
  const tail = await readAt(handle, stat.size - tailLength, tailLength);
  const eocdIndex = findSignatureBackwards(tail, EOCD, EOCD_LENGTH);
  if (eocdIndex === -1) return null;

  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let entryCount = view.getUint16(eocdIndex + 10, true);
  let centralOffset = view.getUint32(eocdIndex + 16, true);

  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    const zip64 = await readZip64(handle, tail, eocdIndex);
    if (zip64 !== null) {
      entryCount = zip64.entryCount;
      centralOffset = zip64.centralOffset;
    }
  }

  if (entryCount > MAX_DETECT_ENTRIES) return null;

  // The directory is read once, bounded; a directory that does not fit, or that ends before `entryCount` entries, is
  // not readable (a partial name list could name the wrong container).
  const directoryLength = Math.max(0, Math.min(MAX_DETECT_DIRECTORY_BYTES, stat.size - centralOffset));
  const directory = await readAt(handle, centralOffset, directoryLength);
  const directoryView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > directory.length) return null;
    if (directoryView.getUint32(cursor, true) !== CENTRAL) return null;

    const flags = directoryView.getUint16(cursor + 8, true);
    const compression = directoryView.getUint16(cursor + 10, true);
    const compressedSize32 = directoryView.getUint32(cursor + 20, true);
    const uncompressedSize32 = directoryView.getUint32(cursor + 24, true);
    const nameLength = directoryView.getUint16(cursor + 28, true);
    const extraLength = directoryView.getUint16(cursor + 30, true);
    const commentLength = directoryView.getUint16(cursor + 32, true);
    const localOffset32 = directoryView.getUint32(cursor + 42, true);

    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > directory.length) return null;

    const sizes = readZip64Extra(directory.subarray(extraStart, extraStart + extraLength), {
      uncompressedSize: uncompressedSize32,
      compressedSize: compressedSize32,
      localOffset: localOffset32,
    });
    entries.push({
      name: memberName(flags, directory.subarray(nameStart, extraStart), directory.subarray(extraStart, extraStart + extraLength)),
      compression,
      compressedSize: sizes.compressedSize,
      localOffset: sizes.localOffset,
    });
    cursor = next;
  }
  return entries;
}

/**
 * A member's name as Tika's commons-compress `ZipFile` reads it: UTF-8, whether or not bit 11 is set (Tika names no
 * other charset, DefaultZipContainerDetector.java:237). A member whose bit 11 is clear may carry an Info-ZIP Unicode
 * Path field, and `ZipFile` takes the name in it when its CRC32 is that of the name bytes in the header. Bit 11 set,
 * and the field is not read.
 */
function memberName(flags: number, headerName: Uint8Array, extra: Uint8Array): string {
  if ((flags & UTF8_NAME_FLAG) === 0) {
    const unicode = readUnicodePath(extra, headerName);
    if (unicode !== null) return unicode;
  }
  return new TextDecoder("utf-8").decode(headerName);
}

/**
 * The name in the last Unicode Path field of `extra` (version 1, CRC32 of the header name, UTF-8 name), or null when
 * there is none or it is not valid for this header name.
 */
function readUnicodePath(extra: Uint8Array, headerName: Uint8Array): string | null {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let name: string | null = null;
  // A hostile extra field repeats the field thousands of times: the header name is hashed once, not once per field.
  let headerCrc: number | null = null;
  for (let position = 0; position + 4 <= extra.length; ) {
    const id = view.getUint16(position, true);
    const size = view.getUint16(position + 2, true);
    const end = position + 4 + size;
    if (end > extra.length) break;
    if (id === UNICODE_PATH_FIELD) {
      const versionOne = size >= 5 && extra[position + 4] === 1;
      if (versionOne) headerCrc ??= crc32(headerName);
      const valid = versionOne && view.getUint32(position + 5, true) === headerCrc;
      name = valid ? new TextDecoder("utf-8").decode(extra.subarray(position + 9, end)) : null;
    }
    position = end;
  }
  return name;
}

/**
 * A member past 4 GiB (or written by a streaming ZIP64 writer, as 3MF packages are) carries 0xFFFFFFFF in the fixed
 * header and the real value in the 0x0001 extra field, in the fixed order: uncompressed size, compressed size, local
 * header offset, each present only when its header field is 0xFFFFFFFF.
 */
function readZip64Extra(
  extra: Uint8Array,
  fixed: { uncompressedSize: number; compressedSize: number; localOffset: number },
): { compressedSize: number; localOffset: number } {
  const result = { compressedSize: fixed.compressedSize, localOffset: fixed.localOffset };
  if (
    fixed.uncompressedSize !== 0xffffffff &&
    fixed.compressedSize !== 0xffffffff &&
    fixed.localOffset !== 0xffffffff
  ) {
    return result;
  }

  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let position = 0; position + 4 <= extra.length; ) {
    const id = view.getUint16(position, true);
    const size = view.getUint16(position + 2, true);
    const end = position + 4 + size;
    if (end > extra.length) break;
    if (id === 0x0001) {
      let cursor = position + 4;
      const next = (): number | null => {
        if (cursor + 8 > end) return null;
        const value = Number(view.getBigUint64(cursor, true));
        cursor += 8;
        return value;
      };
      if (fixed.uncompressedSize === 0xffffffff) next();
      if (fixed.compressedSize === 0xffffffff) result.compressedSize = next() ?? result.compressedSize;
      if (fixed.localOffset === 0xffffffff) result.localOffset = next() ?? result.localOffset;
      break;
    }
    position = end;
  }
  return result;
}

async function readZip64(
  handle: FileHandle,
  tail: Uint8Array,
  eocdIndex: number,
): Promise<{ entryCount: number; centralOffset: number } | null> {
  const locatorIndex = findSignatureBackwards(tail.subarray(0, eocdIndex), ZIP64_LOCATOR, ZIP64_LOCATOR_LENGTH);
  if (locatorIndex === -1) return null;

  const locatorView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const zip64Offset = Number(locatorView.getBigUint64(locatorIndex + 8, true));
  const record = await readAt(handle, zip64Offset, 56);
  if (record.length < 56) return null;

  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  if (view.getUint32(0, true) !== ZIP64_RECORD) return null;
  return {
    entryCount: Number(view.getBigUint64(32, true)),
    centralOffset: Number(view.getBigUint64(48, true)),
  };
}

/** The last index at which `signature` starts with a whole `recordLength`-byte record still inside `data`. */
function findSignatureBackwards(data: Uint8Array, signature: number, recordLength: number): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let index = data.length - recordLength; index >= 0; index--) {
    if (view.getUint32(index, true) === signature) return index;
  }
  return -1;
}

/**
 * Reads at an offset taken from the file, which a hostile one sets anywhere up to 2^64: an offset that is not a safe
 * integer reads nothing, like one past the end, rather than throwing out of detection.
 */
async function readAt(handle: FileHandle, offset: number, length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(offset) || offset < 0) return new Uint8Array();
  const buffer = new Uint8Array(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

/** Inflates the leading bytes of a deflate stream, stopping once `maxBytes` of output exist. */
function inflatePrefix(compressed: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const inflate = createInflateRaw();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      inflate.destroy();
      resolve(new Uint8Array(Buffer.concat(chunks).subarray(0, maxBytes)));
    };
    inflate.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) finish();
    });
    // A truncated compressed prefix ends in an error; what inflated before it is the prefix.
    inflate.on("error", finish);
    inflate.on("end", finish);
    inflate.end(compressed);
  });
}
