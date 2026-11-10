import {
  IsolationError,
  LimitExceededError,
  PIPES_RESULT_STATUSES,
  ParseTimeoutError,
  RequestTooLargeError,
  WriteLimitReachedError,
  type PipesResultCategory,
  type PipesResultStatus,
} from "@spikedpunch/ripstream-core";

/*
 * What a pipe run says about each input: Tika's PipesResult (tika-pipes-api PipesResult.java), a status in one of
 * five categories. A run goes on after a result whose category is not FATAL, and says what happened to every input.
 */

export { PIPES_RESULT_STATUSES, type PipesResultCategory, type PipesResultStatus };

/** What a run says about one input. */
export interface PipesResult {
  /** The input's id (`PipeDocument.id`), or `concatenated` for the one document CONCATENATE emits at the end. */
  readonly id: string;
  readonly status: PipesResultStatus;
  readonly category: PipesResultCategory;
  /** The failure, or the parse exception that was recorded or skipped: Tika's `PipesResult.message`. */
  readonly message?: string;
  /** From the input leaving the fetcher to its result (for `concatenated`, the final emit). */
  readonly elapsedMs: number;
}

export function pipesResult(
  id: string,
  status: PipesResultStatus,
  elapsedMs: number,
  message?: string,
): PipesResult {
  return {
    id,
    status,
    category: PIPES_RESULT_STATUSES[status],
    ...(message === undefined || message === "" ? {} : { message }),
    elapsedMs,
  };
}

/** Tika counts every SUCCESS status as a success, parse exceptions included; this is the negation. */
export const isFailure = (result: PipesResult): boolean => result.category !== "SUCCESS";

/** How a result is answered over HTTP: the status, and when to come back for the two families that pass. */
export interface PipesHttpResponse {
  readonly status: number;
  /** Seconds, for the answers that say the condition is transient (429 and 503). */
  readonly retryAfterSeconds?: number;
}

/** Tika's CRASH_RETRY_AFTER_SECONDS: a crashed child is replaced promptly, so there is no point holding clients off. */
const CRASH_RETRY_AFTER_SECONDS = 5;

/**
 * Tika's PipesParsingHelper.mapStatusToHttpResponse and responseBuilder: what a server answers for a result. Success,
 * parse exceptions included, is 200; a client that named a fetcher or emitter that is not there is 400 (retrying it will
 * never work); a document over a limit is 413; a crash, a timeout or an out-of-memory child is 503 with a Retry-After of
 * 5 s; a client pool at capacity is 429 with the wait the caller says it held clients for (`busyRetryAfterSeconds`,
 * whole seconds, at least 1); the rest of the failures are 500. Written as a record over every status, so a status added to the table
 * is not mapped by accident.
 */
const HTTP_STATUS: Readonly<Record<PipesResultStatus, number>> = {
  FAILED_TO_INITIALIZE: 500,
  FETCHER_INITIALIZATION_EXCEPTION: 500,
  EMITTER_INITIALIZATION_EXCEPTION: 500,
  CLIENT_UNAVAILABLE_WITHIN_MS: 429,
  FETCH_EXCEPTION: 500,
  EMIT_EXCEPTION: 500,
  FETCHER_NOT_FOUND: 400,
  EMITTER_NOT_FOUND: 400,
  PRESET_NOT_FOUND: 400,
  PAYLOAD_LIMIT_EXCEEDED: 413,
  OOM: 503,
  TIMEOUT: 503,
  UNSPECIFIED_CRASH: 503,
  EMPTY_OUTPUT: 200,
  PARSE_SUCCESS: 200,
  PARSE_SUCCESS_WITH_EXCEPTION: 200,
  PARSE_EXCEPTION_NO_EMIT: 200,
  EMIT_SUCCESS: 200,
  EMIT_SUCCESS_PARSE_EXCEPTION: 200,
  EMIT_SUCCESS_PASSBACK: 200,
  PARTIAL_TIMEOUT: 200,
};

export function httpResponseFor(status: PipesResultStatus, busyRetryAfterSeconds = 1): PipesHttpResponse {
  const code = HTTP_STATUS[status];
  // Tika's retryAfterSeconds(millis): whole seconds, cut not rounded, and at least 1.
  if (code === 429) return { status: code, retryAfterSeconds: Math.max(1, Math.floor(busyRetryAfterSeconds)) };
  if (code === 503) return { status: code, retryAfterSeconds: CRASH_RETRY_AFTER_SECONDS };
  return { status: code };
}

/** `Name: message`, as the exception text Tika's results and recorded failures carry. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * The status of an input whose parse threw. A document that cannot be read (malformed, encrypted, empty) does not
 * throw: the engine asks for it to be recorded, and that is EMIT_SUCCESS_PARSE_EXCEPTION or PARSE_EXCEPTION_NO_EMIT.
 * What throws is the rest. A timeout or a crash of the isolated child is one of Tika's PROCESS_CRASH statuses (the
 * next input still runs: the child is replaced). A full queue or an unavailable isolation is a client that could not
 * be had. A document over a limit (size, depth, output, memory or disk budget) is PAYLOAD_LIMIT_EXCEEDED, the nearest
 * of Tika's task exceptions; that includes a child that ran out of memory, which arrives as a limit error, so OOM is
 * not told apart. Anything else is a bug in a parser or in a component of the caller's, and is UNSPECIFIED_CRASH, so
 * that it is reported and not mistaken for a bad document.
 */
export function statusForParseError(error: unknown): PipesResultStatus {
  if (error instanceof ParseTimeoutError) return "TIMEOUT";
  if (error instanceof IsolationError) {
    return error.reason === "crash" ? "UNSPECIFIED_CRASH" : "CLIENT_UNAVAILABLE_WITHIN_MS";
  }
  if (
    error instanceof LimitExceededError ||
    error instanceof WriteLimitReachedError ||
    error instanceof RequestTooLargeError
  ) {
    return "PAYLOAD_LIMIT_EXCEEDED";
  }
  return "UNSPECIFIED_CRASH";
}
