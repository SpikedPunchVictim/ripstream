import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Worker, type ResourceLimits } from "node:worker_threads";
import { AbortError, IsolationError, LimitExceededError, ParseTimeoutError, createRipstream } from "../src/index.ts";
import { classifyWorkerFailure } from "@spikedpunch/ripstream-isolation-node";

/**
 * tikajs-yg2g (docs/worker-hosting.md): Ripstream hosted in the caller's own Worker. A parse works with every limit set, the
 * two ways a Worker dies under a document (V8 heap exhaustion, terminate()) arrive as the events Node documents, and
 * `classifyWorkerFailure` maps each to the error the child isolator would have thrown.
 */
const HOST = fileURLToPath(new URL("./fixtures/worker/worker-host.ts", import.meta.url));
const encoder = new TextEncoder();

interface Ending {
  readonly error: unknown;
  readonly exitCode: number;
}

interface Hosted {
  readonly worker: Worker;
  /** The next message the worker posts. */
  next(): Promise<Record<string, any>>;
  /** Settles when the worker has exited, with what its 'error' and 'exit' events said. */
  ended: Promise<Ending>;
}

async function host(resourceLimits: ResourceLimits = {}): Promise<Hosted> {
  const worker = new Worker(HOST, { resourceLimits });
  const inbox: Array<Record<string, any>> = [];
  let wake: (() => void) | null = null;
  worker.on("message", (message) => {
    inbox.push(message);
    wake?.();
  });
  let error: unknown;
  worker.on("error", (value) => {
    error = value;
  });
  const ended = new Promise<Ending>((resolve) => worker.once("exit", (exitCode) => resolve({ error, exitCode })));
  const hosted: Hosted = {
    worker,
    ended,
    async next() {
      while (inbox.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      return inbox.shift()!;
    },
  };
  assert.deepEqual(await hosted.next(), { ready: true });
  return hosted;
}

test("a parse in a Worker answers as an in-process parse does, with every limit settable", async () => {
  const inProcess = createRipstream();
  const { worker, next, ended } = await host();
  try {
    const text = encoder.encode("hello worker ".repeat(20));
    worker.postMessage({ id: 1, op: "parse", bytes: text });
    const answer = await next();
    assert.equal(answer.ok, true);
    assert.equal(answer.text, (await inProcess.parse(text)).text);

    // The typed limit errors of an in-process parse, each with its limit, observed and max.
    worker.postMessage({ id: 2, op: "parse", bytes: text, limits: { maxInputBytes: 10 } });
    assert.deepEqual((await next()).error, { name: "LimitExceededError", message: `Input of ${text.length} bytes exceeds the maximum of 10 bytes`, code: "LIMIT_EXCEEDED", limit: "inputBytes", observed: text.length, max: 10 });
    worker.postMessage({ id: 3, op: "parse", bytes: text, limits: { maxOutputChars: 5 } });
    const output = (await next()).error;
    assert.equal(output.code, "LIMIT_EXCEEDED");
    assert.equal(output.limit, "outputChars");
    await assert.rejects(inProcess.parse(text, { limits: { maxOutputChars: 5 } }), (error) => error instanceof LimitExceededError && error.limit === "outputChars");
  } finally {
    await worker.terminate();
    await ended;
  }
});

test("a Worker that runs out of heap emits ERR_WORKER_OUT_OF_MEMORY, which maps to the memory limit error", async () => {
  const limits = { maxOldGenerationSizeMb: 96 };
  const { worker, ended } = await host(limits);
  worker.postMessage({ id: 1, op: "oom" });
  const ending = await ended;
  assert.equal((ending.error as { code?: string }).code, "ERR_WORKER_OUT_OF_MEMORY");
  const verdict = classifyWorkerFailure({ ...ending, maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb });
  assert.equal(verdict.kind, "out_of_memory");
  assert.equal(verdict.reason, null);
  assert.ok(verdict.error instanceof LimitExceededError);
  assert.equal(verdict.error.limit, "memory");
});

test("a terminate() is exit code 1 with no error event: a crash unless the caller ended it for its own deadline or cancellation", async () => {
  const { worker, next, ended } = await host();
  worker.postMessage({ id: 1, op: "spin" });
  assert.equal((await next()).spinning, true);
  assert.equal(await worker.terminate(), 1);
  const ending = await ended;
  assert.equal(ending.error, undefined);
  assert.equal(ending.exitCode, 1);

  const unasked = classifyWorkerFailure(ending);
  assert.equal(unasked.kind, "crash");
  assert.ok(unasked.error instanceof IsolationError);
  assert.equal(unasked.error.reason, "crash");
  assert.ok(classifyWorkerFailure({ ...ending, terminatedBy: "timeout" }).error instanceof ParseTimeoutError);
  assert.ok(classifyWorkerFailure({ ...ending, terminatedBy: "abort" }).error instanceof AbortError);
});

test("an uncaught exception in the Worker is the error event, and a crash", async () => {
  const worker = new Worker("throw new Error('boom from the worker')", { eval: true });
  const ending = await new Promise<Ending>((resolve) => {
    let error: unknown;
    worker.on("error", (value) => (error = value));
    worker.once("exit", (exitCode) => resolve({ error, exitCode }));
  });
  const verdict = classifyWorkerFailure(ending);
  assert.equal(verdict.kind, "crash");
  assert.equal(verdict.reason, "crash");
  assert.match(verdict.error.message, /boom from the worker/);
});
