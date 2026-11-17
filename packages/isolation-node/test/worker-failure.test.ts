import assert from "node:assert/strict";
import { test } from "node:test";
import { AbortError, IsolationError, LimitExceededError, ParseTimeoutError } from "@spikedpunch/ripstream-core";
import { classifyWorkerFailure, type WorkerFailureFacts } from "../src/worker-failure.ts";

const coded = (code: string, message = "m"): Error => Object.assign(new Error(message), { code });

type Row = readonly [label: string, facts: WorkerFailureFacts, kind: string, reason: string | null, errorClass: unknown];

const ROWS: readonly Row[] = [
  ["out of memory", { error: coded("ERR_WORKER_OUT_OF_MEMORY") }, "out_of_memory", null, LimitExceededError],
  ["out of memory then the exit event", { error: coded("ERR_WORKER_OUT_OF_MEMORY"), exitCode: 1 }, "out_of_memory", null, LimitExceededError],
  ["out of memory beats a terminate the caller sent for a deadline", { error: coded("ERR_WORKER_OUT_OF_MEMORY"), terminatedBy: "timeout" }, "out_of_memory", null, LimitExceededError],
  ["terminate() for a deadline", { exitCode: 1, terminatedBy: "timeout" }, "timeout", null, ParseTimeoutError],
  ["terminate() for a cancellation", { exitCode: 1, terminatedBy: "abort" }, "abort", null, AbortError],
  ["init failed", { error: coded("ERR_WORKER_INIT_FAILED") }, "init_failed", "unavailable", IsolationError],
  ["invalid exec argv", { error: coded("ERR_WORKER_INVALID_EXEC_ARGV") }, "init_failed", "unavailable", IsolationError],
  ["an uncaught exception", { error: new TypeError("boom"), exitCode: 1 }, "crash", "crash", IsolationError],
  ["an unserializable error", { error: coded("ERR_WORKER_UNSERIALIZABLE_ERROR") }, "crash", "crash", IsolationError],
  ["a terminate() nobody here asked for", { exitCode: 1 }, "crash", "crash", IsolationError],
  ["a clean exit without an answer", { exitCode: 0 }, "crash", "crash", IsolationError],
  ["a thrown non-Error", { error: "plain string" }, "crash", "crash", IsolationError],
];

for (const [label, facts, kind, reason, errorClass] of ROWS) {
  test(`classifyWorkerFailure: ${label}`, () => {
    const verdict = classifyWorkerFailure(facts);
    assert.equal(verdict.kind, kind);
    assert.equal(verdict.reason, reason);
    assert.ok(verdict.error instanceof (errorClass as new (...args: never[]) => Error), verdict.error.constructor.name);
    if (verdict.error instanceof IsolationError) assert.equal(verdict.error.reason, reason);
  });
}

test("classifyWorkerFailure: an out-of-memory failure is the memory limit error the isolator gives, with the heap size and the cause", () => {
  const death = coded("ERR_WORKER_OUT_OF_MEMORY");
  const { error } = classifyWorkerFailure({ error: death, maxOldGenerationSizeMb: 64 });
  assert.ok(error instanceof LimitExceededError);
  assert.equal(error.limit, "memory");
  assert.match(error.message, /\(64 MB heap\)/);
  assert.equal(error.cause, death);
});

test("classifyWorkerFailure: a crash names what happened on one line, whatever the worker's text holds", () => {
  const { error } = classifyWorkerFailure({ error: new Error("line one\nline two\u0000"), exitCode: 1 });
  assert.match(error.message, /^The parse worker stopped: it threw: line one line two/);
  assert.doesNotMatch(error.message, /[\n\u0000]/);
  assert.match(classifyWorkerFailure({ exitCode: 7 }).error.message, /exited with code 7/);
});

test("classifyWorkerFailure: facts that name nothing are refused", () => {
  assert.throws(() => classifyWorkerFailure({}), TypeError);
  assert.throws(() => classifyWorkerFailure(null as never), TypeError);
});

test("classifyWorkerFailure: never answers queue_full, a Worker has no pool", () => {
  for (const [, facts] of ROWS) assert.notEqual(classifyWorkerFailure(facts).reason, "queue_full");
});
