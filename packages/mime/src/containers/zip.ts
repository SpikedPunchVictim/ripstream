import { open } from "node:fs/promises";
import { inflateBounded, MediaType } from "@spikedpunch/ripstream-core";
import type { RipstreamInputStream } from "@spikedpunch/ripstream-core";

interface ZipEntry {
  readonly name: string;
  readonly compression: number;
  readonly compressedSize: number;
  readonly localOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
/** A real `mimetype` entry is a short media type string. */
const MAX_MIMETYPE_BYTES = 4096;

/**
 * Port of Ripstream's ZipContainerDetector decision table. Parses the central
 * directory and, for ODF/EPUB, the stored `mimetype` entry.
 */
export async function detectZipContainer(
  stream: RipstreamInputStream,
): Promise<MediaType | null> {
  const entries = await readCentralDirectory(stream);
  if (entries === null) return null;

  const names = new Set(entries.map((entry) => entry.name.replace(/\\/g, "/")));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  const mimetypeEntry = byName.get("mimetype");
  if (mimetypeEntry !== undefined) {
    const bytes = await readEntry(stream, mimetypeEntry);
    const value = new TextDecoder().decode(bytes).trim();
    if (value.startsWith("application/vnd.oasis.opendocument.")) {
      return MediaType.parse(value);
    }
    if (value === "application/epub+zip") {
      return MediaType.parse(value);
    }
  }

  if (names.has("[Content_Types].xml") || names.has("_rels/.rels")) {
    if (names.has("word/document.xml")) {
      return MediaType.parse(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    }
    if (names.has("xl/workbook.xml")) {
      return MediaType.parse(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    }
    if (names.has("ppt/presentation.xml")) {
      return MediaType.parse(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      );
    }
    return MediaType.parse("application/x-tika-ooxml");
  }

  if (names.has("EncryptedPackage") || names.has("EncryptionInfo")) {
    return MediaType.parse("application/x-tika-ooxml");
  }

  if (names.has("META-INF/MANIFEST.MF")) {
    return MediaType.parse("application/java-archive");
  }

  if (names.has("AndroidManifest.xml") && names.has("classes.dex")) {
    return MediaType.parse("application/vnd.android.package-archive");
  }

  if (
    [...names].some(
      (name) =>
        name.startsWith("Index/") ||
        name === "index.apxl" ||
        name === "Index.zip",
    )
  ) {
    return MediaType.parse("application/vnd.apple.iwork");
  }

  return MediaType.APPLICATION_ZIP;
}

async function readCentralDirectory(
  stream: RipstreamInputStream,
): Promise<ZipEntry[] | null> {
  const path = await stream.getFile();
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (stat.size < 22) return null;

    const tailLength = Math.min(stat.size, 65_557);
    const tail = await readAt(handle, stat.size - tailLength, tailLength);
    const eocdIndex = findSignatureBackwards(tail, EOCD);
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

    const entries: ZipEntry[] = [];
    let cursor = centralOffset;
    for (let index = 0; index < entryCount; index++) {
      const header = await readAt(handle, cursor, 46);
      if (header.length < 46) return null;
      const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
      if (headerView.getUint32(0, true) !== CENTRAL) break;

      const compression = headerView.getUint16(10, true);
      const compressedSize = headerView.getUint32(20, true);
      const nameLength = headerView.getUint16(28, true);
      const extraLength = headerView.getUint16(30, true);
      const commentLength = headerView.getUint16(32, true);
      const localOffset = headerView.getUint32(42, true);
      const nameBytes = await readAt(handle, cursor + 46, nameLength);
      const name = new TextDecoder("utf-8").decode(nameBytes);

      entries.push({ name, compression, compressedSize, localOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
  } finally {
    await handle.close();
  }
}

async function readEntry(
  stream: RipstreamInputStream,
  entry: ZipEntry,
): Promise<Uint8Array> {
  const path = await stream.getFile();
  const handle = await open(path, "r");
  try {
    const header = await readAt(handle, entry.localOffset, 30);
    if (header.length < 30) return new Uint8Array();
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, true) !== LOCAL) return new Uint8Array();
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    // Bound the read as well as the inflate: compressedSize is attacker-controlled.
    if (entry.compressedSize > MAX_MIMETYPE_BYTES) return new Uint8Array();
    const compressed = await readAt(handle, dataOffset, entry.compressedSize);

    if (entry.compression === 0) return compressed;
    if (entry.compression === 8) {
      try {
        return inflateBounded(compressed, "deflate-raw", {
          maxOutputBytes: MAX_MIMETYPE_BYTES,
        });
      } catch {
        // A bomb (LimitExceededError) or corrupt entry is simply not an
        // ODF/EPUB mimetype.
        return new Uint8Array();
      }
    }
    return new Uint8Array();
  } finally {
    await handle.close();
  }
}

async function readZip64(
  handle: Awaited<ReturnType<typeof open>>,
  tail: Uint8Array,
  eocdIndex: number,
): Promise<{ entryCount: number; centralOffset: number } | null> {
  const locatorIndex = findSignatureBackwards(
    tail.subarray(0, eocdIndex),
    ZIP64_LOCATOR,
  );
  if (locatorIndex === -1) return null;

  const locatorView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const zip64Offset = Number(locatorView.getBigUint64(locatorIndex + 8, true));
  const record = await readAt(handle, zip64Offset, 56);
  if (record.length < 56) return null;

  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  if (view.getUint32(0, true) !== 0x06064b50) return null;
  return {
    entryCount: Number(view.getBigUint64(32, true)),
    centralOffset: Number(view.getBigUint64(48, true)),
  };
}

function findSignatureBackwards(data: Uint8Array, signature: number): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let index = data.length - 4; index >= 0; index--) {
    if (view.getUint32(index, true) === signature) return index;
  }
  return -1;
}

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}
