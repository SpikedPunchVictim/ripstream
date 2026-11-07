import { OutputBudget, MalformedDocumentError, LimitExceededError, type ParseLimits } from "@spikedpunch/ripstream-core";
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
 */
export function boundedUnzip(data: Uint8Array, limits: ParseLimits): BoundedZip {
  const ordinals = new Map<string, number>();
  const compressedSizes = new Map<string, number>();
  let entries = 0;
  scan(data, (file) => {
    entries += 1;
    if (entries > limits.maxZipEntries) {
      throw new LimitExceededError(`ZIP entry count exceeds ${limits.maxZipEntries}`);
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
      });
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
 * file; unstarted entries are skipped without being inflated.
 */
function scan(data: Uint8Array, visit: (file: UnzipFile) => boolean): void {
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
    unzip.push(data, true);
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
