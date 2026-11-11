import {
  AbortError,
  LimitExceededError,
  ParseTimeoutError,
  WriteLimitReachedError,
  type ParseContext,
} from "@spikedpunch/ripstream-core";

/**
 * A failure that ends the parse rather than one part of it: a limit, a timeout, an abort, the output cut. A parser that
 * records a failed part and goes on rethrows these, so a hostile archive is refused and not read around.
 */
export function isFatal(error: unknown, ctx: ParseContext): boolean {
  return (
    error instanceof LimitExceededError ||
    error instanceof ParseTimeoutError ||
    error instanceof AbortError ||
    error instanceof WriteLimitReachedError ||
    ctx.signal.aborted
  );
}

/** What a recorded failure says: the error's name and message, where Tika records a stack trace. */
export function describeFailure(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
