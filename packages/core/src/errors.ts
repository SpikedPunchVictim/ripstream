import type { ParseWarning } from "./warnings.ts";

export type RipstreamErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "ENCRYPTED_DOCUMENT"
  | "MALFORMED_DOCUMENT"
  | "WRITE_LIMIT_REACHED"
  | "PARSE_TIMEOUT"
  | "REQUEST_TOO_LARGE"
  | "LIMIT_EXCEEDED"
  | "ADMISSION_REFUSED"
  | "MISSING_DEPENDENCY"
  | "RANDOM_ACCESS_UNAVAILABLE"
  | "PARSER_DECLINED"
  | "EMPTY_DOCUMENT"
  | "ABORTED"
  | "UNSUPPORTED_RUNTIME"
  | "TRANSLATION_FAILED"
  | "ISOLATION_FAILED"
  | "LOW_YIELD";

export class RipstreamError extends Error {
  readonly code: RipstreamErrorCode;
  readonly recoverable: boolean;

  constructor(
    code: RipstreamErrorCode,
    message: string,
    options: { cause?: unknown; recoverable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.recoverable = options.recoverable ?? false;
  }
}

export class UnsupportedFormatError extends RipstreamError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("UNSUPPORTED_FORMAT", message, options);
  }
}

export class EncryptedDocumentError extends RipstreamError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("ENCRYPTED_DOCUMENT", message, options);
  }
}

export class MalformedDocumentError extends RipstreamError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("MALFORMED_DOCUMENT", message, options);
  }
}

/**
 * An input of zero bytes. Tika's AutoDetectParser refuses it with a ZeroByteFileException, which is a TikaException:
 * a document that cannot be read, not a parser that is missing.
 */
export class ZeroByteFileError extends MalformedDocumentError {
  constructor() {
    super("InputStream must have > 0 bytes");
  }
}

/**
 * `ParseOptions.onLowYield: "throw"`, and the parse's result carries a low-yield warning (see `isLowYield` in
 * warnings.ts): the document parsed, and mostly nothing came out of it (a scan, a repair that kept little, parts that
 * failed). It is a policy outcome of the caller's choosing, not a malformed document, so it extends `RipstreamError`
 * and not `MalformedDocumentError`: a handler for damaged input does not swallow it. `warnings` are the low-yield
 * warnings, each with its `path` when it came from an embedded document. Raised in the parent, after the parse: it
 * never crosses the isolation boundary as an error, the warnings cross in the result.
 */
export class LowYieldError extends RipstreamError {
  readonly warnings: readonly ParseWarning[];

  constructor(warnings: readonly ParseWarning[], message?: string) {
    super("LOW_YIELD", message ?? lowYieldMessage(warnings));
    this.warnings = warnings;
  }
}

function lowYieldMessage(warnings: readonly ParseWarning[]): string {
  const first = warnings[0];
  if (first === undefined) return "Low-yield result";
  const where = first.path === undefined ? "" : ` in ${first.path}`;
  const rest = warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : "";
  switch (first.kind) {
    case "image-only":
      return `Low-yield result: ${first.pages} of ${first.of} pages are images with no text, ${first.chars} characters in all${where}${rest}`;
    case "repaired":
      return `Low-yield result: the file was repaired and gave ${first.chars} characters on ${first.of} pages${where}${rest}`;
    case "partial":
      return `Low-yield result: ${first.failed} of ${first.of} parts could not be read (${first.reason})${where}${rest}`;
    case "truncated":
      return `Low-yield result: truncated at ${first.limit}${where}${rest}`;
  }
}

export class WriteLimitReachedError extends RipstreamError {
  readonly limit: number;

  constructor(limit: number) {
    super("WRITE_LIMIT_REACHED", `Write limit of ${limit} characters reached`, {
      recoverable: true,
    });
    this.limit = limit;
  }
}

export class ParseTimeoutError extends RipstreamError {
  constructor(message = "Parse timed out", options: { cause?: unknown } = {}) {
    super("PARSE_TIMEOUT", message, { ...options, recoverable: true });
  }
}

export class RequestTooLargeError extends RipstreamError {
  constructor(message = "Request too large") {
    super("REQUEST_TOO_LARGE", message);
  }
}

/**
 * Which limit a `LimitExceededError` is about, so a consumer maps a refusal without reading the message:
 *
 * - `outputChars`: `maxOutputChars` (the text, or the recursive total). `documentOutputChars`: `maxDocumentOutputChars`.
 * - `zipEntries`: `maxZipEntries` (zip, tar, cpio, ar, ISO and dump entries).
 * - `ratio`: `maxDecompressionRatio`. `entryBytes`: `maxEmbeddedResourceBytes` (one entry or part).
 *   `totalBytes`: `maxTotalEmbeddedBytes` (all of an archive).
 * - `nodeDepth`: embedded depth (`maxNodeDepth`) and the nesting guards of mail, HTML, XML and directories.
 * - `embeddedResources`: `maxEmbeddedResources`. `entityExpansion`: XML entity expansion (`maxXmlEntityExpansions`).
 * - `metadataChars`: `maxMetadataTotalChars` and the per-key value cap of `Metadata`.
 * - `inputBytes`: the input itself is too large (an isolator's `maxInputBytes`, a stream or PDF cap).
 * - `pages`: the PDF page cap.
 * - `memory`, `cpu`, `disk`, `resultBytes`: an isolated child's resource budget (its memory, CPU time, temporary disk,
 *   or the result it may send back) or the memory pool that holds the result.
 * - `other`: a format's own guard that no `ParseLimits` member names (a row, cell, packet or box count, say); the
 *   message says which.
 */
export const LIMIT_REASONS = [
  "outputChars",
  "documentOutputChars",
  "zipEntries",
  "ratio",
  "entryBytes",
  "totalBytes",
  "nodeDepth",
  "embeddedResources",
  "entityExpansion",
  "metadataChars",
  "inputBytes",
  "pages",
  "memory",
  "cpu",
  "disk",
  "resultBytes",
  "other",
] as const;

export type LimitReason = (typeof LIMIT_REASONS)[number];

export function isLimitReason(value: unknown): value is LimitReason {
  return typeof value === "string" && (LIMIT_REASONS as readonly string[]).includes(value);
}

export interface LimitExceededOptions {
  readonly cause?: unknown;
  /** Which limit. Omitted: `"other"`. */
  readonly limit?: LimitReason;
  /** How far the document got when the limit stopped it (a count, bytes or characters), when the parser knows. */
  readonly observed?: number;
  /** The limit's value, in the same unit as `observed`. */
  readonly max?: number;
}

/**
 * A document went past a limit. `code` is `LIMIT_EXCEEDED`; `limit` says which limit (see {@link LimitReason}), and
 * `observed` and `max` carry the numbers when the site that threw knew them. All three survive the isolation boundary
 * and a parse-worker thread unchanged; the message stays text for people.
 */
export class LimitExceededError extends RipstreamError {
  readonly limit: LimitReason;
  // `declare`: no own property unless the site knew the number, so an error without one carries none across a boundary.
  declare readonly observed?: number;
  declare readonly max?: number;

  constructor(message: string, options: LimitExceededOptions = {}) {
    super("LIMIT_EXCEEDED", message, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      recoverable: true,
    });
    this.limit = options.limit ?? "other";
    if (options.observed !== undefined) this.observed = options.observed;
    if (options.max !== undefined) this.max = options.max;
  }
}

/** A `LimitExceededError` for `limit`, with the numbers when the site knows them: the short form of the options object. */
export function limitError(message: string, limit: LimitReason, observed?: number, max?: number): LimitExceededError {
  return new LimitExceededError(message, { limit, ...(observed === undefined ? {} : { observed }), ...(max === undefined ? {} : { max }) });
}

/**
 * The isolation memory pool refused a request that could never fit it: the caps the request carries (or defaults to)
 * reserve more than the whole pool. It is about the deployment and the caps, not the document, and not any one limit
 * the parse hit, so it has its own code and name and is not a `LimitExceededError` (before tikajs-mz56 it was, which
 * folded a capacity problem into a document's limit). Still recoverable, and still 422 from the server. Raised in the
 * parent: it never crosses the child boundary.
 */
export class AdmissionRefusedError extends RipstreamError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("ADMISSION_REFUSED", message, { ...options, recoverable: true });
  }
}

export class MissingDependencyError extends RipstreamError {
  readonly dependency: string;
  readonly capability: string;

  constructor(dependency: string, capability: string) {
    super(
      "MISSING_DEPENDENCY",
      `Missing optional dependency "${dependency}" required for ${capability}. Install it to enable this parser.`,
    );
    this.dependency = dependency;
    this.capability = capability;
  }
}

export class RandomAccessUnavailableError extends RipstreamError {
  constructor(message: string) {
    super("RANDOM_ACCESS_UNAVAILABLE", message);
  }
}

export class ParserDeclinedError extends RipstreamError {
  constructor(message: string) {
    super("PARSER_DECLINED", message, { recoverable: true });
  }
}

export class EmptyDocumentError extends RipstreamError {
  constructor(message = "Empty document") {
    super("EMPTY_DOCUMENT", message);
  }
}

export class AbortError extends RipstreamError {
  constructor(message = "Operation aborted") {
    super("ABORTED", message, { recoverable: true });
  }
}

export class UnsupportedRuntimeError extends RipstreamError {
  constructor(message: string) {
    super("UNSUPPORTED_RUNTIME", message);
  }
}

/**
 * Why a parse could not run (or finish) inside an isolation child:
 * - queue_full: the isolator's bounded queue/memory pool rejected the task;
 *   transient, so callers may retry later.
 * - unavailable: isolation cannot be provided (no usable child runtime).
 * - crash: the child died or misbehaved in a way no other error explains.
 */
export type IsolationFailureReason = "queue_full" | "unavailable" | "crash";

/**
 * Infrastructure failure of the parse-isolation layer. Document-caused
 * failures (timeout, memory/size limits, malformed input) are reported with
 * their own error types, never with this one.
 */
export class IsolationError extends RipstreamError {
  readonly reason: IsolationFailureReason;

  constructor(
    reason: IsolationFailureReason,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super("ISOLATION_FAILED", message, {
      ...options,
      recoverable: reason === "queue_full",
    });
    this.reason = reason;
  }
}

/**
 * Server status mapping. Unsupported formats use 415 (upstream's media-type
 * contract); malformed, encrypted, and over-limit documents use 422; a
 * write-limit hit still produced content, so it maps to 200. Isolation
 * failures map to 503 when the service could not take the work (queue_full,
 * unavailable) and 500 when a child crashed unexplained.
 */
export function httpStatusForError(error: unknown): number {
  if (!(error instanceof RipstreamError)) return 500;
  switch (error.code) {
    case "UNSUPPORTED_FORMAT":
      return 415;
    case "ENCRYPTED_DOCUMENT":
    case "MALFORMED_DOCUMENT":
    case "LIMIT_EXCEEDED":
    case "ADMISSION_REFUSED":
    case "LOW_YIELD":
      return 422;
    case "WRITE_LIMIT_REACHED":
    case "EMPTY_DOCUMENT":
      return 200;
    case "PARSE_TIMEOUT":
      return 408;
    case "REQUEST_TOO_LARGE":
      return 413;
    case "TRANSLATION_FAILED":
      // Upstream translation dependency failed; this is a gateway fault, not a
      // fault in the request document, so it is neither 422 nor a bare 500.
      return 502;
    case "ISOLATION_FAILED":
      if (!(error instanceof IsolationError)) return 500;
      switch (error.reason) {
        case "queue_full":
        case "unavailable":
          return 503;
        case "crash":
        default:
          return 500;
      }
    case "MISSING_DEPENDENCY":
    case "RANDOM_ACCESS_UNAVAILABLE":
    case "PARSER_DECLINED":
    case "ABORTED":
    case "UNSUPPORTED_RUNTIME":
      return 500;
  }
}
