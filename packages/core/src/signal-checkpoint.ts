import { AbortError } from "./errors.ts";

/** Anything carrying an optional AbortSignal (e.g. ParseContext). */
export interface SignalHolder {
  readonly signal?: AbortSignal | undefined;
}

/**
 * Throws if the holder's signal is aborted: the signal's reason when it is an
 * Error (a ParseTimeoutError for maxParseMillis), otherwise an AbortError.
 * Call from synchronous hot loops; note a signal can only fire if the event
 * loop gets a turn, so pair with periodic awaits in very long sync work.
 */
export function throwIfAborted(holder: SignalHolder | undefined): void {
  const signal = holder?.signal;
  if (signal?.aborted !== true) return;
  const reason: unknown = signal.reason;
  if (
    reason instanceof Error &&
    !(reason instanceof DOMException && reason.name === "AbortError")
  ) {
    throw reason;
  }
  throw new AbortError(reason instanceof Error ? reason.message : "Operation aborted");
}

/**
 * Cheap loop checkpoint: calls throwIfAborted once every `interval` ticks.
 *
 *   const tick = signalCheckpoint(ctx, 1024);
 *   for (const entry of entries) { tick(); ... }
 */
export function signalCheckpoint(
  holder: SignalHolder | undefined,
  interval = 1024,
): () => void {
  if (!Number.isInteger(interval) || interval < 1) {
    throw new RangeError(`interval must be a positive integer, got ${interval}`);
  }
  let count = 0;
  return () => {
    if (++count >= interval) {
      count = 0;
      throwIfAborted(holder);
    }
  };
}
