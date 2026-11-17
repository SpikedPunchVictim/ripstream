import {
  AbortError,
  IsolationError,
  LimitExceededError,
  ParseTimeoutError,
  type IsolationFailureReason,
  type RipstreamError,
} from "@spikedpunch/ripstream-core";
import { oneLineText } from "./error-codec.ts";

/**
 * What a caller knows when a `worker_threads` Worker that hosted a Ripstream stopped under a parse (docs/worker-hosting.md).
 * At least one member must be given.
 */
export interface WorkerFailureFacts {
  /** The value of the Worker's `'error'` event (an uncaught exception, `ERR_WORKER_OUT_OF_MEMORY`, ...), if one came. */
  readonly error?: unknown;
  /** The code of the Worker's `'exit'` event. `terminate()` gives 1 and no `'error'` event. */
  readonly exitCode?: number;
  /**
   * Why the caller itself ended the Worker with `terminate()`: "timeout" for a deadline it set, "abort" for a
   * cancellation its own caller asked for. Omitted: nobody here asked for it.
   */
  readonly terminatedBy?: "timeout" | "abort";
  /** The Worker's `resourceLimits.maxOldGenerationSizeMb`, named in the message of an out-of-memory failure. */
  readonly maxOldGenerationSizeMb?: number;
}

/**
 * What stopped the Worker:
 * - `out_of_memory`: the V8 heap limit (`ERR_WORKER_OUT_OF_MEMORY`). The document caused it.
 * - `timeout` / `abort`: the caller ended the Worker for its own deadline or cancellation.
 * - `init_failed`: the Worker could not start.
 * - `crash`: anything else: an uncaught exception, a non-zero exit, an exit without an answer, or a `terminate()` nobody here asked for.
 */
export type WorkerFailureKind = "out_of_memory" | "timeout" | "abort" | "init_failed" | "crash";

export interface WorkerFailureVerdict {
  readonly kind: WorkerFailureKind;
  /**
   * The `IsolationFailureReason` of the failure: "unavailable" for `init_failed`, "crash" for `crash`. `null` for the
   * three kinds the isolator also reports as an error of their own and never as an `IsolationError` (a document's
   * memory or time, a cancellation): the caller's mapping to `IsolationFailureReason` has nothing to say for them.
   * "queue_full" is never the answer: a Worker has no pool; a queue in front of it is the caller's.
   */
  readonly reason: IsolationFailureReason | null;
  /** The error the isolator would have thrown for the same death: `LimitExceededError` (`limit: "memory"`), `ParseTimeoutError`, `AbortError` or `IsolationError`. */
  readonly error: RipstreamError;
}

/** Errors Node gives a Worker that cannot start (`error.code`). */
const INIT_CODES: ReadonlySet<string> = new Set(["ERR_WORKER_INIT_FAILED", "ERR_WORKER_INVALID_EXEC_ARGV", "ERR_WORKER_PATH"]);

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function describe(error: unknown): string {
  if (error instanceof Error) return oneLineText(error.message);
  try {
    return oneLineText(String(error));
  } catch {
    return oneLineText(Object.prototype.toString.call(error));
  }
}

/**
 * The same verdict the isolator gives a dead child, for a dead `worker_threads` Worker: a stable table from how the
 * Worker ended to the ripstream error and, where the isolator has one, the `IsolationFailureReason`. Pure: it reads
 * its argument and starts nothing. In order, the first row that matches decides:
 *
 * | The Worker | kind | error | reason |
 * | --- | --- | --- | --- |
 * | `'error'` with code `ERR_WORKER_OUT_OF_MEMORY` | `out_of_memory` | `LimitExceededError` (`limit: "memory"`) | `null` |
 * | `terminate()`d by the caller for a deadline | `timeout` | `ParseTimeoutError` | `null` |
 * | `terminate()`d by the caller for a cancellation | `abort` | `AbortError` | `null` |
 * | `'error'` with `ERR_WORKER_INIT_FAILED`, `ERR_WORKER_INVALID_EXEC_ARGV` or `ERR_WORKER_PATH` | `init_failed` | `IsolationError` | `"unavailable"` |
 * | any other `'error'`, an `'exit'` (any code) without an answer, a `terminate()` nobody here asked for | `crash` | `IsolationError` | `"crash"` |
 *
 * Throws a TypeError when `facts` names nothing that happened.
 */
export function classifyWorkerFailure(facts: WorkerFailureFacts): WorkerFailureVerdict {
  if (typeof facts !== "object" || facts === null) throw new TypeError("classifyWorkerFailure: facts must be an object");
  const { error, exitCode, terminatedBy, maxOldGenerationSizeMb } = facts;
  if (error === undefined && exitCode === undefined && terminatedBy === undefined) {
    throw new TypeError("classifyWorkerFailure: give the 'error' value, the exit code or terminatedBy");
  }
  const code = codeOf(error);
  if (code === "ERR_WORKER_OUT_OF_MEMORY") {
    const heap = maxOldGenerationSizeMb === undefined ? "" : ` (${maxOldGenerationSizeMb} MB heap)`;
    return {
      kind: "out_of_memory",
      reason: null,
      error: new LimitExceededError(`The parse worker ran out of memory${heap}`, { cause: error, limit: "memory" }),
    };
  }
  if (terminatedBy === "timeout") {
    return { kind: "timeout", reason: null, error: new ParseTimeoutError("Parse timed out in the worker", error === undefined ? {} : { cause: error }) };
  }
  if (terminatedBy === "abort") return { kind: "abort", reason: null, error: new AbortError() };
  const cause = error === undefined ? {} : { cause: error };
  if (code !== undefined && INIT_CODES.has(code)) {
    return {
      kind: "init_failed",
      reason: "unavailable",
      error: new IsolationError("unavailable", `The parse worker could not start: ${describe(error)}`, cause),
    };
  }
  const how =
    error !== undefined
      ? `threw: ${describe(error)}`
      : exitCode === 0
        ? "exited without an answer"
        : `exited with code ${String(exitCode)} (terminate() gives 1)`;
  return { kind: "crash", reason: "crash", error: new IsolationError("crash", `The parse worker stopped: it ${how}`, cause) };
}
