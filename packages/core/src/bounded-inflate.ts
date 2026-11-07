import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  inflateSync,
} from "node:zlib";
import { LimitExceededError } from "./errors.ts";

export interface InflateLimits {
  /** Hard cap on total decompressed bytes. */
  readonly maxOutputBytes: number;
  /** Max output/input ratio. Default 1000. Ignored below `minRatioBytes`. */
  readonly maxRatio?: number;
  /** Output up to this size is always allowed regardless of ratio. Default 64 KiB. */
  readonly minRatioBytes?: number;
}

export type InflateFormat = "gzip" | "deflate" | "deflate-raw" | "brotli";

const DEFAULT_RATIO = 1000;
const DEFAULT_MIN_RATIO_BYTES = 64 * 1024;

/** Effective output cap: min(maxOutputBytes, max(inputBytes * ratio, minRatioBytes)). */
export function effectiveOutputLimit(inputBytes: number, limits: InflateLimits): number {
  const ratio = limits.maxRatio ?? DEFAULT_RATIO;
  const floor = limits.minRatioBytes ?? DEFAULT_MIN_RATIO_BYTES;
  return Math.min(limits.maxOutputBytes, Math.max(inputBytes * ratio, floor));
}

/**
 * Running output counter for streaming decompressors (fflate Gunzip/Inflate/
 * Unzip ondata callbacks, lz4/snappy block loops, ...). Call `add(chunk.length)`
 * for every output chunk BEFORE retaining it; it throws LimitExceededError as
 * soon as the cap is crossed, so inflation stops long before full expansion.
 *
 *   const budget = new OutputBudget(input.length, { maxOutputBytes: 64 << 20 });
 *   gunzip.ondata = (chunk) => { budget.add(chunk.length); out.push(chunk); };
 */
export class OutputBudget {
  readonly limit: number;
  private total = 0;
  private readonly inputBytes: number;
  private readonly label: string;

  constructor(inputBytes: number, limits: InflateLimits, label = "Decompressed data") {
    this.inputBytes = inputBytes;
    this.label = label;
    this.limit = effectiveOutputLimit(inputBytes, limits);
  }

  get produced(): number {
    return this.total;
  }

  add(bytes: number): void {
    this.total += bytes;
    if (this.total > this.limit) {
      throw new LimitExceededError(
        `${this.label} exceeds ${this.limit} bytes (input ${this.inputBytes} bytes)`,
      );
    }
  }
}

/**
 * Synchronously inflates a whole buffer, aborting before full expansion
 * (zlib maxOutputLength) when the output cap or ratio limit is crossed.
 * Throws LimitExceededError; other zlib errors propagate unchanged.
 *
 *   const bytes = inflateBounded(gz, "gzip", { maxOutputBytes: 100 << 20 });
 */
export function inflateBounded(
  input: Uint8Array,
  format: InflateFormat,
  limits: InflateLimits,
): Uint8Array {
  const limit = effectiveOutputLimit(input.byteLength, limits);
  const options = { maxOutputLength: Math.max(1, limit) };
  try {
    const out =
      format === "gzip"
        ? gunzipSync(input, options)
        : format === "deflate"
          ? inflateSync(input, options)
          : format === "deflate-raw"
            ? inflateRawSync(input, options)
            : brotliDecompressSync(input, options);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new LimitExceededError(
        `Decompressed ${format} data exceeds ${limit} bytes (input ${input.byteLength} bytes)`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Wraps any async chunk source (e.g. a decompression stream) with an
 * OutputBudget so iteration fails once the cap is crossed.
 */
export async function* limitOutput(
  source: AsyncIterable<Uint8Array>,
  budget: OutputBudget,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    budget.add(chunk.byteLength);
    yield chunk;
  }
}
