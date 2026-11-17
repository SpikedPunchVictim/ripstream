import { DEFAULT_LIMITS, limitError, type HandlerType, type IsolationConfig } from "@spikedpunch/ripstream-core";
import { MAX_BYTES_CHUNK, MAX_TEXT_CHUNK_CHARS } from "./frames.ts";

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
export const WIRE_BYTES_PER_OUTPUT_CHAR = 6;

/** Room, in one meta frame, for what is not metadata: `{"t":"meta","metadata":{...}}`, the newline and an exception. */
const META_FRAME_SLACK_BYTES = 64 * 1024;

/**
 * Metadata allowance of a "text" result. All metadata travels in ONE meta frame, so this is also the text frame cap.
 * Core caps one document's metadata at `maxMetadataTotalChars` (names and values, each counted as its length plus
 * one, see Metadata.setMaxTotalChars) and an isolated child always runs with the default, so the frame is sized for
 * that cap and no input is refused here that core accepted: the worst case is 6 wire bytes per counted character
 * (JSON-escaping a control character or a lone surrogate; a name or value costs its length plus one, which covers
 * its quotes and separators), plus slack, rounded up to a whole MiB. With the default of 2,000,000 that is 12 MiB (the P3 review found
 * documents with ~10 MiB of metadata that parsed in-process and were refused here when the allowance was a
 * hand-picked 8 MiB). The parent reserves 6x this for the meta frame (runner.ts), so it costs ~72 MiB of pool per child.
 */
export const TEXT_METADATA_BYTES =
  Math.ceil((DEFAULT_LIMITS.maxMetadataTotalChars * WIRE_BYTES_PER_OUTPUT_CHAR + META_FRAME_SLACK_BYTES) / MIB) * MIB;

/**
 * Metadata allowance of a "records" result, per record: the serialized record envelope (about 150 bytes) plus its
 * metadata plus its path. Measured (default parser stack, a zip of plain text and HTML entries): 415 - 434 bytes per
 * record with 7 - 9 keys. Office and image records carry tens of keys, 1 - 3 KiB by estimate; 4 KiB is ten times
 * the plain case and above the rich one.
 */
export const RECORD_METADATA_BYTES = 4096;

/**
 * Cap on the whole records metadata allowance. The parent reserves 24x the non-text part of a "records" result in
 * the pool (runner.ts), so every MiB allowed here costs 24 MiB of pool: 16 MiB (= 4096 records at the allowance
 * above) costs 384 MiB, which a pool of a few GiB can still hold next to a child. A document that really has more
 * metadata than this gets a LimitExceededError, the same answer as any other result cap.
 */
export const MAX_RECORDS_METADATA_BYTES = 16 * MIB;

/**
 * Allowance for the segments of a request that asked for them (tikajs-9ztw), in bytes of `segments` frames: a base
 * for the documents whose structure is dense (a spreadsheet gives a row and a cell per few characters: 120,000
 * segments, 18 MB of frames, for 1.08 million characters) plus three quarters of a byte per output character. It is on top of the text
 * allowance, so segments no longer take room from the content, and the parent reserves memory for exactly this much
 * (runner.ts, SEGMENT_RESULT_FACTOR): a document with more segments than this is a LimitExceededError, like any
 * other cap. Measured (docs/isolation.md, "Segments"): a text-heavy DOCX of 48 million characters, one paragraph of
 * about 80 per segment, sends 40 MiB of segments frames (0.9 bytes a character); a spreadsheet of 8 million
 * characters in 16 columns sends 81 MiB (10 bytes a character; this allowance covers a sheet like it up to about 2
 * million characters). It is sized so that a request at 52,428,800 characters (the allowance is then 61.5 MiB) still
 * fits the pool of a 4 GiB container (3584 MiB) next to a child: the parent's reservation for it is then 978 MiB.
 */
export const SEGMENT_BASE_BYTES = 24 * MIB;
export const SEGMENT_BYTES_PER_OUTPUT_CHAR = 0.75;

/**
 * Room for the markup of a request whose handlerType is "html", "xml" or "markdown" (tikajs-n89x), in characters. Core
 * counts, against `maxOutputChars`, the characters the parsers write and not the markup its handler adds around them, as
 * Tika's write limit does, so the content of such a result can be far longer than `maxOutputChars` (an HTML file of
 * 1.26 million empty `<span></span>` is 16.4 million characters of content and none counted). The result cap sized for
 * `maxOutputChars` refused it, though the same parse in this process returns it. The allowance is a base plus a number
 * of characters per output character, on top of the text allowance and held in the parent as text is (see
 * `parentResultMb`'s `textChars`); a result with more markup than this is a LimitExceededError, like any other cap. The
 * base is the repro (16.4 million characters) rounded up to 16 Mi; the rate covers tag-dense tables (about 30 characters
 * of markup around a one-character cell) up to a few thousand output characters. Neither is measured beyond that, and
 * both are an owner's to tune. A request whose text allowance already leaves less than this under
 * MAX_RESULT_BYTES_CEILING gets what is left.
 */
export const MARKUP_BASE_CHARS = 16 * MIB;
export const MARKUP_CHARS_PER_OUTPUT_CHAR = 16;

/** The characters of markup a request with this handlerType and `maxOutputChars` may carry beyond its counted text, before the ceiling. */
export function markupAllowanceChars(handlerType: HandlerType | undefined, maxOutputChars: number): number {
  if (handlerType !== "html" && handlerType !== "xml" && handlerType !== "markdown") return 0;
  return MARKUP_BASE_CHARS + maxOutputChars * MARKUP_CHARS_PER_OUTPUT_CHAR;
}

/** Most bytes of `segments` frames a request with `maxOutputChars` may carry. */
export function segmentAllowanceBytes(maxOutputChars: number): number {
  return SEGMENT_BASE_BYTES + Math.ceil(maxOutputChars * SEGMENT_BYTES_PER_OUTPUT_CHAR);
}

/**
 * Room for what is neither text nor metadata: the ready and done frames (about 50 bytes) and the 24-byte envelope
 * of every text frame (a 64 KiB frame costs 0.04%; 64 KiB covers 2,700 frames, a result of 170 MB of text).
 */
export const RESULT_SLACK_BYTES = 64 * 1024;

/**
 * Hard ceiling on `maxResultBytes`, whatever the pool: below V8's maximum string length and far below the point where the arithmetic stops being exact. Requests
 * beyond it have no meaningful bound to enforce.
 */
export const MAX_RESULT_BYTES_CEILING = 512 * MIB;

/**
 * Most embedded-document bytes (`unpackBytes`) one request may ask for. They are held by the child (outside its heap) and
 * then by the parent, so the number is bounded on its own, and by a quarter of the child's memory (see `deriveLimits`).
 * The wire form (base64, a third more) still has to fit MAX_RESULT_BYTES_CEILING: 256 MiB of bytes is 341 MiB of it.
 */
export const MAX_UNPACK_BYTES_CEILING = 256 * MIB;

/** What one bytes frame costs on the wire besides its payload: `{"t":"bytes","chunk":""}` and the newline, with room. */
const BYTES_FRAME_ENVELOPE = 40;

/**
 * Bytes on the wire for `unpackBytes` of embedded documents, at most: base64 of them, plus the envelope of every bytes
 * frame. Every document ends a frame, so a document with a few bytes still costs one: allow one extra frame for each
 * possible embedded document.
 */
export function unpackWireBytes(unpackBytes: number, maxEmbeddedResources: number): number {
  if (unpackBytes === 0) return 0;
  return Math.ceil(unpackBytes / 3) * 4 + (Math.ceil(unpackBytes / MAX_BYTES_CHUNK) + maxEmbeddedResources) * BYTES_FRAME_ENVELOPE;
}

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
  /** Bytes of embedded documents to bring back; records output only. */
  readonly unpackBytes?: number;
  /** Segments are asked for (records output only): their list travels in the record frame, which has no cap of its own then. */
  readonly segments?: boolean;
  /** The shape of the content; for "html", "xml" and "markdown" the result has room for markup beyond `maxOutputChars`. */
  readonly handlerType?: HandlerType;
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
  /** Present for a markup handlerType: characters of markup, beyond `maxOutputChars`, the result has room for (part of `maxResultBytes`). */
  readonly maxMarkupChars?: number;
  /** Present when segments were asked for (records output). */
  readonly segments?: true;
  /** With `segments`: the most bytes of segments frames the parent accepts, and reserves memory for. It is part of `maxResultBytes`. */
  readonly maxSegmentBytes?: number;
  /** Most bytes accepted over fd 3. */
  readonly maxResultBytes: number;
  /**
   * Longest single frame: text mode's largest is its meta frame. Records mode's is a record frame, which holds its
   * content only up to one text chunk (longer content follows in text frames): the metadata allowance, that chunk and
   * the slack. Segments follow in frames of their own, a few hundred KiB each.
   */
  readonly maxFrameBytes: number;
  /** Most `unpackBytes` a request may ask for under this config: the smaller of MAX_UNPACK_BYTES_CEILING and a quarter of `perChildMb`. */
  readonly unpackCeiling: number;
  /** The request's `unpackBytes`; present only when it had one. */
  readonly unpackBytes?: number;
  /** The part of `maxResultBytes` that is for the bytes of embedded documents; present with `unpackBytes`. */
  readonly unpackWireBytes?: number;
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

function recordFrameCap(output: "text" | "records", maxResultBytes: number, metadataBytes: number): number {
  if (output === "text") return TEXT_METADATA_BYTES;
  return Math.min(maxResultBytes, metadataBytes + MAX_TEXT_CHUNK_CHARS * WIRE_BYTES_PER_OUTPUT_CHAR + RESULT_SLACK_BYTES);
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
  const unpackCeiling = Math.min(MAX_UNPACK_BYTES_CEILING, Math.floor((perChildMb * MIB) / 4));
  const unpackBytes = request.unpackBytes;
  if (unpackBytes !== undefined) {
    if (!Number.isSafeInteger(unpackBytes) || unpackBytes < 0) {
      throw new RangeError(`unpackBytes must be a non-negative safe integer, got ${String(unpackBytes)}`);
    }
    if (output !== "records") throw new RangeError('unpackBytes needs a "records" request: only records carry bytes');
    if (unpackBytes > unpackCeiling) {
      throw new RangeError(
        `unpackBytes ${unpackBytes} is more than the isolation allows (${unpackCeiling}: the smaller of ` +
          `${MAX_UNPACK_BYTES_CEILING} and a quarter of the ${perChildMb} MiB a child has, perChildMb). Lower it`,
      );
    }
  }
  const segments = request.segments === true;
  if (segments && output !== "records") throw new RangeError('segments needs a "records" request');
  const unpackWire = unpackBytes === undefined ? 0 : unpackWireBytes(unpackBytes, maxEmbeddedResources);
  const maxSegmentBytes = segments ? segmentAllowanceBytes(maxOutputChars) : undefined;
  const textResultBytes =
    maxOutputChars * WIRE_BYTES_PER_OUTPUT_CHAR +
    metadataAllowanceBytes(output, maxEmbeddedResources) +
    unpackWire +
    (maxSegmentBytes ?? 0) +
    RESULT_SLACK_BYTES;
  if (textResultBytes > MAX_RESULT_BYTES_CEILING) {
    throw limitError(`maxOutputChars ${maxOutputChars} needs a result of up to ${textResultBytes} bytes, above the isolation ` +
        `ceiling of ${MAX_RESULT_BYTES_CEILING} bytes`, "resultBytes", textResultBytes, MAX_RESULT_BYTES_CEILING);
  }
  // Markup never makes a request refusable that its text allowance fits: it gets what is left under the ceiling.
  const maxMarkupChars = Math.min(
    markupAllowanceChars(request.handlerType, maxOutputChars),
    Math.floor((MAX_RESULT_BYTES_CEILING - textResultBytes) / WIRE_BYTES_PER_OUTPUT_CHAR),
  );
  const maxResultBytes = textResultBytes + maxMarkupChars * WIRE_BYTES_PER_OUTPUT_CHAR;

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
    ...(maxMarkupChars > 0 ? { maxMarkupChars } : {}),
    ...(segments ? { segments: true as const, maxSegmentBytes: maxSegmentBytes as number } : {}),
    maxResultBytes,
    // A record frame carries no more than one text chunk of content (the rest follows in text frames, and the segments
    // in segments frames), so its cap is the metadata allowance plus that chunk. Text mode's largest frame is the
    // meta frame (text chunks are 64 KiB), hence the metadata allowance.
    maxFrameBytes: recordFrameCap(output, maxResultBytes, metadataAllowanceBytes(output, maxEmbeddedResources)),
    unpackCeiling,
    ...(unpackBytes === undefined ? {} : { unpackBytes, unpackWireBytes: unpackWire }),
  };
}
