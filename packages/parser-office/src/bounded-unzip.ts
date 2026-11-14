import {
  effectiveOutputLimit,
  inflateBounded,
  OutputBudget,
  MalformedDocumentError,
  LimitExceededError,
  type ParseLimits,
} from "@spikedpunch/ripstream-core";
import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from "fflate";

/**
 * A ZIP package whose entries are inflated one at a time, on demand. Peak
 * memory is the compressed package plus the single entry being read; the
 * caller should drop an entry's bytes once it has used them.
 */
export interface BoundedZip {
  /** Non-directory entry names in archive order (the last of duplicate names wins). */
  readonly names: readonly string[];
  has(name: string): boolean;
  /**
   * Inflates one entry under its own per-entry budget and the package-wide
   * running total (re-reading an entry is charged again). Returns undefined for
   * an unknown name. Throws LimitExceededError or MalformedDocumentError.
   */
  get(name: string): Uint8Array | undefined;
}

/**
 * Indexes a ZIP buffer without inflating anything, enforcing maxZipEntries.
 * Declared sizes in headers are never trusted: limits apply to the bytes
 * actually produced by each get().
 *
 * A complete archive is read through its central directory; an archive without a usable one (a truncated download)
 * is walked by its local headers instead.
 */
export function boundedUnzip(data: Uint8Array, limits: ParseLimits): BoundedZip {
  return centralDirectoryZip(data, limits) ?? streamingZip(data, limits);
}

// ---------------------------------------------------------------------------
// Central-directory reader
// ---------------------------------------------------------------------------

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP32_MAX = 0xffffffff;

interface CentralEntry {
  readonly method: number;
  readonly compressedSize: number;
  readonly localOffset: number;
}

/**
 * Finds each entry through the central directory, so a lookup is O(1) and no fflate recursion per entry is needed, and
 * inflates it with zlib's output cap (a streaming inflate would first expand a whole pushed chunk). Returns null when
 * the archive has no usable central directory (truncated, zip64 or inconsistent).
 */
function centralDirectoryZip(data: Uint8Array, limits: ParseLimits): BoundedZip | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let at = data.byteLength - 22; at >= Math.max(0, data.byteLength - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return null;
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (view.getUint16(eocd + 10, true) === 0xffff || directorySize === ZIP32_MAX || directoryOffset === ZIP32_MAX) {
    return null;
  }
  if (directoryOffset + directorySize > eocd) return null;

  const entries = new Map<string, CentralEntry>();
  let count = 0;
  let at = directoryOffset;
  const end = directoryOffset + directorySize;
  while (at < end) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL) return null;
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end) return null;
    if (compressedSize === ZIP32_MAX || uncompressedSize === ZIP32_MAX || localOffset === ZIP32_MAX) return null;
    // fflate's Unzip reads a name as latin1 unless the UTF-8 flag is set; this must agree with it.
    const name = new TextDecoder((flags & 0x0800) !== 0 ? "utf-8" : "latin1").decode(
      data.subarray(at + 46, at + 46 + nameLength),
    );
    at = next;
    if (name.endsWith("/")) continue;
    count += 1;
    if (count > limits.maxZipEntries) {
      throw new LimitExceededError(`ZIP entries exceed ${limits.maxZipEntries}`);
    }
    entries.set(name, { method, compressedSize, localOffset });
  }
  if (entries.size === 0) return null;

  const total = new OutputBudget(
    data.byteLength,
    { maxOutputBytes: limits.maxTotalEmbeddedBytes, maxRatio: limits.maxDecompressionRatio },
    "ZIP package",
  );

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    get(name) {
      const entry = entries.get(name);
      if (entry === undefined) return undefined;
      if (entry.localOffset + 30 > data.byteLength || view.getUint32(entry.localOffset, true) !== LOCAL) {
        throw new MalformedDocumentError(`Invalid local header for ZIP entry ${name}`);
      }
      const dataStart =
        entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
      if (dataStart + entry.compressedSize > data.byteLength) {
        throw new MalformedDocumentError(`Truncated ZIP entry ${name}`);
      }
      const compressed = data.subarray(dataStart, dataStart + entry.compressedSize);
      // The entry may not outgrow what is left of the package-wide total either.
      const entryLimits = {
        maxOutputBytes: Math.min(limits.maxEmbeddedResourceBytes, total.limit - total.produced),
        maxRatio: limits.maxDecompressionRatio,
      };
      let bytes: Uint8Array;
      if (entry.method === 0) {
        if (compressed.byteLength > effectiveOutputLimit(compressed.byteLength, entryLimits)) {
          throw new LimitExceededError(`ZIP entry ${name} exceeds ${entryLimits.maxOutputBytes} bytes`);
        }
        bytes = compressed;
      } else if (entry.method === 8) {
        try {
          bytes = inflateBounded(compressed, "deflate-raw", entryLimits);
        } catch (error) {
          if (error instanceof LimitExceededError) throw error;
          throw new MalformedDocumentError(`Invalid ZIP entry ${name}`, { cause: error });
        }
      } else {
        throw new MalformedDocumentError(`Invalid ZIP entry ${name}`, {
          cause: new Error(`unsupported compression method ${entry.method}`),
        });
      }
      total.add(bytes.byteLength);
      return bytes;
    },
  };
}

// ---------------------------------------------------------------------------
// Local-header walk: the fallback for an archive with no central directory
// ---------------------------------------------------------------------------

/**
 * fflate is fed the archive in slices this size. A slice that inflates hugely is expanded in one piece before its
 * callback runs, so the slice bounds the overshoot (deflate expands at most about 1032x); the slice also bounds how
 * many entries Unzip.push recurses through at once.
 */
const PUSH_SLICE_BYTES = 16 * 1024;

function streamingZip(data: Uint8Array, limits: ParseLimits): BoundedZip {
  const ordinals = new Map<string, number>();
  const compressedSizes = new Map<string, number>();
  let entries = 0;
  scan(data, (file) => {
    entries += 1;
    if (entries > limits.maxZipEntries) {
      throw new LimitExceededError(`ZIP entries exceed ${limits.maxZipEntries}`);
    }
    ordinals.set(file.name, entries);
    compressedSizes.set(file.name, file.size ?? data.byteLength);
    return false;
  });

  const total = new OutputBudget(
    data.byteLength,
    { maxOutputBytes: limits.maxTotalEmbeddedBytes, maxRatio: limits.maxDecompressionRatio },
    "ZIP package",
  );

  return {
    names: [...ordinals.keys()],
    has: (name) => ordinals.has(name),
    get(name) {
      const ordinal = ordinals.get(name);
      if (ordinal === undefined) return undefined;
      const entry = new OutputBudget(
        compressedSizes.get(name)!,
        {
          maxOutputBytes: limits.maxEmbeddedResourceBytes,
          maxRatio: limits.maxDecompressionRatio,
        },
        `ZIP entry ${name}`,
      );
      const chunks: Uint8Array[] = [];
      let seen = 0;
      let done = false;
      let failure: unknown;
      scan(data, (file) => {
        seen += 1;
        if (seen !== ordinal) return false;
        file.ondata = (error, chunk, final) => {
          if (failure !== undefined) return;
          if (error !== null) {
            failure = error;
            return;
          }
          try {
            entry.add(chunk.byteLength);
            total.add(chunk.byteLength);
          } catch (limit) {
            failure = limit;
            file.terminate();
            return;
          }
          chunks.push(chunk);
          if (final) done = true;
        };
        file.start();
        return true;
      }, () => failure !== undefined);
      if (failure instanceof LimitExceededError) throw failure;
      if (failure !== undefined) {
        throw new MalformedDocumentError(`Invalid ZIP entry ${name}`, { cause: failure });
      }
      if (!done) throw new MalformedDocumentError(`Truncated ZIP entry ${name}`);
      return concat(chunks, entry.produced);
    },
  };
}

/**
 * Walks the local headers. `visit` returns true after it has started the
 * file; unstarted entries are skipped without being inflated. `stop` is polled
 * between slices so a failed entry ends the walk before the rest is pushed.
 */
function scan(data: Uint8Array, visit: (file: UnzipFile) => boolean, stop: () => boolean = () => false): void {
  let failure: unknown;
  const unzip = new Unzip((file) => {
    if (failure !== undefined) return;
    if (file.name.endsWith("/")) return;
    try {
      visit(file);
    } catch (error) {
      failure = error;
    }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    for (let offset = 0; offset < data.byteLength; offset += PUSH_SLICE_BYTES) {
      const end = Math.min(data.byteLength, offset + PUSH_SLICE_BYTES);
      unzip.push(data.subarray(offset, end), end === data.byteLength);
      if (failure !== undefined || stop()) break;
    }
    if (data.byteLength === 0) unzip.push(data, true);
  } catch (error) {
    failure ??= error;
  }
  if (failure instanceof LimitExceededError) throw failure;
  if (failure !== undefined) {
    throw new MalformedDocumentError("Invalid ZIP package", { cause: failure });
  }
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
