import {
  AbortError,
  IsolationError,
  LimitExceededError,
  ParseTimeoutError,
  type RipstreamError,
} from "@spikedpunch/ripstream-core";
import { MAX_DISK_DEPTH, MAX_DISK_ENTRIES } from "./disk.ts";
import { decodeErrorFrame, oneLineText, sanitizeText } from "./error-codec.ts";
import type { ErrorFrame } from "./frames.ts";

/** Why the PARENT killed the child; recorded before the kill is sent. */
export type KillReason =
  | "timeout"
  | "abort"
  | "rss"
  | "result_cap"
  | "frame_cap"
  | "metadata_cap"
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
  /**
   * Markers seen anywhere in the stderr the parent read, not only in the tail: V8 prints its fatal-error line FIRST
   * and a native stack dump after it, and a long dump pushes that line out of the tail. Omitted: the tail decides.
   */
  readonly stderrMarkers?: StderrMarkers;
  /** `signal.reason` when killReason is "abort". */
  readonly abortReason?: unknown;
  /** What the frame reader objected to when killReason is "protocol" (untrusted-influenced text). */
  readonly protocolDetail?: string;
  /** The budget that was exceeded when killReason is "disk", and whether the walk's entry or depth bound tripped it. */
  readonly disk?: { readonly limitMb: number; readonly boundHit: boolean; readonly unreadable?: boolean };
}

// Observed in the P0 chaos fixtures (b, e, f): "JavaScript heap out of memory",
// "Failed to reserve virtual memory", "Array buffer allocation failed". Matching is case-insensitive.
const MEMORY_MARKER = /out of memory|failed to reserve|allocation failed/i;
const STRING_LENGTH_MARKER = /invalid string length/i;

export interface StderrMarkers {
  readonly memory: boolean;
  readonly stringLength: boolean;
}

/** The longest marker is 21 characters, so a carry of this many characters catches one split across two chunks. */
export const MARKER_CARRY_CHARS = 32;

export function scanStderrMarkers(text: string): StderrMarkers {
  return { memory: MEMORY_MARKER.test(text), stringLength: STRING_LENGTH_MARKER.test(text) };
}

const MAX_DETAIL_CHARS = 200;
const MAX_TAIL_CHARS = 8192;

function oneLine(text: string): string {
  return oneLineText(text, MAX_DETAIL_CHARS);
}

function describeExit(facts: ExitFacts): string {
  if (facts.signal !== null) return `signal ${oneLine(facts.signal)}`;
  return `exit code ${String(facts.code)}`;
}

/** The stderr tail as a `cause`, or nothing when the child wrote none. */
function stderrCause(facts: ExitFacts): { cause?: Error } {
  const tail = sanitizeText(facts.stderrTail, MAX_TAIL_CHARS);
  return tail.length === 0 ? {} : { cause: new Error(`child stderr (tail): ${tail}`) };
}

function isTimeoutReason(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "TimeoutError";
}

/** Names the budget; when the walk bound tripped it the bytes are not the cause, so the message says what is. */
function diskMessage(disk: ExitFacts["disk"]): string {
  if (disk === undefined) return "Isolated parser: temporary disk budget exceeded";
  const bound = disk.boundHit
    ? ` (more than ${MAX_DISK_ENTRIES} files and directories, or nested deeper than ${MAX_DISK_DEPTH} levels)`
    : disk.unreadable === true
      ? " (its temporary directory could not be read)"
      : "";
  return `Isolated parser: temporary disk budget of ${disk.limitMb} MiB exceeded${bound}`;
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
    case "metadata_cap":
      return new LimitExceededError("Isolated parser result metadata exceeded the maximum size", stderrCause(facts));
    case "disk":
      return new LimitExceededError(diskMessage(facts.disk), stderrCause(facts));
    case "protocol": {
      // A child that breaks the frame protocol is broken or hostile, never a malformed document.
      const detail = oneLine(facts.protocolDetail ?? "unspecified");
      return new IsolationError("crash", `Isolated parser protocol violation: ${detail}`, stderrCause(facts));
    }
  }
}

function fromErrorFrame(frame: ErrorFrame, facts: ExitFacts): RipstreamError {
  // The code (when present) is looked up in a closed table of core classes, otherwise the fixed `kind` enum
  // selects the class. Message and code are untrusted display text and never select anything. See error-codec.ts.
  return decodeErrorFrame(frame, stderrCause(facts));
}

/**
 * Maps how a child ended to the error to throw, or null when it succeeded.
 * Rules, in priority order:
 *  1. terminal "done" frame: success, whatever happened afterwards.
 *  2. terminal "error" frame: class chosen by its `code` from a closed table (unknown code: crash), else by its
 *     `kind` enum (error-codec.ts).
 *  3. a kill we recorded: timeout/abort always; rss/result_cap/frame_cap/metadata_cap/disk/
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

  const tailMarkers = scanStderrMarkers(facts.stderrTail);
  const sawMemory = tailMarkers.memory || facts.stderrMarkers?.memory === true;
  const sawStringLength = tailMarkers.stringLength || facts.stderrMarkers?.stringLength === true;
  const memoryAbort =
    (facts.signal === "SIGABRT" || facts.signal === "SIGTRAP" || facts.signal === "SIGSEGV") && sawMemory;
  if (memoryAbort) {
    return new LimitExceededError("Isolated parser ran out of memory", stderrCause(facts));
  }
  if (sawStringLength) {
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
