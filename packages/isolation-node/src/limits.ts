import { DEFAULT_LIMITS, LimitExceededError, type IsolationConfig } from "@spikedpunch/ripstream-core";

/**
 * Everything the facade hands to the runner for one request, derived from the isolation config plus the request's
 * effective output cap. Pure: no I/O, no clock, so every number below can be tested as a table.
 *
 * The inputs that matter are `maxOutputChars` (the caller's text budget, which sizes the result cap and the heap)
 * and the config's own overrides. Anything the config states wins; anything it omits is derived here.
 */

const MIB = 1024 * 1024;

/** Memory budget of one child when the config says nothing: the design's 1 - 1.5 GiB, at the top of that range. */
export const DEFAULT_PER_CHILD_MB = 1536;

/**
 * Largest input accepted when the config says nothing. It equals the server's default request body cap (100 MiB):
 * an inline input is held in memory by the parent (the caller's buffer) and again by the child (outside its V8
 * heap), so 100 MiB + a 512 MiB heap + runtime stays inside the 1536 MiB child budget, which a larger default would
 * not (a 512 MiB input would use the whole budget before the parser allocated anything).
 */
export const DEFAULT_MAX_INPUT_BYTES = 100 * MIB;

/**
 * Allocated bytes one child may leave in its private temp directory when the config says nothing (L6). Measured:
 * a stored 90 MiB entry typed PDF made a child spool 270 MiB (three copies at once), so the 100 MiB input cap needs
 * about 300 MiB; 1 GiB leaves room for that and for the OCR parser's temp image.
 */
export const DEFAULT_MAX_DISK_MB = 1024;

/** The design's heap range (L1). The derived heap never leaves it (unless the child budget is smaller, see below). */
export const MIN_DERIVED_HEAP_MB = 384;
export const MAX_DERIVED_HEAP_MB = 512;

/**
 * Heap added per output character: a UTF-16 string is 2 bytes per character and the child may hold the text a
 * few times at once (handler buffer, the chunk being framed, its JSON form), so 4 copies = 8 bytes. At the default
 * 100,000 characters this is under 1 MiB on top of the 384 MiB floor; it only matters for output caps in the tens of
 * millions, where it reaches the 512 MiB ceiling at about 16.7 million characters.
 */
const HEAP_BYTES_PER_OUTPUT_CHAR = 8;

/**
 * Worst-case bytes one output character occupies on the wire: JSON-escaping a control character or a lone
 * surrogate gives a 6-byte `\uXXXX`; every other character is at most 3 bytes (a non-BMP pair is 4 bytes for 2
 * characters). The design's `maxOutputChars * 6`.
 */
const WIRE_BYTES_PER_OUTPUT_CHAR = 6;

/**
 * Metadata allowance of a "text" result. All metadata travels in ONE meta frame, so this is also the text frame cap.
 * Core caps each metadata VALUE at 1,000,000 characters but not their sum, and real documents exceed 1 MiB of
 * metadata JSON (a 300,000-character CJK title is stored under two keys, about 1.8 MB; XMP ancestor lists reach
 * several MB). Measured by the P3 review: with a 1 MiB cap such a document parsed in-process but was refused when
 * isolated. 8 MiB covers those with room; the parent reserves 6x the result cap for text, so this costs ~42 MiB of
 * pool per child. Metadata above it is a LimitExceededError, the same answer as any other result cap.
 */
export const TEXT_METADATA_BYTES = 8 * MIB;

/**
 * Metadata allowance of a "records" result, per record: the serialized record envelope (about 150 bytes) plus its
 * metadata plus its path. Measured (default parser stack, a zip of plain text and HTML entries): 415 - 434 bytes per
 * record with 7 - 9 keys. Office and image records carry tens of keys, 1 - 3 KiB by estimate; 4 KiB is ten times
 * the plain case and above the rich one.
 */
export const RECORD_METADATA_BYTES = 4096;

/**
 * Cap on the whole records metadata allowance. The parent reserves 24x the result cap in the pool for a "records"
 * result (runner.ts), so every MiB allowed here costs 24 MiB of pool: 16 MiB (= 4096 records at the allowance
 * above) costs 384 MiB, which a pool of a few GiB can still hold next to a child. A document that really has more
 * metadata than this gets a LimitExceededError, the same answer as any other result cap.
 */
export const MAX_RECORDS_METADATA_BYTES = 16 * MIB;

/**
 * Room for what is neither text nor metadata: the ready and done frames (about 50 bytes) and the 24-byte envelope
 * of every text frame (a 64 KiB frame costs 0.04%; 64 KiB covers 2,700 frames, a result of 170 MB of text).
 */
export const RESULT_SLACK_BYTES = 64 * 1024;

/**
 * Hard ceiling on `maxResultBytes`, whatever the pool: below V8's maximum string length (a single frame can be as
 * large as the result in records mode) and far below the point where the arithmetic stops being exact. Requests
 * beyond it have no meaningful bound to enforce.
 */
export const MAX_RESULT_BYTES_CEILING = 512 * MIB;

/** The wrapper accepts at most this many CPU seconds (wrapper.ts). */
const MAX_CPU_SECS = 86_400;
/** The soft RLIMIT_CPU sits this far above the wall-clock budget; see `cpuSecsFor`. */
const CPU_MARGIN_SECS = 5;
/** The child's parse timer ends this much before the parent's deadline, or a tenth of it if that is smaller. */
const PARSE_MARGIN_MS = 2000;
const PARSE_MARGIN_DIVISOR = 10;

export interface LimitsRequest {
  readonly output?: "text" | "records";
  readonly maxOutputChars?: number;
  readonly maxEmbeddedResources?: number;
  /** The child's parse timer. At most what the isolation allows (`DerivedLimits.maxParseMillis` of a request without one). */
  readonly maxParseMillis?: number;
}

export interface DerivedLimits {
  /** Pool reservation for the child, MiB. */
  readonly perChildMb: number;
  /** The parent kills the child above this RSS, MiB. Equals `perChildMb`. */
  readonly rssLimitMb: number;
  /** V8 old-space of the child (`--max-old-space-size`), MiB. */
  readonly heapMb: number;
  /** Soft RLIMIT_CPU, seconds (the hard limit is 2 higher). */
  readonly cpuSecs: number;
  /** Wall-clock budget of the whole request, queue wait included. */
  readonly maxTaskMillis: number;
  /** The child's own parse timer, always below `maxTaskMillis` (except at 1 ms). */
  readonly maxParseMillis: number;
  readonly maxInputBytes: number;
  /** The most allocated disk, in MiB, a child may hold in its private temp directory; the parent kills it above this. */
  readonly maxDiskMb: number;
  /** The request's effective output cap: what the child is told and what the sizes below derive from. */
  readonly maxOutputChars: number;
  readonly maxEmbeddedResources: number;
  readonly output: "text" | "records";
  /** Most bytes accepted over fd 3. */
  readonly maxResultBytes: number;
  /** Longest single frame: the default for text (many small frames), the whole result for records (one frame each). */
  readonly maxFrameBytes: number;
}

function requireCount(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
  return value;
}

function requireOutputChars(value: number): number {
  if (value === -1) {
    throw new RangeError(
      "maxOutputChars -1 (unlimited) cannot be isolated: the result cap and the heap are derived from it. " +
        "Pass a finite maxOutputChars",
    );
  }
  return requireCount("maxOutputChars", value);
}

function derivedHeapMb(maxOutputChars: number, perChildMb: number): number {
  const wanted = MIN_DERIVED_HEAP_MB + Math.ceil((maxOutputChars * HEAP_BYTES_PER_OUTPUT_CHAR) / MIB);
  const ranged = Math.min(MAX_DERIVED_HEAP_MB, wanted);
  // A child budget below the design range (the config asked for it) gets half as heap: the rest is for what lives
  // outside the heap (the input bytes, WASM memory, buffers), which the RSS limit counts too.
  return Math.min(ranged, Math.floor(perChildMb / 2));
}

/**
 * The soft RLIMIT_CPU is a backstop behind the parent's wall-clock kill, not a second deadline: one thread cannot
 * use more CPU seconds than wall seconds, so the wall deadline (`maxTaskMillis`) fires first, and the extra
 * `CPU_MARGIN_SECS` covers node's helper threads (GC, libuv pool), whose CPU time the limit also counts, and the
 * child's boot. What the limit adds is a bound that survives the parent: an orphaned child dies after at most
 * `cpuSecs + 2` CPU seconds.
 */
function cpuSecsFor(maxTaskMillis: number): number {
  return Math.min(MAX_CPU_SECS, Math.ceil(maxTaskMillis / 1000) + CPU_MARGIN_SECS);
}

/**
 * The child's own timer: a parse that is merely slow should end with the child's typed ParseTimeoutError, not
 * with the parent's SIGKILL. The parent's deadline also covers queue wait, node's boot and the input transfer, so
 * the child gets the budget minus 2 s, or minus a tenth of it when that is less (a 1 s budget must not leave the
 * child 1 ms). Never below 1 ms.
 */
function parseMillisFor(maxTaskMillis: number): number {
  const margin = Math.min(PARSE_MARGIN_MS, Math.ceil(maxTaskMillis / PARSE_MARGIN_DIVISOR));
  return Math.max(1, maxTaskMillis - margin);
}

function metadataAllowanceBytes(output: "text" | "records", maxEmbeddedResources: number): number {
  if (output === "text") return TEXT_METADATA_BYTES;
  const records = maxEmbeddedResources + 1; // the embedded ones plus the top-level document
  // Never below the text allowance: the top-level record carries the same metadata a text result's meta frame
  // does, and a document that parses in-process must not be refused only because few embedded resources are allowed.
  return Math.min(MAX_RECORDS_METADATA_BYTES, Math.max(TEXT_METADATA_BYTES, records * RECORD_METADATA_BYTES));
}

/**
 * Derives the limits of one request. Throws RangeError for a config or request that cannot be honoured (the
 * message names the numbers) and LimitExceededError when the output cap asks for a result above
 * MAX_RESULT_BYTES_CEILING.
 */
export function deriveLimits(config: IsolationConfig, request: LimitsRequest = {}): DerivedLimits {
  const output = request.output ?? "text";
  const maxOutputChars = requireOutputChars(request.maxOutputChars ?? DEFAULT_LIMITS.maxOutputChars);
  const maxEmbeddedResources = requireCount(
    "maxEmbeddedResources",
    request.maxEmbeddedResources ?? DEFAULT_LIMITS.maxEmbeddedResources,
  );

  const perChildMb = config.perChildMb ?? DEFAULT_PER_CHILD_MB;
  const heapMb = config.heapMb ?? derivedHeapMb(maxOutputChars, perChildMb);
  if (!(heapMb >= 1 && heapMb < perChildMb)) {
    throw new RangeError(
      `heapMb (${heapMb}${config.heapMb === undefined ? ", derived" : ""}) must be at least 1 and below ` +
        `perChildMb (${perChildMb}): the child's RSS limit equals perChildMb and the heap alone must not trip it`,
    );
  }

  const maxTaskMillis = config.maxTaskMillis ?? DEFAULT_LIMITS.maxTaskMillis;
  const maxParseMillis = parseMillisFor(maxTaskMillis);
  const requestedParseMillis = request.maxParseMillis;
  if (requestedParseMillis !== undefined) {
    if (!Number.isSafeInteger(requestedParseMillis) || requestedParseMillis < 1) {
      throw new RangeError(`maxParseMillis must be a positive safe integer, got ${String(requestedParseMillis)}`);
    }
    if (requestedParseMillis > maxParseMillis) {
      throw new RangeError(
        `maxParseMillis ${requestedParseMillis} is more than the isolation allows (${maxParseMillis} ms: its ` +
          `maxTaskMillis of ${maxTaskMillis} ms less the margin the parent keeps). Lower it or raise maxTaskMillis`,
      );
    }
  }
  const maxResultBytes =
    maxOutputChars * WIRE_BYTES_PER_OUTPUT_CHAR +
    metadataAllowanceBytes(output, maxEmbeddedResources) +
    RESULT_SLACK_BYTES;
  if (maxResultBytes > MAX_RESULT_BYTES_CEILING) {
    throw new LimitExceededError(
      `maxOutputChars ${maxOutputChars} needs a result of up to ${maxResultBytes} bytes, above the isolation ` +
        `ceiling of ${MAX_RESULT_BYTES_CEILING} bytes`,
    );
  }

  return {
    perChildMb,
    rssLimitMb: perChildMb,
    heapMb,
    cpuSecs: cpuSecsFor(maxTaskMillis),
    maxTaskMillis,
    maxParseMillis: requestedParseMillis ?? maxParseMillis,
    maxInputBytes: config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    maxDiskMb: config.maxDiskMb ?? DEFAULT_MAX_DISK_MB,
    maxOutputChars,
    maxEmbeddedResources,
    output,
    maxResultBytes,
    // A record is ONE frame, so records mode needs a frame cap as large as the result. The parent's reservation for
    // a records result (24x, runner.ts) already covers the line buffer that can grow that large. Text mode's largest
    // frame is the meta frame (text chunks are 64 KiB), hence the metadata allowance.
    maxFrameBytes: output === "records" ? maxResultBytes : TEXT_METADATA_BYTES,
  };
}
