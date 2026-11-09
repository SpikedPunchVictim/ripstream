import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
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
  type IsolatedParseResult,
} from "@spikedpunch/ripstream-core";
import { MemoryPool } from "../src/pool.ts";
import { ChildRunner, type ChildRunnerOptions } from "../src/runner.ts";
import type { RunDiagnostics } from "../src/supervisor.ts";
import { expectNoNewHandles, expectPidGone, handleCounts, settleHandles } from "./fixtures/helpers.ts";

/**
 * runChildMain in a REAL child process (fixtures/hostile-main.ts: the real entry around a scripted fake pipeline),
 * run by the real ChildRunner. Where child-main.test.ts injects the I/O, this proves what only a process can: the
 * stderr guard is installed, one terminal frame is enough for the parent, the process exits by itself, and a
 * hostile parser takes only its own request down.
 */

const HOSTILE = fileURLToPath(new URL("./fixtures/hostile-main.ts", import.meta.url));
const MIB = 1024 * 1024;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const pool = new MemoryPool({ poolMb: 16_384, overshootMb: 0, maxQueue: 16 });
const runners: ChildRunner[] = [];
after(async () => {
  await Promise.all(runners.map((r) => r.dispose()));
});

function runnerFor(mode: string, arg?: string, overrides: Partial<ChildRunnerOptions> = {}): ChildRunner {
  const runner = new ChildRunner({
    pool,
    childScript: HOSTILE,
    childArgs: arg === undefined ? [mode] : [mode, arg],
    perChildMb: 512,
    heapMb: 128,
    cpuSecs: 60,
    maxTaskMillis: 20_000,
    maxInputBytes: MIB,
    maxResultBytes: MIB,
    rssLimitMb: 512,
    ...overrides,
  });
  runners.push(runner);
  return runner;
}

/** A runner plus the diagnostics of the runs it has finished (the last one first). */
function observed(mode: string, arg?: string, overrides: Partial<ChildRunnerOptions> = {}): { runner: ChildRunner; last: () => RunDiagnostics } {
  const seen: RunDiagnostics[] = [];
  const runner = runnerFor(mode, arg, { ...overrides, onRunSettled: (d) => seen.unshift(d) });
  return {
    runner,
    last: () => {
      const d = seen[0];
      if (d === undefined) throw new Error("no run has settled");
      return d;
    },
  };
}

function textOf(result: IsolatedParseResult): string {
  assert.equal(result.kind, "text");
  return (result as { text: string }).text;
}

// ---- the happy paths --------------------------------------------------------------------------

test("text: a run answers with the text and metadata, and the child exits by itself (no grace kill)", async () => {
  const before = handleCounts();
  const { runner, last } = observed("ok");
  const result = await runner.run({ input: bytes("hello") });
  assert.equal(result.kind, "text");
  assert.equal(textOf(result), "ok-text");
  assert.deepEqual((result as { metadata: unknown }).metadata, { "Content-Type": ["text/plain"], fixture: ["ok"] });
  const d = last();
  assert.equal(d.terminal, "done");
  assert.equal(d.code, 0, "exit code 0 without process.exit()");
  assert.equal(d.graceKilled, false, "nothing kept the child alive after its terminal frame");
  assert.equal(d.killReason, null);
  await settleHandles();
  expectNoNewHandles(before);
});

test("records: one record per document, in order, with the per-document exception", async () => {
  const { runner, last } = observed("ok");
  const result = await runner.run({ input: bytes("hello"), output: "records" });
  assert.equal(result.kind, "records");
  const records = (result as { records: readonly { depth: number; content: string; embeddedResourcePath: string; mediaType: string; exception: unknown }[] }).records;
  assert.deepEqual(
    records.map((r) => [r.depth, r.content, r.embeddedResourcePath, r.mediaType]),
    [
      [0, "ok-text", "/doc", "text/plain"],
      [1, "inner one", "/doc/part-1", "text/plain"],
      [2, "", "/doc/part-2", "text/plain"],
    ],
  );
  assert.equal(records[0]?.exception, null);
  assert.deepEqual(records[2]?.exception, {
    name: "MalformedDocumentError",
    message: "embedded part is damaged",
    code: "MALFORMED_DOCUMENT",
  });
  assert.equal(last().graceKilled, false);
  assert.equal(last().code, 0);
});

test("the request reaches the pipeline: filename, limits, and the bytes", async () => {
  const { runner } = observed("options");
  const result = await runner.run(
    { input: bytes("12345"), filename: "report.docx", maxOutputChars: 321, maxEmbeddedResources: 7 },
    { limits: { maxParseMillis: 4321 } },
  );
  assert.deepEqual(JSON.parse(textOf(result)), {
    options: { filename: "report.docx", limits: { maxOutputChars: 321, maxEmbeddedResources: 7, maxParseMillis: 4321 } },
    source: { bytes: 5 },
  });
});

test("a request without limits adds none: core's defaults apply, as in-process", async () => {
  const { runner } = observed("options");
  const result = await runner.run({ input: bytes("x") });
  assert.deepEqual(JSON.parse(textOf(result)), { options: { limits: {} }, source: { bytes: 1 } });
});

test("a { path } input is handed to the pipeline as a path, not read by the entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-main-path-"));
  try {
    const file = join(dir, "doc.bin");
    await writeFile(file, "contents the entry must not read");
    const { runner } = observed("options");
    const result = await runner.run({ input: { path: file } });
    assert.deepEqual(JSON.parse(textOf(result)), { options: { limits: {} }, source: { path: file } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- typed errors, through a real process ----------------------------------------------------

type ErrorClass = abstract new (...args: never[]) => RipstreamError;

const CROSS_AS_ITSELF: readonly (readonly [thrown: string, expected: ErrorClass, code: string])[] = [
  ["UnsupportedFormatError", UnsupportedFormatError, "UNSUPPORTED_FORMAT"],
  ["EncryptedDocumentError", EncryptedDocumentError, "ENCRYPTED_DOCUMENT"],
  ["MalformedDocumentError", MalformedDocumentError, "MALFORMED_DOCUMENT"],
  ["ParseTimeoutError", ParseTimeoutError, "PARSE_TIMEOUT"],
  ["LimitExceededError", LimitExceededError, "LIMIT_EXCEEDED"],
  ["MissingDependencyError", MissingDependencyError, "MISSING_DEPENDENCY"],
  ["ParserDeclinedError", ParserDeclinedError, "PARSER_DECLINED"],
  ["AbortError", AbortError, "ABORTED"],
  ["UnsupportedRuntimeError", UnsupportedRuntimeError, "UNSUPPORTED_RUNTIME"],
];

for (const [thrown, expected, code] of CROSS_AS_ITSELF) {
  test(`typed error: ${thrown} thrown in the child arrives as the same class and code`, async () => {
    const { runner, last } = observed("throw", thrown);
    for (const output of ["text", "records"] as const) {
      const error = await runner.run({ input: bytes("x"), output }).then(
        () => assert.fail("should have thrown"),
        (e: unknown) => e,
      );
      assert.ok(error instanceof expected, `${output}: ${String(error)}`);
      assert.equal((error as RipstreamError).constructor, expected, `${output}: exact class, not a subclass`);
      assert.equal((error as RipstreamError).code, code);
      assert.equal(last().terminal, "error");
      assert.equal(last().killReason, null);
      assert.equal(last().graceKilled, false);
    }
  });
}

test("typed error: the message and the structured fields of the original survive", async () => {
  const limit = await observed("throw", "LimitExceededError").runner.run({ input: bytes("x") }).catch((e: unknown) => e);
  assert.ok(limit instanceof LimitExceededError);
  assert.equal(limit.message, "Output exceeds 5 characters");
  const missing = await observed("throw", "MissingDependencyError").runner.run({ input: bytes("x") }).catch((e: unknown) => e);
  assert.ok(missing instanceof MissingDependencyError);
  assert.equal(missing.dependency, "pdfjs-dist");
  assert.equal(missing.capability, "PDF parsing");
});

const BECOMES_CRASH: readonly string[] = [
  "WriteLimitReachedError",
  "IsolationError",
  "Error",
  "TypeError",
  "string",
];

for (const thrown of BECOMES_CRASH) {
  test(`typed error: ${thrown} thrown in the child degrades to an IsolationError crash`, async () => {
    const { runner } = observed("throw", thrown);
    const error = await runner.run({ input: bytes("x") }).then(
      () => assert.fail("should have thrown"),
      (e: unknown) => e,
    );
    assert.ok(error instanceof IsolationError, String(error));
    assert.equal(error.reason, "crash", "a child can never mint another reason");
  });
}

test("typed error: V8's 'Invalid string length' RangeError is a limit, not a crash", async () => {
  const error = await observed("throw", "invalid-string-length").runner.run({ input: bytes("x") }).catch((e: unknown) => e);
  assert.ok(error instanceof LimitExceededError, String(error));
});

// ---- hostile pipelines -------------------------------------------------------------------------

test("a synchronous hang is ended by the parent: ParseTimeoutError, and the process group is gone", async () => {
  const { runner, last } = observed("hang-sync", undefined, { maxTaskMillis: 1500 });
  const started = Date.now();
  await assert.rejects(runner.run({ input: bytes("x") }), ParseTimeoutError);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  assert.equal(last().killReason, "timeout");
  const pid = last().pid;
  assert.ok(pid !== undefined);
  await expectPidGone(pid);
});

test("a heap blow-up in the child is a LimitExceededError, not a crash", async () => {
  const { runner, last } = observed("oom", undefined, { heapMb: 64, maxTaskMillis: 30_000 });
  await assert.rejects(runner.run({ input: bytes("x") }), LimitExceededError);
  const pid = last().pid;
  assert.ok(pid !== undefined);
  await expectPidGone(pid);
});

test("a 5 MB stderr flood does not kill the child (the stderr guard of initChildProcess is installed)", async () => {
  // Behavioural guard for the structural init call: without initChildProcess() the stderr pipe closes at the
  // budget, the next write fails with EPIPE, and the 'error' event with no listener kills the child.
  const { runner, last } = observed("stderr-5mb", undefined, { stderrBudgetBytes: 64 * 1024, maxTaskMillis: 30_000 });
  const result = await runner.run({ input: bytes("x") });
  assert.equal(textOf(result), "survived-stderr");
  const d = last();
  assert.equal(d.stderrClosed, true, "the flood did reach the budget");
  assert.equal(d.killReason, null);
  assert.equal(d.code, 0);
});

for (const [mode, label, detail] of [
  ["detached-reject", "unhandled rejection", "pdf.js internal rejection"],
  ["detached-throw", "uncaught exception", "pdf.js internal timer failure"],
] as const) {
  test(`${label} outside the request: one crash error, the child exits at once with code 1`, async () => {
    // The inline PDF parser runs on the child's main thread; a fault it leaves outside its own promise chain
    // reaches the process-level handlers. Without them the process dies with no terminal frame (still a crash for
    // the parent, but with Node's default exit and no message), and an unhandledRejection under a permissive
    // setting would leave the parse hanging until the parent's deadline.
    const { runner, last } = observed(mode, undefined, { maxTaskMillis: 10_000 });
    for (const output of ["text", "records"] as const) {
      const error = await runner.run({ input: bytes("x"), output }).then(
        () => assert.fail("should have thrown"),
        (e: unknown) => e,
      );
      assert.ok(error instanceof IsolationError, `${output}: ${String(error)}`);
      assert.equal(error.reason, "crash");
      assert.ok(error.message.includes(`${label}: `) && error.message.includes(detail), error.message);
      const d = last();
      assert.equal(d.terminal, "error", "the child said what happened before it died");
      assert.equal(d.code, 1);
      assert.equal(d.killReason, null, "nobody had to kill it: it exited by itself");
      assert.ok(d.settledMs < 5000, `took ${d.settledMs} ms`);
    }
  });
}

test("a finished parse leaves no watchdog timer behind: with a 60 s parse timer the child still exits by itself", async () => {
  const { runner, last } = observed("ok");
  const result = await runner.run({ input: bytes("hello") }, { limits: { maxParseMillis: 60_000 } });
  assert.equal(textOf(result), "ok-text");
  assert.equal(last().graceKilled, false, "a ref'd 60 s timer would have kept the child alive until the grace kill");
  assert.equal(last().code, 0);
});

test("a parse that never settles ends with the child's own ParseTimeoutError, not a crash from node's exit 13", async () => {
  const { runner, last } = observed("hang-async", undefined, { maxTaskMillis: 20_000 });
  const started = Date.now();
  await assert.rejects(runner.run({ input: bytes("x") }, { limits: { maxParseMillis: 600 } }), ParseTimeoutError);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  assert.equal(last().terminal, "error", "the child said so itself");
  assert.equal(last().killReason, null, "the parent did not have to kill it");
  assert.equal(last().code, 0, "an answered verdict exits 0, not node's unsettled-await 13");
  await expectPidGone(last().pid ?? -1);
});

test("a result over the cap is a LimitExceededError, and the child does not get to finish sending it", async () => {
  const { runner, last } = observed("huge-text", "20000000", { maxResultBytes: MIB, maxTaskMillis: 30_000 });
  await assert.rejects(runner.run({ input: bytes("x") }), LimitExceededError);
  assert.ok(last().fd3Bytes < 8 * MIB, `read ${last().fd3Bytes} bytes of a 20 MB answer`);
});

test("a hostile request does not disturb concurrent normal requests", async () => {
  const hostile = [
    observed("oom", undefined, { heapMb: 64, maxTaskMillis: 30_000 }).runner,
    observed("hang-sync", undefined, { maxTaskMillis: 2000 }).runner,
    observed("throw", "Error").runner,
    observed("huge-text", "20000000", { maxResultBytes: MIB, maxTaskMillis: 30_000 }).runner,
  ];
  const normal = observed("slow", "200").runner;
  const settled = await Promise.allSettled([
    ...hostile.map((r) => r.run({ input: bytes("x") })),
    ...Array.from({ length: 4 }, () => normal.run({ input: bytes("fine") })),
  ]);
  const [oom, hang, plain, huge, ...fine] = settled;
  const show = (outcome: PromiseSettledResult<unknown> | undefined): string => {
    if (outcome === undefined) return "missing";
    if (outcome.status === "fulfilled") return "fulfilled";
    const reason = outcome.reason as { name?: string; message?: string; reason?: string };
    return `rejected ${reason?.name}${reason?.reason === undefined ? "" : `/${reason.reason}`}: ${reason?.message}`;
  };
  assert.ok(oom?.status === "rejected" && oom.reason instanceof LimitExceededError, show(oom));
  assert.ok(hang?.status === "rejected" && hang.reason instanceof ParseTimeoutError, show(hang));
  assert.ok(plain?.status === "rejected" && plain.reason instanceof IsolationError, show(plain));
  assert.ok(huge?.status === "rejected" && huge.reason instanceof LimitExceededError, show(huge));
  for (const outcome of fine) {
    assert.equal(outcome.status, "fulfilled", String(outcome.status === "rejected" ? outcome.reason : ""));
    assert.equal(textOf((outcome as PromiseFulfilledResult<IsolatedParseResult>).value), "slow-ok");
  }
});
