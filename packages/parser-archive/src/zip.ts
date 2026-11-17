import {
  LimitExceededError, limitError,
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  noteEmbeddedLimit,
  tallyPart,
  truncatesEmbeddedLimit,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { unzipSync } from "fflate";
import { inflateBounded, OutputBudget, type InflateLimits } from "@spikedpunch/ripstream-core";
import bzip from "seek-bzip";
import { BudgetedSink } from "./compressor.ts";
import { decodeDeflate64 } from "./deflate64.ts";
import { EntryNames, parseEntry, readAll, renamedEntryNote, withXhtml } from "./util.ts";

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
    // Under `onEmbeddedLimit: "truncate"` an archive with more than `maxZipEntries` entries is read up to that many, in
    // archive order, and says so on its metadata; the entries after them are neither read nor counted against any byte limit.
    const truncate = truncatesEmbeddedLimit(ctx);
    let entries = 0;
    let originalTotal = 0;
    let files: ZipFile[];
    const central = readCentralDirectory(data);
    if (central !== null && (central.some((entry) => !FFLATE_METHODS.has(entry.method) || isEncrypted(entry)) || hasAmbiguousNames(central))) {
      // fflate does not decode method 9 (Deflate64) or the others (bzip2 is read here, the rest are refused one entry at a
      // time), and it ignores the encryption flag, so an archive that carries any is read entry by entry. So is one with a
      // repeated name or an entry named __proto__, which fflate's plain result object would drop.
      files = decodeEntries(data, central, ctx.limits, truncate);
      entries = central.length;
    } else try {
      // fflate's result is an object, which lists integer-like names (`1`, `2`) before the rest, so the order the entries
      // are admitted in is kept here: it is the archive's.
      const admitted: string[] = [];
      const record = unzipSync(data, {
        filter: (file) => {
          entries++;
          if (entries > ctx.limits.maxZipEntries) {
            if (truncate) return false; // not read; the walk goes on only to count them
            throw limitError(`ZIP entries exceed ${ctx.limits.maxZipEntries}`, "zipEntries", entries, ctx.limits.maxZipEntries);
          }
          originalTotal += file.originalSize;
          if (originalTotal > ctx.limits.maxTotalEmbeddedBytes) {
            throw limitError("ZIP archive expanded size exceeds the embedded byte limit", "totalBytes", originalTotal, ctx.limits.maxTotalEmbeddedBytes);
          }
          if (file.originalSize > ctx.limits.maxEmbeddedResourceBytes) {
            throw limitError(`ZIP entry ${file.name} expanded size exceeds the per-entry limit`, "entryBytes", file.originalSize, ctx.limits.maxEmbeddedResourceBytes);
          }
          if (
            file.originalSize > RATIO_CHECK_THRESHOLD_BYTES &&
            file.size > 0 &&
            file.originalSize / file.size > ctx.limits.maxDecompressionRatio
          ) {
            throw limitError(`ZIP entry ${file.name} exceeds the decompression ratio limit`, "ratio", file.originalSize / file.size, ctx.limits.maxDecompressionRatio);
          }
          admitted.push(file.name);
          return true;
        },
      });
      files = admitted.map((name) => ({ name, bytes: record[name]! }));
    } catch (error) {
      if (error instanceof LimitExceededError) throw error;
      throw new MalformedDocumentError("Invalid ZIP archive", { cause: error });
    }

    if (files.length > ctx.limits.maxZipEntries) {
      throw limitError(`ZIP entries ${files.length} exceed ${ctx.limits.maxZipEntries}`, "zipEntries", files.length, ctx.limits.maxZipEntries);
    }
    if (truncate && entries > ctx.limits.maxZipEntries) {
      noteEmbeddedLimit(metadata, { limit: "maxZipEntries", max: ctx.limits.maxZipEntries, seen: entries, read: ctx.limits.maxZipEntries });
    }

    let total = 0;
    // An entry whose name leaves the archive root is read under a sanitised name, and the archive says so (tikajs-bsv0).
    const names = new EntryNames();
    for (const { name } of files) names.reserve(name);
    await withXhtml(handler, metadata, async (xhtml) => {
      for (const file of files) {
        const { bytes, failure } = file;
        if (file.name.endsWith("/")) continue;
        const entry = names.resolve(file.name);
        const name = entry.name;
        if (entry.original !== undefined) metadata.add("tk:exception:embedded-stream-exception", renamedEntryNote(entry));
        if (failure !== undefined) {
          // Oracle (Tika 4.2.0 /rmeta): an entry that cannot be read (an encrypted one, or a method commons-compress does not
          // know: 14, 99) is recorded on the archive as embedded-stream-exception and listed by name; the others are read.
          metadata.add("tk:exception:embedded-stream-exception", failure);
          tallyPart(ctx, "entries-failed", false);
          await xhtml.element("p", name);
          continue;
        }
        total += bytes.byteLength;
        if (bytes.byteLength > ctx.limits.maxEmbeddedResourceBytes) {
          throw limitError(`Entry ${name} expanded size exceeds the per-entry limit`, "entryBytes", bytes.byteLength, ctx.limits.maxEmbeddedResourceBytes);
        }
        if (total > ctx.limits.maxTotalEmbeddedBytes) {
          throw limitError("Archive expanded size exceeds the embedded byte limit", "totalBytes", total, ctx.limits.maxTotalEmbeddedBytes);
        }

        await xhtml.startElement("div", "class", "package-entry");
        await xhtml.element("h1", name);
        await parseEntry(xhtml, name, bytes, metadata, ctx, entry.original);
        await xhtml.endElement("div");
      }
    });
  }
}

interface ZipFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** Why the entry could not be read, when it could not; `bytes` is then empty. */
  readonly failure?: string;
}

/** The methods fflate decodes: stored and deflated. */
const FFLATE_METHODS: ReadonlySet<number> = new Set([0, 8]);

function isEncrypted(entry: CentralEntry): boolean {
  return (entry.flags & 1) !== 0;
}

/** A name fflate's result object cannot keep: a repeat of an earlier one, or `__proto__`, which would set the prototype. */
function hasAmbiguousNames(entries: readonly CentralEntry[]): boolean {
  const seen = new Set<string>();
  for (const { name } of entries) {
    if (name === "__proto__" || seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

interface CentralEntry {
  readonly name: string;
  readonly flags: number;
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
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    offset = extraEnd + commentLength;
  }
  return entries;
}

function decodeEntries(
  data: Uint8Array,
  allEntries: readonly CentralEntry[],
  limits: { readonly maxZipEntries: number; readonly maxEmbeddedResourceBytes: number; readonly maxTotalEmbeddedBytes: number; readonly maxDecompressionRatio: number },
  truncate: boolean,
): ZipFile[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const files: ZipFile[] = [];
  if (allEntries.length > limits.maxZipEntries && !truncate) {
    throw limitError(`ZIP entries ${allEntries.length} exceed ${limits.maxZipEntries}`, "zipEntries", allEntries.length, limits.maxZipEntries);
  }
  const entries = allEntries.slice(0, limits.maxZipEntries);
  // Declared sizes only reject early; what an entry really inflates to is bounded by what is left of the total.
  let total = 0;
  let produced = 0;
  for (const entry of entries) {
    if (entry.uncompressedSize > limits.maxEmbeddedResourceBytes) {
      throw limitError(`ZIP entry ${entry.name} expanded size exceeds the per-entry limit`, "entryBytes", entry.uncompressedSize, limits.maxEmbeddedResourceBytes);
    }
    if (entry.uncompressedSize > RATIO_CHECK_THRESHOLD_BYTES && entry.compressedSize > 0
      && entry.uncompressedSize / entry.compressedSize > limits.maxDecompressionRatio) {
      throw limitError(`ZIP entry ${entry.name} exceeds the decompression ratio limit`, "ratio", entry.uncompressedSize / entry.compressedSize, limits.maxDecompressionRatio);
    }
    total += entry.uncompressedSize;
    if (total > limits.maxTotalEmbeddedBytes) {
      throw limitError("ZIP archive expanded size exceeds the embedded byte limit", "totalBytes", total, limits.maxTotalEmbeddedBytes);
    }
    if (entry.localOffset + 30 > data.byteLength || view.getUint32(entry.localOffset, true) !== 0x04034b50) {
      throw new MalformedDocumentError("Invalid ZIP local header");
    }
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > data.byteLength) throw new MalformedDocumentError("Truncated ZIP entry");
    const compressed = data.subarray(start, end);
    if (isEncrypted(entry)) {
      files.push({ name: entry.name, bytes: new Uint8Array(0), failure: `EncryptedDocumentException: stream (${entry.name}) is encrypted` });
      continue;
    }
    const entryLimits = {
      maxOutputBytes: Math.min(limits.maxEmbeddedResourceBytes, limits.maxTotalEmbeddedBytes - produced),
      maxRatio: limits.maxDecompressionRatio,
      minRatioBytes: RATIO_CHECK_THRESHOLD_BYTES,
    } satisfies InflateLimits;
    let bytes: Uint8Array;
    if (entry.method === 0) {
      if (compressed.byteLength > entryLimits.maxOutputBytes) {
        throw limitError(`ZIP entry ${entry.name} exceeds ${entryLimits.maxOutputBytes} bytes`, "entryBytes", compressed.byteLength, entryLimits.maxOutputBytes);
      }
      bytes = compressed;
    } else if (entry.method === 8) {
      try {
        bytes = inflateBounded(compressed, "deflate-raw", entryLimits);
      } catch (error) {
        if (error instanceof LimitExceededError) throw error;
        throw new MalformedDocumentError(`Invalid ZIP entry ${entry.name}`, { cause: error });
      }
    } else if (entry.method === 9) {
      const budget = new OutputBudget(compressed.byteLength, entryLimits, `ZIP entry ${entry.name}`);
      bytes = decodeDeflate64(compressed, budget);
    } else if (entry.method === 12) {
      const sink = new BudgetedSink(new OutputBudget(compressed.byteLength, entryLimits, `ZIP entry ${entry.name}`));
      try {
        (bzip.decode as (input: Uint8Array, output: BudgetedSink) => unknown)(compressed, sink);
      } catch (error) {
        if (error instanceof LimitExceededError) throw error;
        throw new MalformedDocumentError(`Invalid ZIP entry ${entry.name}`, { cause: error });
      }
      bytes = sink.result();
    } else {
      files.push({ name: entry.name, bytes: new Uint8Array(0), failure: `TikaException: Can't read archive stream (${entry.name})` });
      continue;
    }
    produced += bytes.byteLength;
    files.push({ name: entry.name, bytes });
  }
  return files;
}
