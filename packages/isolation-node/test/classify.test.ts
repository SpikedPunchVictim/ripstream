import assert from "node:assert/strict";
import { test } from "node:test";
import { IsolationError, RipstreamError } from "@spikedpunch/ripstream-core";
import { classifyExit, type ExitFacts } from "../src/classify.ts";
import type { ErrorFrame } from "../src/frames.ts";

const facts = (overrides: Partial<ExitFacts> = {}): ExitFacts => ({
  phase: "post-ready",
  terminal: null,
  killReason: null,
  code: null,
  signal: null,
  stderrTail: "",
  ...overrides,
});

const errorFrame = (kind: ErrorFrame["kind"], message = "m"): ErrorFrame => ({ t: "error", kind, message });

function describeOutcome(error: RipstreamError | null): string {
  if (error === null) return "success";
  if (error instanceof IsolationError) return `IsolationError:${error.reason}`;
  return error.constructor.name;
}

type Row = readonly [label: string, input: Partial<ExitFacts>, expected: string];

function runMatrix(title: string, rows: readonly Row[]): void {
  for (const [label, input, expected] of rows) {
    test(`${title}: ${label} => ${expected}`, () => {
      assert.equal(describeOutcome(classifyExit(facts(input))), expected);
    });
  }
}

const LIMIT = "LimitExceededError";
const TIMEOUT = "ParseTimeoutError";
const ABORT = "AbortError";
const MALFORMED = "MalformedDocumentError";
const CRASH = "IsolationError:crash";
const UNAVAILABLE = "IsolationError:unavailable";

// ---- rule 1/2: terminal frame wins --------------------------------------------------

runMatrix("terminal done", [
  ["clean exit", { terminal: "done", code: 0 }, "success"],
  ["our group SIGKILL after done", { terminal: "done", signal: "SIGKILL" }, "success"],
  ["done then recorded timeout kill", { terminal: "done", killReason: "timeout", signal: "SIGKILL" }, "success"],
  ["done then recorded abort kill", { terminal: "done", killReason: "abort", signal: "SIGKILL" }, "success"],
  ["done then recorded rss kill", { terminal: "done", killReason: "rss", signal: "SIGKILL" }, "success"],
  ["done then result_cap kill", { terminal: "done", killReason: "result_cap", signal: "SIGKILL" }, "success"],
  ["done then segfault", { terminal: "done", signal: "SIGSEGV" }, "success"],
  ["done then nonzero exit", { terminal: "done", code: 1 }, "success"],
  ["done then OOM abort text", { terminal: "done", signal: "SIGABRT", stderrTail: "out of memory" }, "success"],
]);

runMatrix("terminal error without a code maps by kind only", [
  ["limit", { terminal: "error", errorFrame: errorFrame("limit"), code: 0 }, LIMIT],
  ["timeout", { terminal: "error", errorFrame: errorFrame("timeout"), code: 0 }, TIMEOUT],
  ["malformed", { terminal: "error", errorFrame: errorFrame("malformed"), code: 0 }, MALFORMED],
  ["abort", { terminal: "error", errorFrame: errorFrame("abort"), code: 0 }, ABORT],
  ["crash", { terminal: "error", errorFrame: errorFrame("crash"), code: 0 }, CRASH],
  ["malformed beats a later SIGKILL", { terminal: "error", errorFrame: errorFrame("malformed"), signal: "SIGKILL" }, MALFORMED],
  [
    "malformed beats a recorded timeout kill",
    { terminal: "error", errorFrame: errorFrame("malformed"), killReason: "timeout", signal: "SIGKILL" },
    MALFORMED,
  ],
  [
    "limit beats a recorded abort kill",
    { terminal: "error", errorFrame: errorFrame("limit"), killReason: "abort", abortReason: new DOMException("x", "TimeoutError") },
    LIMIT,
  ],
  ["crash frame beats OOM signature", { terminal: "error", errorFrame: errorFrame("crash"), signal: "SIGABRT", stderrTail: "out of memory" }, CRASH],
  ["malformed frame with Limit-looking message stays malformed", { terminal: "error", errorFrame: errorFrame("malformed", "LimitExceededError") }, MALFORMED],
  ["limit frame with Malformed-looking message stays limit", { terminal: "error", errorFrame: errorFrame("limit", "MalformedDocumentError") }, LIMIT],
]);

test("terminal error without an errorFrame is a caller bug and throws", () => {
  assert.throws(() => classifyExit(facts({ terminal: "error" })), TypeError);
});

// ---- rule 3: recorded kill reasons ------------------------------------------------------

const timeoutError = new DOMException("timed out", "TimeoutError");
const userAbort = new DOMException("stop", "AbortError");

runMatrix("killReason timeout/abort", [
  ["timeout post-ready SIGKILL", { killReason: "timeout", signal: "SIGKILL" }, TIMEOUT],
  ["timeout pre-ready SIGKILL still wins over unavailable", { phase: "pre-ready", killReason: "timeout", signal: "SIGKILL" }, TIMEOUT],
  ["timeout beats OOM signature", { killReason: "timeout", signal: "SIGABRT", stderrTail: "out of memory" }, TIMEOUT],
  ["timeout beats SIGXCPU", { killReason: "timeout", signal: "SIGXCPU" }, TIMEOUT],
  ["abort with TimeoutError reason", { killReason: "abort", signal: "SIGKILL", abortReason: timeoutError }, TIMEOUT],
  ["abort with AbortError reason", { killReason: "abort", signal: "SIGKILL", abortReason: userAbort }, ABORT],
  ["abort with no reason", { killReason: "abort", signal: "SIGKILL" }, ABORT],
  ["abort with string reason", { killReason: "abort", signal: "SIGKILL", abortReason: "TimeoutError" }, ABORT],
  ["abort with null reason", { killReason: "abort", signal: "SIGKILL", abortReason: null }, ABORT],
  ["abort with Error named TimeoutError", { killReason: "abort", abortReason: Object.assign(new Error("t"), { name: "TimeoutError" }) }, TIMEOUT],
  ["abort pre-ready still wins over unavailable", { phase: "pre-ready", killReason: "abort", signal: "SIGKILL" }, ABORT],
  ["abort pre-ready with TimeoutError", { phase: "pre-ready", killReason: "abort", abortReason: timeoutError }, TIMEOUT],
]);

for (const reason of ["rss", "result_cap", "frame_cap", "metadata_cap", "disk"] as const) {
  runMatrix(`killReason ${reason}`, [
    ["post-ready SIGKILL", { killReason: reason, signal: "SIGKILL" }, LIMIT],
    ["post-ready with unrelated crash signature", { killReason: reason, signal: "SIGSEGV" }, LIMIT],
    ["post-ready clean exit code", { killReason: reason, code: 0 }, LIMIT],
    ["pre-ready", { phase: "pre-ready", killReason: reason, signal: "SIGKILL" }, UNAVAILABLE],
  ]);
}

runMatrix("killReason protocol", [
  ["post-ready SIGKILL", { killReason: "protocol", signal: "SIGKILL", protocolDetail: "unknown frame type" }, CRASH],
  ["post-ready with OOM-looking stderr stays a crash", { killReason: "protocol", signal: "SIGKILL", stderrTail: "out of memory" }, CRASH],
  ["post-ready without detail", { killReason: "protocol", signal: "SIGKILL" }, CRASH],
  ["pre-ready", { phase: "pre-ready", killReason: "protocol", signal: "SIGKILL" }, UNAVAILABLE],
  ["terminal done wins", { terminal: "done", killReason: "protocol", signal: "SIGKILL" }, "success"],
]);

test("protocol kill message carries the sanitised violation detail", () => {
  const error = classifyExit(facts({ killReason: "protocol", protocolDetail: "bad\u0000 frame\nline2" }));
  assert.match(error?.message ?? "", /protocol violation: bad\? frame line2/);
});

// ---- rule 5/6: post-ready signatures -----------------------------------------------------

runMatrix("post-ready memory abort", [
  ["SIGABRT + JavaScript heap out of memory", { signal: "SIGABRT", stderrTail: "FATAL ERROR: ... JavaScript heap out of memory" }, LIMIT],
  ["SIGABRT + heap out of memory", { signal: "SIGABRT", stderrTail: "heap out of memory" }, LIMIT],
  ["SIGABRT + Allocation failed", { signal: "SIGABRT", stderrTail: "Ineffective mark-compacts near heap limit Allocation failed" }, LIMIT],
  ["SIGABRT + Array buffer allocation failed", { signal: "SIGABRT", stderrTail: "Array buffer allocation failed" }, LIMIT],
  ["SIGABRT + Failed to reserve", { signal: "SIGABRT", stderrTail: "Failed to reserve virtual memory for CodeRange" }, LIMIT],
  ["SIGTRAP + Failed to reserve virtual memory", { signal: "SIGTRAP", stderrTail: "Fatal process out of memory: Failed to reserve virtual memory" }, LIMIT],
  ["SIGTRAP + out of memory", { signal: "SIGTRAP", stderrTail: "out of memory" }, LIMIT],
  ["SIGSEGV + out of memory (fixture e accepts SIGSEGV)", { signal: "SIGSEGV", stderrTail: "Fatal process out of memory" }, LIMIT],
  ["marker seen earlier in stderr, tail empty of it", { signal: "SIGABRT", stderrTail: "native frame 40", stderrMarkers: { memory: true, stringLength: false } }, LIMIT],
  ["string-length marker seen earlier, tail empty of it", { signal: "SIGABRT", stderrTail: "native frame 40", stderrMarkers: { memory: false, stringLength: true } }, LIMIT],
  ["no marker anywhere", { signal: "SIGABRT", stderrTail: "native frame 40", stderrMarkers: { memory: false, stringLength: false } }, CRASH],
  ["earlier marker with a non-abort signal stays a crash", { signal: "SIGTERM", stderrTail: "", stderrMarkers: { memory: true, stringLength: false } }, CRASH],
  ["SIGSEGV without marker", { signal: "SIGSEGV", stderrTail: "" }, CRASH],
  ["SIGABRT without marker", { signal: "SIGABRT", stderrTail: "assertion failed" }, CRASH],
  ["SIGABRT with empty stderr", { signal: "SIGABRT" }, CRASH],
  ["SIGTRAP without marker", { signal: "SIGTRAP", stderrTail: "illegal instruction" }, CRASH],
  ["marker text with a non-abort exit code", { code: 1, stderrTail: "out of memory" }, CRASH],
  ["marker text with SIGTERM", { signal: "SIGTERM", stderrTail: "out of memory" }, CRASH],
]);

runMatrix("post-ready other limits", [
  ["RangeError Invalid string length, code 1", { code: 1, stderrTail: "RangeError: Invalid string length" }, LIMIT],
  ["Invalid string length with SIGABRT", { signal: "SIGABRT", stderrTail: "RangeError: Invalid string length" }, LIMIT],
  ["code 1 without the message", { code: 1, stderrTail: "TypeError: x" }, CRASH],
  ["SIGXCPU", { signal: "SIGXCPU" }, LIMIT],
  // 152 is only what a SHELL reports ($? = 128 + SIGXCPU); the parent sees signal SIGXCPU through exec. A child that
  // calls exit(152) itself is a crash, not a CPU limit.
  ["a plain exit(152) is a crash, not a CPU limit", { code: 152 }, CRASH],
  ["code 152 with a SIGXCPU signal is still the CPU limit (by the signal)", { code: 152, signal: "SIGXCPU" }, LIMIT],
  ["code 137 is not special-cased", { code: 137 }, CRASH],
  ["unsolicited SIGKILL", { signal: "SIGKILL" }, LIMIT],
  ["unsolicited SIGKILL with unrelated stderr", { signal: "SIGKILL", stderrTail: "hello" }, LIMIT],
]);

runMatrix("post-ready crashes", [
  ["SIGBUS", { signal: "SIGBUS" }, CRASH],
  ["SIGILL", { signal: "SIGILL" }, CRASH],
  ["SIGTERM", { signal: "SIGTERM" }, CRASH],
  ["SIGINT", { signal: "SIGINT" }, CRASH],
  ["SIGHUP", { signal: "SIGHUP" }, CRASH],
  ["clean exit without terminal frame", { code: 0 }, CRASH],
  ["exit code 1", { code: 1 }, CRASH],
  ["exit code 2", { code: 2 }, CRASH],
  ["exit code 126 is not unavailable once ready", { code: 126 }, CRASH],
  ["exit code 127 is not unavailable once ready", { code: 127 }, CRASH],
  ["neither code nor signal", {}, CRASH],
]);

// ---- rule 4: pre-ready ---------------------------------------------------------------------

runMatrix("pre-ready", [
  ["glibc: exit 127 (node not found)", { phase: "pre-ready", code: 127 }, UNAVAILABLE],
  ["exit 126 (ulimit failed closed)", { phase: "pre-ready", code: 126 }, UNAVAILABLE],
  ["musl: SIGSEGV at startup", { phase: "pre-ready", signal: "SIGSEGV" }, UNAVAILABLE],
  ["Rosetta: SIGTRAP at startup", { phase: "pre-ready", signal: "SIGTRAP" }, UNAVAILABLE],
  ["SIGABRT at startup", { phase: "pre-ready", signal: "SIGABRT" }, UNAVAILABLE],
  ["SIGABRT with OOM marker is still unavailable", { phase: "pre-ready", signal: "SIGABRT", stderrTail: "out of memory" }, UNAVAILABLE],
  ["Invalid string length text is still unavailable", { phase: "pre-ready", code: 1, stderrTail: "Invalid string length" }, UNAVAILABLE],
  ["unsolicited SIGKILL", { phase: "pre-ready", signal: "SIGKILL" }, UNAVAILABLE],
  ["SIGXCPU", { phase: "pre-ready", signal: "SIGXCPU" }, UNAVAILABLE],
  ["clean exit before ready", { phase: "pre-ready", code: 0 }, UNAVAILABLE],
  ["exit code 1", { phase: "pre-ready", code: 1 }, UNAVAILABLE],
]);

runMatrix("same exit, different phase", [
  ["SIGSEGV pre-ready", { phase: "pre-ready", signal: "SIGSEGV" }, UNAVAILABLE],
  ["SIGSEGV post-ready", { phase: "post-ready", signal: "SIGSEGV" }, CRASH],
  ["SIGTRAP + marker pre-ready", { phase: "pre-ready", signal: "SIGTRAP", stderrTail: "Failed to reserve virtual memory" }, UNAVAILABLE],
  ["SIGTRAP + marker post-ready", { phase: "post-ready", signal: "SIGTRAP", stderrTail: "Failed to reserve virtual memory" }, LIMIT],
  ["SIGKILL pre-ready", { phase: "pre-ready", signal: "SIGKILL" }, UNAVAILABLE],
  ["SIGKILL post-ready", { phase: "post-ready", signal: "SIGKILL" }, LIMIT],
  ["exit 127 pre-ready", { phase: "pre-ready", code: 127 }, UNAVAILABLE],
  ["exit 127 post-ready", { phase: "post-ready", code: 127 }, CRASH],
]);

// ---- never malformed / never unavailable post-ready -------------------------------------------

test("no exit shape without a terminal frame ever yields MalformedDocumentError", () => {
  const signals = [null, "SIGKILL", "SIGABRT", "SIGTRAP", "SIGSEGV", "SIGXCPU", "SIGTERM"];
  const codes = [null, 0, 1, 2, 126, 127, 152];
  const outcomes = new Set<string>();
  for (const phase of ["pre-ready", "post-ready"] as const)
    for (const signal of signals)
      for (const code of codes)
        for (const killReason of [null, "timeout", "abort", "rss", "result_cap", "frame_cap", "metadata_cap", "disk", "protocol"] as const)
          outcomes.add(describeOutcome(classifyExit(facts({ phase, signal, code, killReason, stderrTail: "out of memory" }))));
  assert.equal(outcomes.has(MALFORMED), false);
});

test("no post-ready exit shape yields unavailable", () => {
  const outcomes = new Set<string>();
  for (const signal of [null, "SIGKILL", "SIGABRT", "SIGSEGV", "SIGTERM"])
    for (const code of [null, 0, 1, 126, 127])
      outcomes.add(describeOutcome(classifyExit(facts({ signal, code }))));
  assert.equal(outcomes.has(UNAVAILABLE), false);
});

test("every non-null result is a RipstreamError", () => {
  assert.ok(classifyExit(facts({ code: 1 })) instanceof RipstreamError);
});

// ---- messages and causes -----------------------------------------------------------------

test("crash message names the signal", () => {
  assert.match(classifyExit(facts({ signal: "SIGSEGV" }))?.message ?? "", /signal SIGSEGV/);
});

test("crash message names the exit code", () => {
  assert.match(classifyExit(facts({ code: 3 }))?.message ?? "", /exit code 3/);
});

test("unavailable message names the exit code", () => {
  assert.match(classifyExit(facts({ phase: "pre-ready", code: 127 }))?.message ?? "", /exit code 127/);
});

test("stderr tail is attached as the cause", () => {
  const error = classifyExit(facts({ signal: "SIGSEGV", stderrTail: "boom at 0x0" }));
  assert.match(String((error?.cause as Error | undefined)?.message), /boom at 0x0/);
});

test("stderr tail is kept out of the message", () => {
  const error = classifyExit(facts({ signal: "SIGSEGV", stderrTail: "secret /home/user/path" }));
  assert.equal(error?.message.includes("secret"), false);
});

test("empty stderr produces no cause", () => {
  assert.equal(classifyExit(facts({ signal: "SIGSEGV" }))?.cause, undefined);
});

test("control characters in stderr are replaced in the cause", () => {
  const error = classifyExit(facts({ signal: "SIGSEGV", stderrTail: "a\u001b[31mb\u0000c\u0085d\u2028e" }));
  assert.equal(/[\u0000-\u0008\u001b\u0085\u2028]/.test(String((error?.cause as Error).message)), false);
});

test("newlines and tabs survive in the stderr cause", () => {
  const error = classifyExit(facts({ signal: "SIGSEGV", stderrTail: "line1\n\tline2" }));
  assert.match(String((error?.cause as Error).message), /line1\n\tline2/);
});

test("an oversized stderr tail is bounded in the cause", () => {
  const error = classifyExit(facts({ signal: "SIGSEGV", stderrTail: "x".repeat(100_000) }));
  assert.ok(String((error?.cause as Error).message).length < 9000);
});

test("error frame message is sanitised in the error message", () => {
  const error = classifyExit(facts({ terminal: "error", errorFrame: errorFrame("malformed", "bad\u001b[2J\u0000thing") }));
  assert.equal(/[\u0000-\u001f]/.test(error?.message ?? ""), false);
});

test("error frame message is collapsed to one line", () => {
  const error = classifyExit(facts({ terminal: "error", errorFrame: errorFrame("malformed", "a\n\nb\r\nc") }));
  assert.equal(error?.message.includes("\n"), false);
});

test("error frame message is length-bounded", () => {
  const error = classifyExit(facts({ terminal: "error", errorFrame: errorFrame("limit", "y".repeat(100_000)) }));
  assert.ok((error?.message.length ?? 0) < 400);
});

// INTENTIONAL CHANGE (error-codec.ts): `code` used to be display text next to the `kind`-selected class. It is now the
// RipstreamErrorCode that selects the class, from a closed table; a code that is not in it is an IsolationError crash
// whatever the kind says. The code is still shown in the message, as text.
test("error frame with a code that is not in the table is a crash, and the code is shown as display text", () => {
  const frame: ErrorFrame = { t: "error", kind: "limit", message: "m", code: "ERR_X" };
  const error = classifyExit(facts({ terminal: "error", errorFrame: frame }));
  assert.equal(describeOutcome(error), CRASH);
  assert.match(error?.message ?? "", /\[ERR_X\]/);
});

test("error frame with a known code selects the class by the code, not the kind", () => {
  const frame: ErrorFrame = { t: "error", kind: "crash", message: "needs a password", code: "ENCRYPTED_DOCUMENT" };
  assert.equal(describeOutcome(classifyExit(facts({ terminal: "error", errorFrame: frame }))), "EncryptedDocumentError");
});

test("a typed error frame beats a later SIGKILL and a recorded kill, like any terminal frame", () => {
  const frame: ErrorFrame = { t: "error", kind: "crash", message: "x", code: "UNSUPPORTED_FORMAT" };
  assert.equal(
    describeOutcome(classifyExit(facts({ terminal: "error", errorFrame: frame, killReason: "timeout", signal: "SIGKILL" }))),
    "UnsupportedFormatError",
  );
});

test("abort with a TimeoutError reason keeps it as the cause", () => {
  const error = classifyExit(facts({ killReason: "abort", abortReason: timeoutError }));
  assert.equal(error?.cause, timeoutError);
});

test("IsolationError crash is not recoverable", () => {
  assert.equal(classifyExit(facts({ code: 1 }))?.recoverable, false);
});

test("an unsolicited SIGKILL says it was likely out of memory or a CPU hard limit (the kernel sends SIGKILL for both)", () => {
  const error = classifyExit(facts({ signal: "SIGKILL" }));
  assert.match(error?.message ?? "", /likely out of memory or CPU hard limit/);
});
