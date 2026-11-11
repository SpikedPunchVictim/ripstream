import {
  AbortError,
  EncryptedDocumentError,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  MissingDependencyError,
  ParseTimeoutError,
  ParserDeclinedError,
  RipstreamError,
  UnsupportedFormatError,
  UnsupportedRuntimeError,
  type RipstreamErrorCode,
} from "@spikedpunch/ripstream-core";
import type { ChildErrorKind, ErrorFrame } from "./frames.ts";

/**
 * How a typed error crosses the process boundary. The child puts the error's stable `code` (a RipstreamErrorCode),
 * its message and, for the one class that has structured arguments, those arguments on an `error` frame. The
 * PARENT then builds the class itself from the table below; the child never names a class, and anything outside
 * the table is an IsolationError "crash". So a hostile child can choose among the classes a parser may legitimately
 * throw (it could equally have thrown any of them while parsing a document), and cannot make the parent construct
 * anything else, nor use an IsolationError reason.
 *
 * The table is exhaustive over RipstreamErrorCode at compile time: a new code in core fails to compile here until
 * someone decides how it crosses.
 *
 * Every string that comes out of a frame is untrusted display text. It is sanitised and length-capped, and it ends
 * up in HTTP-visible error messages.
 */

/** Longest message kept from a frame (the parent appends "..." when it cuts). */
export const MAX_ERROR_MESSAGE_CHARS = 500;
/** Longest dependency / capability name kept from a frame. */
const MAX_NAME_CHARS = 100;

/**
 * Replaces control characters (keeping \n and \t) and bounds the length. The cut comes first, so a huge message
 * (an error frame can be as large as a records frame) is never scanned whole, and it never leaves half of a
 * surrogate pair at the end.
 */
export function sanitizeText(text: string, maxChars: number): string {
  const cut = text.length > maxChars;
  let head = cut ? text.slice(0, maxChars) : text;
  if (cut && /[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
  const clean = head.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
  return cut ? `${clean}...` : clean;
}

/** One line of sanitised text of at most about `maxChars` characters. */
export function oneLineText(text: string, maxChars: number = MAX_ERROR_MESSAGE_CHARS): string {
  return sanitizeText(text, maxChars).replace(/\s+/g, " ").trim();
}

interface Crossing {
  /**
   * The coarse class a reader that does not know `code` falls back to (the exit classifier's vocabulary). The
   * parent never consults it when `code` is in the table.
   */
  readonly kind: ChildErrorKind;
  /** Extra fields the frame carries for this code (child side). */
  readonly fields?: (error: RipstreamError) => Partial<Pick<ErrorFrame, "dependency" | "capability">>;
  /**
   * Builds the error (parent side) from a frame whose message is already sanitised, or returns null when the
   * frame lacks what this class needs.
   */
  readonly build: (message: string, frame: ErrorFrame, cause: { cause?: Error }) => RipstreamError | null;
}

/** `null`: this code does not cross as itself and arrives as an IsolationError "crash". */
const CROSSINGS: Readonly<Record<RipstreamErrorCode, Crossing | null>> = {
  UNSUPPORTED_FORMAT: { kind: "crash", build: (message, _frame, cause) => new UnsupportedFormatError(message, cause) },
  ENCRYPTED_DOCUMENT: { kind: "crash", build: (message, _frame, cause) => new EncryptedDocumentError(message, cause) },
  MALFORMED_DOCUMENT: { kind: "malformed", build: (message, _frame, cause) => new MalformedDocumentError(message, cause) },
  PARSE_TIMEOUT: { kind: "timeout", build: (message, _frame, cause) => new ParseTimeoutError(message, cause) },
  LIMIT_EXCEEDED: { kind: "limit", build: (message, _frame, cause) => new LimitExceededError(message, cause) },
  MISSING_DEPENDENCY: {
    kind: "crash",
    fields: (error) =>
      error instanceof MissingDependencyError
        ? { dependency: oneLineText(error.dependency, MAX_NAME_CHARS), capability: oneLineText(error.capability, MAX_NAME_CHARS) }
        : {},
    build: (_message, frame) =>
      frame.dependency === undefined || frame.capability === undefined
        ? null
        : new MissingDependencyError(oneLineText(frame.dependency, MAX_NAME_CHARS), oneLineText(frame.capability, MAX_NAME_CHARS)),
  },
  PARSER_DECLINED: { kind: "crash", build: (message) => new ParserDeclinedError(message) },
  ABORTED: { kind: "abort", build: (message) => new AbortError(message) },
  UNSUPPORTED_RUNTIME: { kind: "crash", build: (message) => new UnsupportedRuntimeError(message) },
  // No producer exists inside the child's pipeline (checked by grep when this table was written): a child that
  // sends one is not running our parsers, and a forged 413 / 502 / "empty but fine" would only mislead callers and
  // retry logic. Add a row, with a parity test, when a parser in the child starts throwing one of them.
  REQUEST_TOO_LARGE: null, // the server decides request size before any child exists
  RANDOM_ACCESS_UNAVAILABLE: null,
  EMPTY_DOCUMENT: null,
  TRANSLATION_FAILED: null, // thrown only by the separate language package
  // Needs a numeric limit, and only WriteOutContentHandler throws it; the isolated pipeline installs none.
  WRITE_LIMIT_REACHED: null,
  // Infrastructure. A child must not be able to mint queue_full / unavailable, which callers treat specially.
  ISOLATION_FAILED: null,
};

/** Keyed by arbitrary strings from the wire, so a Map: "__proto__", "constructor" and friends are plain misses. */
const CROSSING_BY_CODE: ReadonlyMap<string, Crossing | null> = new Map(Object.entries(CROSSINGS));

/** The codes that cross as themselves. */
export function decodableCodes(): string[] {
  return [...CROSSING_BY_CODE].filter(([, crossing]) => crossing !== null).map(([code]) => code);
}

// RangeErrors V8 throws when an allocation gives up; the parent's exit classifier knows the same texts from stderr
// (classify.ts) for the case where the process dies instead of catching them.
// "Invalid typed array length" is also what V8 says for a view that runs past its buffer, so a malformed offset in a
// document can read as a limit; both are the document's own failure and cross as the same 422-class answer.
const EXHAUSTION = /invalid string length|array buffer allocation failed|invalid typed array length/i;

/** How many `cause`s down an allocator RangeError is looked for under a MalformedDocumentError. */
const MAX_CAUSE_DEPTH = 4;

function isExhaustion(value: unknown): boolean {
  return value instanceof RangeError && EXHAUSTION.test(describeThrown(value).message);
}

/**
 * core's CompositeParser wraps whatever a parser leaks in a MalformedDocumentError whose `cause` is the original, so
 * an allocator RangeError from a parser reaches the encoder one level down. A hostile `cause` getter throws out of
 * here into encodeChildError's guard, which answers with a crash.
 */
function malformedByExhaustion(thrown: unknown): boolean {
  if (!(thrown instanceof MalformedDocumentError)) return false;
  let current: unknown = thrown;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    current = current instanceof Error ? current.cause : undefined;
    if (isExhaustion(current)) return true;
  }
  return false;
}

function describeThrown(value: unknown): { name: string; message: string } {
  try {
    if (value instanceof Error) return { name: String(value.name), message: String(value.message) };
    return { name: "", message: String(value) };
  } catch {
    return { name: "", message: "an error whose description could not be read" };
  }
}

/**
 * CHILD side: the one `error` frame for whatever was thrown. Never throws: a hostile error object (a throwing
 * `code` getter, a Proxy whose traps throw) is a crash like any other.
 */
export function encodeChildError(thrown: unknown): ErrorFrame {
  try {
    return encodeChildErrorUnchecked(thrown);
  } catch {
    return crashFrame({ name: "", message: "an error that could not be described" });
  }
}

function encodeChildErrorUnchecked(thrown: unknown): ErrorFrame {
  if (malformedByExhaustion(thrown)) {
    return { t: "error", kind: "limit", message: oneLineText(describeThrown(thrown).message) };
  }
  if (thrown instanceof RipstreamError) {
    const code: unknown = thrown.code;
    const crossing = typeof code === "string" ? CROSSING_BY_CODE.get(code) : undefined;
    if (crossing !== undefined && crossing !== null) {
      const { message } = describeThrown(thrown);
      return {
        t: "error",
        kind: crossing.kind,
        code: code as string,
        message: oneLineText(message),
        ...(crossing.fields?.(thrown) ?? {}),
      };
    }
  }
  const described = describeThrown(thrown);
  if (isExhaustion(thrown)) {
    return { t: "error", kind: "limit", message: oneLineText(described.message) };
  }
  return crashFrame(described);
}

// The name is kept in the text (it is what a person debugging needs), but it never selects a class.
function crashFrame({ name, message }: { name: string; message: string }): ErrorFrame {
  return { t: "error", kind: "crash", message: oneLineText(name === "" ? message : `${name}: ${message}`) };
}

/**
 * CHILD side: a "crash" frame for anything thrown, typed or not, never carrying a code. For faults that are not
 * the request's own answer (an uncaught exception, an unhandled rejection): even a RipstreamError, or a
 * RangeError that looks like exhaustion, is just a crash there. Never throws.
 */
export function encodeCrashError(thrown: unknown): ErrorFrame {
  return crashFrame(describeThrown(thrown));
}

/**
 * PARENT side: the error for a terminal `error` frame.
 * - `code` in the table: that class, built here, with the frame's sanitised message.
 * - `code` present but not in the table (unknown, or one that does not cross): IsolationError "crash".
 * - no `code`: chosen by the fixed `kind` enum, as before codes existed.
 */
export function decodeErrorFrame(frame: ErrorFrame, cause: { cause?: Error }): RipstreamError {
  if (frame.code !== undefined) {
    const crossing = CROSSING_BY_CODE.get(frame.code);
    const error = crossing === undefined || crossing === null ? null : crossing.build(oneLineText(frame.message), frame, cause);
    if (error !== null) return error;
    const detail = oneLineText(`${frame.message} [${oneLineText(frame.code, MAX_NAME_CHARS)}]`);
    return new IsolationError("crash", `Isolated parser reported an error that cannot cross the process boundary: ${detail}`, cause);
  }
  const detail = oneLineText(frame.message, 200);
  switch (frame.kind) {
    case "limit":
      return new LimitExceededError(`Isolated parser reported a limit: ${detail}`, cause);
    case "timeout":
      return new ParseTimeoutError(`Isolated parser reported a timeout: ${detail}`, cause);
    case "malformed":
      return new MalformedDocumentError(`Malformed document: ${detail}`);
    case "abort":
      return new AbortError(`Isolated parser reported an abort: ${detail}`);
    case "crash":
      return new IsolationError("crash", `Isolated parser reported an internal failure: ${detail}`, cause);
  }
}
