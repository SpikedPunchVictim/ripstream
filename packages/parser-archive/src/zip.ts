import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { inflateSync, unzipSync } from "fflate";
import { OutputBudget, type InflateLimits } from "@spikedpunch/ripstream-core";
import { decodeDeflate64 } from "./deflate64.ts";
import { parseEntry, readAll, safeEntryName, withXhtml } from "./util.ts";

/**
 * An entry at or below this many bytes is never refused for its decompression ratio. It is Tika's
 * OutputLimits.zipBombThreshold (1,000,000): SecureContentHandler checks its ratio only once the output passes it,
 * so a document that starts with a highly compressible run (a blank bitmap) is not taken for a bomb. The per-entry
 * and total byte limits still bound what an entry may expand to.
 */
const RATIO_CHECK_THRESHOLD_BYTES = 1_000_000;

/** Port of Ripstream's PackageParser ZIP path. */
export class ZipParser implements Parser {
  readonly name = "ZipParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([
      MediaType.APPLICATION_ZIP,
      MediaType.parse("application/java-archive")!,
      MediaType.parse("application/vnd.android.package-archive")!,
    ]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    let entries = 0;
    let originalTotal = 0;
    let files: Record<string, Uint8Array>;
    const central = readCentralDirectory(data);
    if (central !== null && central.some((entry) => entry.method === 9)) {
      // fflate does not decode method 9 (Deflate64), so an archive that carries it is read entry by entry.
      files = decodeEntries(data, central, ctx.limits);
      entries = central.length;
    } else try {
      files = unzipSync(data, {
        filter: (file) => {
          entries++;
          if (entries > ctx.limits.maxZipEntries) {
            throw new LimitExceededError(
              `ZIP entries exceed ${ctx.limits.maxZipEntries}`,
            );
          }
          originalTotal += file.originalSize;
          if (originalTotal > ctx.limits.maxTotalEmbeddedBytes) {
            throw new LimitExceededError(
              "ZIP archive expanded size exceeds the embedded byte limit",
            );
          }
          if (file.originalSize > ctx.limits.maxEmbeddedResourceBytes) {
            throw new LimitExceededError(
              `ZIP entry ${file.name} expanded size exceeds the per-entry limit`,
            );
          }
          if (
            file.originalSize > RATIO_CHECK_THRESHOLD_BYTES &&
            file.size > 0 &&
            file.originalSize / file.size > ctx.limits.maxDecompressionRatio
          ) {
            throw new LimitExceededError(
              `ZIP entry ${file.name} exceeds the decompression ratio limit`,
            );
          }
          return true;
        },
      });
    } catch (error) {
      if (error instanceof LimitExceededError) throw error;
      throw new MalformedDocumentError("Invalid ZIP archive", { cause: error });
    }

    const names = Object.keys(files);
    if (names.length > ctx.limits.maxZipEntries) {
      throw new LimitExceededError(
        `ZIP entries ${names.length} exceed ${ctx.limits.maxZipEntries}`,
      );
    }

    let total = 0;
    await withXhtml(handler, metadata, async (xhtml) => {
      for (const name of names) {
        if (name.endsWith("/")) continue;
        if (safeEntryName(name) === null) {
          metadata.add(
            "tk:exception:embedded-stream-exception",
            `unsafe archive path skipped: ${name}`,
          );
          continue;
        }
        const bytes = files[name]!;
        total += bytes.byteLength;
        if (bytes.byteLength > ctx.limits.maxEmbeddedResourceBytes) {
          throw new LimitExceededError(`Entry ${name} expanded size exceeds the per-entry limit`);
        }
        if (total > ctx.limits.maxTotalEmbeddedBytes) {
          throw new LimitExceededError("Archive expanded size exceeds the embedded byte limit");
        }

        await xhtml.startElement("div", "class", "package-entry");
        await xhtml.element("h1", name);
        await parseEntry(xhtml, name, bytes, metadata, ctx);
        await xhtml.endElement("div");
      }
    });
  }
}

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

/** The central directory's entries, or null when it cannot be read (the caller keeps fflate's path). */
function readCentralDirectory(data: Uint8Array): CentralEntry[] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const findSignature = (signature: number): number => {
    for (let offset = data.byteLength - 22; offset >= Math.max(0, data.byteLength - 65557); offset--) {
      if (view.getUint32(offset, true) === signature) return offset;
    }
    return -1;
  };
  const eocd = findSignature(0x06054b50);
  if (eocd < 0) return null;
  let count = view.getUint16(eocd + 10, true);
  let directoryOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    const locator = findSignature(0x07064b50);
    if (locator < 0) return null;
    const zip64 = Number(view.getBigUint64(locator + 8, true));
    if (zip64 + 56 > data.byteLength || view.getUint32(zip64, true) !== 0x06064b50) return null;
    count = Number(view.getBigUint64(zip64 + 32, true));
    directoryOffset = Number(view.getBigUint64(zip64 + 48, true));
  }
  const entries: CentralEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > data.byteLength || view.getUint32(offset, true) !== 0x02014b50) return null;
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > data.byteLength) return null;
    // Extra field 0x0001 carries the 64-bit sizes and local offset when the 32-bit fields are saturated.
    let extra = nameEnd;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = view.getUint16(extra, true);
      const size = view.getUint16(extra + 2, true);
      if (extra + 4 + size > extraEnd) break;
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(view.getBigUint64(field, true)); field += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(view.getBigUint64(field, true)); field += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(view.getBigUint64(field, true)); }
      }
      extra += 4 + size;
    }
    const name = new TextDecoder(flags & 0x0800 ? "utf-8" : "utf-8", { fatal: false }).decode(data.subarray(nameStart, nameEnd));
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset = extraEnd + commentLength;
  }
  return entries;
}

function decodeEntries(
  data: Uint8Array,
  entries: readonly CentralEntry[],
  limits: { readonly maxZipEntries: number; readonly maxEmbeddedResourceBytes: number; readonly maxTotalEmbeddedBytes: number; readonly maxDecompressionRatio: number },
): Record<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const files: Record<string, Uint8Array> = {};
  if (entries.length > limits.maxZipEntries) throw new LimitExceededError(`ZIP entries ${entries.length} exceed ${limits.maxZipEntries}`);
  let total = 0;
  for (const entry of entries) {
    if (entry.uncompressedSize > limits.maxEmbeddedResourceBytes) {
      throw new LimitExceededError(`ZIP entry ${entry.name} expanded size exceeds the per-entry limit`);
    }
    if (entry.uncompressedSize > RATIO_CHECK_THRESHOLD_BYTES && entry.compressedSize > 0
      && entry.uncompressedSize / entry.compressedSize > limits.maxDecompressionRatio) {
      throw new LimitExceededError(`ZIP entry ${entry.name} exceeds the decompression ratio limit`);
    }
    total += entry.uncompressedSize;
    if (total > limits.maxTotalEmbeddedBytes) throw new LimitExceededError("ZIP archive expanded size exceeds the embedded byte limit");
    if (entry.localOffset + 30 > data.byteLength || view.getUint32(entry.localOffset, true) !== 0x04034b50) {
      throw new MalformedDocumentError("Invalid ZIP local header");
    }
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > data.byteLength) throw new MalformedDocumentError("Truncated ZIP entry");
    const compressed = data.subarray(start, end);
    let bytes: Uint8Array;
    if (entry.method === 0) bytes = compressed;
    else if (entry.method === 8) bytes = inflateSync(compressed);
    else if (entry.method === 9) {
      const budget = new OutputBudget(compressed.byteLength, {
        maxOutputBytes: Math.min(limits.maxEmbeddedResourceBytes, limits.maxTotalEmbeddedBytes),
        maxRatio: limits.maxDecompressionRatio,
      } satisfies InflateLimits, `ZIP entry ${entry.name}`);
      bytes = decodeDeflate64(compressed, budget);
    } else {
      throw new MalformedDocumentError(`Unsupported ZIP compression method ${entry.method}`);
    }
    files[entry.name] = bytes;
  }
  return files;
}
