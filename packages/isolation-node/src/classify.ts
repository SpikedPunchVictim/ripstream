import {
  AbortError,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  ParseTimeoutError,
  type RipstreamError,
} from "@spikedpunch/ripstream-core";
import type { ErrorFrame } from "./frames.ts";

/** Why the PARENT killed the child; recorded before the kill is sent. */
export type KillReason =
  | "timeout"
  | "abort"
  | "rss"
  | "result_cap"
  | "frame_cap"
  // Nothing records this yet: the per-call disk budget is tracked by bead tikajs-zgg2.11. Kept so the classifier
  // and its tests already know what a disk-budget kill means when that lands.
  | "disk"
  | "protocol";

export interface ExitFacts {
  /** Whether the child's "ready" frame was accepted. */
  readonly phase: "pre-ready" | "post-ready";
  /** Terminal frame received from the child, if any. */
  readonly terminal: "done" | "error" | null;
  /** Required when `terminal` is "error". */
  readonly errorFrame?: ErrorFrame;
  readonly killReason: KillReason | null;
  readonly code: number | null;
  readonly signal: string | null;
  /** Bounded tail of the child's stderr (untrusted text). */
  readonly stderrTail: string;
  /** `signal.reason` when killReason is "abort". */
  readonly abortReason?: unknown;
  /** What the frame reader objected to when killReason is "protocol" (untrusted-influenced text). */
  readonly protocolDetail?: string;
}

// Observed in the P0 chaos fixtures (b, e, f): "JavaScript heap out of memory",
// "Failed to reserve virtual memory", "Array buffer allocation failed". Matching is case-insensitive.
const MEMORY_MARKER = /out of memory|failed to reserve|allocation failed/i;
const STRING_LENGTH_MARKER = /invalid string length/i;

const MAX_DETAIL_CHARS = 200;
const MAX_TAIL_CHARS = 8192;

/** Replaces control characters (keeping \n and \t) and bounds the length. */
function sanitize(text: string, maxChars: number): string {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}...` : clean;
}

function oneLine(text: string): string {
  return sanitize(text, MAX_DETAIL_CHARS).replace(/\s+/g, " ").trim();
}

function describeExit(facts: ExitFacts): string {
  if (facts.signal !== null) return `signal ${oneLine(facts.signal)}`;
  return `exit code ${String(facts.code)}`;
}

/** The stderr tail as a `cause`, or nothing when the child wrote none. */
function stderrCause(facts: ExitFacts): { cause?: Error } {
  const tail = sanitize(facts.stderrTail, MAX_TAIL_CHARS);
  return tail.length === 0 ? {} : { cause: new Error(`child stderr (tail): ${tail}`) };
}

function isTimeoutReason(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "TimeoutError";
}

function fromKillReason(reason: KillReason, facts: ExitFacts): RipstreamError {
  switch (reason) {
    case "timeout":
      return new ParseTimeoutError("Parse timed out in the isolated parser", stderrCause(facts));
    case "abort":
      return isTimeoutReason(facts.abortReason)
        ? new ParseTimeoutError("Parse timed out", { cause: facts.abortReason })
        : new AbortError();
    case "rss":
      return new LimitExceededError("Isolated parser exceeded its memory limit (resident set size)", stderrCause(facts));
    case "result_cap":
      return new LimitExceededError("Isolated parser result exceeded the maximum result size", stderrCause(facts));
    case "frame_cap":
      return new LimitExceededError("Isolated parser result frame exceeded the maximum frame size", stderrCause(facts));
    case "disk":
      return new LimitExceededError("Isolated parser exceeded its disk budget", stderrCause(facts));
    case "protocol": {
      // A child that breaks the frame protocol is broken or hostile, never a malformed document.
      const detail = oneLine(facts.protocolDetail ?? "unspecified");
      return new IsolationError("crash", `Isolated parser protocol violation: ${detail}`, stderrCause(facts));
    }
  }
}

function fromErrorFrame(frame: ErrorFrame, facts: ExitFacts): RipstreamError {
  // Only the fixed `kind` enum selects the class; message and code are untrusted display text.
  const detail = oneLine(frame.code === undefined ? frame.message : `${frame.message} [${frame.code}]`);
  switch (frame.kind) {
    case "limit":
      return new LimitExceededError(`Isolated parser reported a limit: ${detail}`, stderrCause(facts));
    case "timeout":
      return new ParseTimeoutError(`Isolated parser reported a timeout: ${detail}`, stderrCause(facts));
    case "malformed":
      return new MalformedDocumentError(`Malformed document: ${detail}`);
    case "abort":
      return new AbortError(`Isolated parser reported an abort: ${detail}`);
    case "crash":
      return new IsolationError("crash", `Isolated parser reported an internal failure: ${detail}`, stderrCause(facts));
  }
}

/**
 * Maps how a child ended to the error to throw, or null when it succeeded.
 * Rules, in priority order:
 *  1. terminal "done" frame: success, whatever happened afterwards.
 *  2. terminal "error" frame: class chosen by its `kind` enum.
 *  3. a kill we recorded: timeout/abort always; rss/result_cap/frame_cap/disk/
 *     protocol only after "ready" (before it, the child is infrastructure, see 4).
 *  4. before "ready": IsolationError "unavailable" (the exit shape varies by
 *     libc/emulation, so only the missing ready frame is reliable).
 *  5. after "ready": memory-abort signature, "Invalid string length", SIGXCPU,
 *     unsolicited SIGKILL => LimitExceededError.
 *  6. anything else after "ready": IsolationError "crash".
 */
export function classifyExit(facts: ExitFacts): RipstreamError | null {
  if (facts.terminal === "done") return null;
  if (facts.terminal === "error") {
    if (facts.errorFrame === undefined) {
      throw new TypeError('classifyExit: terminal "error" requires errorFrame');
    }
    return fromErrorFrame(facts.errorFrame, facts);
  }

  const { killReason } = facts;
  if (killReason === "timeout" || killReason === "abort") return fromKillReason(killReason, facts);

  if (facts.phase === "pre-ready") {
    return new IsolationError(
      "unavailable",
      `Isolated parser failed before it was ready (${describeExit(facts)})`,
      stderrCause(facts),
    );
  }

  if (killReason !== null) return fromKillReason(killReason, facts);

  const memoryAbort =
    (facts.signal === "SIGABRT" || facts.signal === "SIGTRAP" || facts.signal === "SIGSEGV") &&
    MEMORY_MARKER.test(facts.stderrTail);
  if (memoryAbort) {
    return new LimitExceededError("Isolated parser ran out of memory", stderrCause(facts));
  }
  if (STRING_LENGTH_MARKER.test(facts.stderrTail)) {
    return new LimitExceededError("Isolated parser exceeded the maximum string length", stderrCause(facts));
  }
  // Only the signal: 152 is what a shell reports (128 + SIGXCPU), the parent sees SIGXCPU through exec, and a
  // child that calls exit(152) itself must not be taken for a CPU limit.
  if (facts.signal === "SIGXCPU") {
    return new LimitExceededError("Isolated parser exceeded its CPU time limit", stderrCause(facts));
  }
  if (facts.signal === "SIGKILL") {
    // Nobody here asked for this kill: the cgroup OOM killer, or the CPU hard limit (RLIMIT_CPU's hard limit
    // delivers SIGKILL once the soft limit's SIGXCPU was ignored). Either way the document caused it.
    return new LimitExceededError("Isolated parser was killed (likely out of memory or CPU hard limit)", stderrCause(facts));
  }
  return new IsolationError(
    "crash",
    `Isolated parser ended without a result (${describeExit(facts)})`,
    stderrCause(facts),
  );
}
