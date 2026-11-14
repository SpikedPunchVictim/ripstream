import {
  AbortError,
  EncryptedDocumentError,
  LimitExceededError,
  MalformedDocumentError,
  ParseTimeoutError,
  UnsupportedFormatError,
  WriteLimitReachedError,
} from "./errors.ts";

/**
 * What a failed parse is, once the caller has asked for failures to be recorded (`ParseOptions.onDocumentFailure`).
 * The split is Tika's:
 *
 * - "document": the document could not be read. Tika notes the exception on the document's metadata and still
 *   answers; so does a recording parse.
 * - "unsupported": no parser takes the type. Tika's fallback is the EmptyParser, which yields an empty document and
 *   no exception.
 * - "fatal": anything else (a timeout, a limit, an abort, a parser bug, an infrastructure fault). The parse did not
 *   finish for a reason that is not the document's content, so it is an error and is thrown.
 */
export type FailureClass = "document" | "unsupported" | "fatal";

export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof MalformedDocumentError || error instanceof EncryptedDocumentError) return "document";
  if (error instanceof UnsupportedFormatError) return "unsupported";
  return "fatal";
}

/**
 * Whether the error is the write limit being reached, however far a parser wrapped it: Tika's
 * `WriteLimitReachedException.isWriteLimitReached` also walks the cause chain.
 */
export function isWriteLimitReached(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    if (current instanceof WriteLimitReachedError) return true;
    seen.add(current);
  }
  return false;
}

/**
 * A failure that ends the parse rather than one part of it: a limit, a timeout, an abort, the output cut. A parser that
 * records a failed embedded part and goes on rethrows these, so a hostile archive is refused and not read around.
 */
export function isFatalParseError(error: unknown, ctx: { readonly signal: AbortSignal }): boolean {
  return (
    error instanceof LimitExceededError ||
    error instanceof ParseTimeoutError ||
    error instanceof AbortError ||
    error instanceof WriteLimitReachedError ||
    ctx.signal.aborted
  );
}

/** Tika's EmbeddedDocumentUtil.recordEmbeddedStreamException: the exception's name and message, not a stack trace. */
export function recordStreamException(metadata: { add(name: string, value: string): void }, error: unknown): void {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  metadata.add("tk:exception:embedded-stream-exception", text);
}
