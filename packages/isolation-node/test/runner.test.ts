import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { AbortError, IsolationError, LimitExceededError, ParseTimeoutError } from "@spikedpunch/ripstream-core";
import { MemoryPool } from "../src/pool.ts";
import { ChildRunner, PARENT_RESULT_SLACK_MB, parentResultMb, type ChildRunnerOptions } from "../src/runner.ts";
import { fakeSpawn } from "./fixtures/fake-child.ts";
import { CHILD, expectGroupGone } from "./fixtures/helpers.ts";
import type { RunDiagnostics } from "../src/supervisor.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

// perChildMb must be at least rssLimitMb, which must exceed heapMb (the runner enforces it).
const CHILD_MB = 512;
const HEAP_MB = 128;
const MAX_RESULT_BYTES = 1024 * 1024;
/** What the runner reserves in the parent, on top of the child, for a "text" result of MAX_RESULT_BYTES. */
const PARENT_MB = parentResultMb(MAX_RESULT_BYTES, "text");
/** One request's whole reservation. */
const ONE_MB = CHILD_MB + PARENT_MB;

/** A pool that fits exactly one child plus its parent-side result memory (no overshoot padding). */
const onePool = (maxQueue = 4): MemoryPool => new MemoryPool({ poolMb: ONE_MB, overshootMb: 0, maxQueue });

function runner(mode: string, pool: MemoryPool, overrides: Partial<ChildRunnerOptions> = {}): ChildRunner {
  return new ChildRunner({
    pool,
    childScript: CHILD,
    childArgs: [mode],
    perChildMb: CHILD_MB,
    heapMb: HEAP_MB,
    cpuSecs: 30,
    maxTaskMillis: 10_000,
    maxInputBytes: 1024 * 1024,
    maxResultBytes: MAX_RESULT_BYTES,
    rssLimitMb: CHILD_MB,
    ...overrides,
  });
}

test("run: success returns the assembled result and releases the lease", async () => {
  const pool = onePool();
  const result = await runner("echo", pool).run({ input: bytes("hi") });
  assert.equal(result.kind === "text" && result.text, "hi");
  assert.equal(pool.stats().freeMb, ONE_MB);
  assert.equal(pool.stats().running, 0);
});

test("run: a failing child still releases the lease (finally)", async () => {
  const pool = onePool();
  await assert.rejects(runner("exit-without-terminal", pool).run({ input: bytes("x") }), IsolationError);
  assert.deepEqual([pool.stats().freeMb, pool.stats().running], [ONE_MB, 0]);
});

test("run: input over maxInputBytes is refused before the pool is touched or anything is spawned", async () => {
  const pool = onePool();
  let spawned = 0;
  const r = runner("echo", pool, { maxInputBytes: 10, onRunSettled: () => spawned++ });
  await assert.rejects(r.run({ input: bytes("12345678901") }), LimitExceededError);
  assert.equal(spawned, 0);
  assert.equal(pool.stats().running, 0);
  assert.equal((await r.run({ input: bytes("1234567890") })).kind, "text"); // exactly at the cap is fine
});

test("run: a { path } input is measured against maxInputBytes too", async () => {
  const pool = onePool();
  const r = runner("echo", pool, { maxInputBytes: 10 });
  await assert.rejects(r.run({ input: { path: new URL(import.meta.url).pathname } }), LimitExceededError);
});

test("run: queue_full when the pool is busy and there is no waiting room", async () => {
  const pool = onePool(0);
  const holder = runner("hang", pool);
  const holding = holder.run({ input: bytes("x") });
  holding.catch(() => {});
  await sleep(300); // child spawned and holding the lease
  const error = await runner("echo", pool).run({ input: bytes("x") }).then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof IsolationError && error.reason === "queue_full");
  await holder.dispose();
  await assert.rejects(holding, IsolationError);
});

test("run: timeout while queued is ParseTimeoutError and leaves no waiter behind", async () => {
  const pool = onePool();
  const holder = runner("hang", pool, { maxTaskMillis: 30_000 });
  const holding = holder.run({ input: bytes("x") });
  holding.catch(() => {});
  await sleep(300);
  const waiter = runner("echo", pool, { maxTaskMillis: 300 });
  await assert.rejects(waiter.run({ input: bytes("x") }), ParseTimeoutError);
  assert.equal(pool.stats().queued, 0);
  await holder.dispose();
  await holding.catch(() => {});
});

test("run: abort while queued is AbortError and the waiter is dequeued", async () => {
  const pool = onePool();
  const holder = runner("hang", pool, { maxTaskMillis: 30_000 });
  const holding = holder.run({ input: bytes("x") });
  holding.catch(() => {});
  await sleep(300);
  const controller = new AbortController();
  const waiting = runner("echo", pool).run({ input: bytes("x") }, { signal: controller.signal });
  await sleep(50);
  assert.equal(pool.stats().queued, 1);
  controller.abort();
  await assert.rejects(waiting, AbortError);
  assert.equal(pool.stats().queued, 0);
  await holder.dispose();
  await holding.catch(() => {});
});

test("run: abort mid-run kills the child and releases the lease", async () => {
  const pool = onePool();
  const diagnostics: RunDiagnostics[] = [];
  const r = runner("hang", pool, { onRunSettled: (d) => diagnostics.push(d) });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);
  await assert.rejects(r.run({ input: bytes("x") }, { signal: controller.signal }), AbortError);
  assert.equal(pool.stats().freeMb, ONE_MB);
  assert.equal(diagnostics[0]?.killReason, "abort");
  await expectGroupGone(diagnostics[0]?.pid);
});

test("run: queue wait counts against the task budget (one shared deadline)", async () => {
  const pool = onePool();
  const holder = runner("hang", pool, { maxTaskMillis: 30_000 });
  const holding = holder.run({ input: bytes("x") });
  holding.catch(() => {});
  await sleep(300);
  // The waiter has 1500 ms in total. Release the holder after ~600 ms; the waiter's hanging child then
  // only has the remaining ~900 ms. If queue wait were not counted it would run a further 1500 ms.
  const waiter = runner("hang", pool, { maxTaskMillis: 1500 });
  setTimeout(() => void holder.dispose(), 600);
  const started = performance.now();
  await assert.rejects(waiter.run({ input: bytes("x") }), ParseTimeoutError);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500 + 400, `waiter took ${Math.round(elapsed)} ms; queue wait must be part of the 1500 ms budget`);
  await holding.catch(() => {});
});

test("dispose: rejects waiters, kills in-flight children, refuses new work", async () => {
  const pool = onePool();
  const diagnostics: RunDiagnostics[] = [];
  const r = runner("hang", pool, { onRunSettled: (d) => diagnostics.push(d) });
  const running = r.run({ input: bytes("x") });
  const waiting = r.run({ input: bytes("y") });
  running.catch(() => {});
  waiting.catch(() => {});
  await sleep(300);
  assert.deepEqual([pool.stats().running, pool.stats().queued], [1, 1]);
  await r.dispose();
  for (const promise of [running, waiting]) {
    const error = await promise.then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof IsolationError && error.reason === "unavailable", String(error));
  }
  assert.deepEqual([pool.stats().freeMb, pool.stats().queued, pool.stats().running], [ONE_MB, 0, 0]);
  await expectGroupGone(diagnostics[0]?.pid);
  await assert.rejects(r.run({ input: bytes("z") }), IsolationError);
});

test("the pool is shared: two runners draw on one gate", async () => {
  const pool = onePool(0);
  const a = runner("hang", pool);
  const holding = a.run({ input: bytes("x") });
  holding.catch(() => {});
  await sleep(300);
  assert.equal(pool.stats().running, 1);
  const error = await runner("echo", pool).run({ input: bytes("x") }).then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof IsolationError && error.reason === "queue_full");
  await a.dispose();
  await holding.catch(() => {});
});

test("constructor rejects non-positive sizes", () => {
  assert.throws(() => runner("echo", onePool(), { maxInputBytes: 0 }), RangeError);
  assert.throws(() => runner("echo", onePool(), { cpuSecs: 1.5 }), RangeError);
});

// ---- the size relation heapMb < rssLimitMb <= perChildMb (F9) ---------------------------------

test("constructor: heapMb must be below rssLimitMb, which must not exceed perChildMb; the error names the numbers", () => {
  const message = (overrides: Partial<ChildRunnerOptions>): string => {
    try {
      runner("echo", onePool(), overrides);
    } catch (error) {
      assert.ok(error instanceof RangeError, String(error));
      return error.message;
    }
    return assert.fail("expected a RangeError");
  };
  assert.match(message({ heapMb: 512 }), /heapMb=512, rssLimitMb=512, perChildMb=512/); // equal: the heap alone trips the limit
  assert.match(message({ heapMb: 600 }), /heapMb=600/);
  assert.match(message({ rssLimitMb: 600 }), /rssLimitMb=600, perChildMb=512/); // admitted for less than it may use
  assert.match(message({ perChildMb: 256, rssLimitMb: 300 }), /perChildMb=256/);
});

test("constructor: the boundary values heapMb = rssLimitMb - 1 and rssLimitMb = perChildMb are accepted", () => {
  assert.doesNotThrow(() => runner("echo", onePool(), { heapMb: CHILD_MB - 1, rssLimitMb: CHILD_MB, perChildMb: CHILD_MB }));
});

// ---- parent-side memory for the result is reserved at admission (F1c) ------------------------------

test("parentResultMb: rounds up, adds the fixed slack, and is larger for records than for text", () => {
  assert.equal(PARENT_RESULT_SLACK_MB, 96);
  assert.equal(parentResultMb(1, "text"), 1 + 96);
  assert.equal(parentResultMb(1024 * 1024, "text"), 6 + 96);
  assert.equal(parentResultMb(1024 * 1024, undefined), 6 + 96);
  assert.equal(parentResultMb(1024 * 1024, "records"), 24 + 96);
  assert.equal(parentResultMb(1_500_000, "text"), 9 + 96); // 8.58 MiB
});

/** A runner whose spawn always throws, recording what the pool had reserved at that moment. */
async function reservedAtSpawn(output: "text" | "records" | undefined, overrides: Partial<ChildRunnerOptions> = {}): Promise<number> {
  const pool = new MemoryPool({ poolMb: 4096, overshootMb: 0, maxQueue: 4 });
  let reserved = -1;
  const r = runner("echo", pool, {
    spawnFn: () => {
      reserved = pool.stats().reservedMb;
      throw new Error("not spawning");
    },
    ...overrides,
  });
  await assert.rejects(r.run({ input: bytes("x"), ...(output === undefined ? {} : { output }) }), IsolationError);
  assert.equal(pool.stats().reservedMb, 0, "the reservation must be returned once nothing was spawned");
  return reserved;
}

test("run: the pool reservation is the child plus maxResultBytes x factor plus the fixed slack, for the requested output", async () => {
  assert.equal(await reservedAtSpawn(undefined), CHILD_MB + 6 + 96);
  assert.equal(await reservedAtSpawn("text"), CHILD_MB + 6 + 96);
  assert.equal(await reservedAtSpawn("records"), CHILD_MB + 24 + 96);
  assert.equal(await reservedAtSpawn("records", { maxResultBytes: 10 * 1024 * 1024 }), CHILD_MB + 240 + 96);
});

test("run: a pool that fits the child but not child + parent memory is unavailable, not queued forever", async () => {
  const tight = new MemoryPool({ poolMb: ONE_MB - 1, overshootMb: 0, maxQueue: 4 });
  const error = await runner("echo", tight).run({ input: bytes("x") }).then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof IsolationError && error.reason === "unavailable", String(error));
  assert.match((error as Error).message, /parent result memory/);
  // The same pool is big enough for a text request but not a records request.
  const textOnly = new MemoryPool({ poolMb: ONE_MB, overshootMb: 0, maxQueue: 4 });
  assert.equal((await runner("echo", textOnly).run({ input: bytes("x") })).kind, "text");
  const recordsError = await runner("records", textOnly)
    .run({ input: bytes("x"), output: "records" })
    .then(() => undefined, (e: unknown) => e);
  assert.ok(recordsError instanceof IsolationError && recordsError.reason === "unavailable", String(recordsError));
});

// ---- the lease belongs to the child, not to the caller's promise (F4) ------------------------------

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
};

test("a child that survives its kill: the caller is answered, the lease is held until the child is really dead", async () => {
  const pool = onePool();
  const { spawnFn, children } = fakeSpawn();
  const r = runner("unused", pool, { spawnFn, reapWaitMs: 30 });
  const controller = new AbortController();
  const first = r.run({ input: bytes("one") }, { signal: controller.signal });
  first.catch(() => {});
  await waitFor(() => children.length === 1, "the first spawn");
  const second = r.run({ input: bytes("two") });
  second.catch(() => {});
  await waitFor(() => pool.stats().queued === 1, "the second request to queue");

  controller.abort();
  await assert.rejects(first, AbortError); // answered promptly...
  await sleep(100);
  assert.equal(pool.stats().running, 1, "...but its memory is still reserved: the child is not dead");
  assert.equal(pool.stats().queued, 1, "so the queued request has not been admitted on top of it");
  assert.equal(children.length, 1);

  children[0]?.exit(null, "SIGKILL"); // the kernel finally reaps it
  await waitFor(() => children.length === 2, "the queued request to be admitted and spawned");
  assert.equal(pool.stats().queued, 0);
  assert.equal(pool.stats().running, 1);

  const second2 = children[1];
  second2?.writeFd3('{"t":"meta","metadata":{}}\n{"t":"text","chunk":"two"}\n{"t":"done"}\n');
  second2?.exit(0, null);
  second2?.close();
  const result = await second;
  assert.equal(result.kind === "text" && result.text, "two");
  await waitFor(() => pool.stats().running === 0, "the second lease to be released");
  assert.equal(pool.stats().freeMb, ONE_MB);
});

test("dispose is bounded: it returns after disposeWaitMs even if a killed child is never reaped", async () => {
  const pool = onePool();
  const { spawnFn, children } = fakeSpawn();
  const r = runner("unused", pool, { spawnFn, reapWaitMs: 20, disposeWaitMs: 150 });
  const running = r.run({ input: bytes("x") });
  running.catch(() => {});
  await waitFor(() => children.length === 1, "the spawn");
  const started = performance.now();
  await r.dispose();
  const waited = performance.now() - started;
  assert.ok(waited >= 130 && waited < 1500, `dispose took ${Math.round(waited)} ms; it should wait about disposeWaitMs (150)`);
  const error = await running.then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof IsolationError && error.reason === "unavailable", String(error));
  assert.equal(pool.stats().running, 1, "the unreaped child still holds its lease");
  children[0]?.exit(null, "SIGKILL");
  await waitFor(() => pool.stats().running === 0, "the lease to be released when the child finally dies");
});

test("dispose returns as soon as the killed children are dead, long before disposeWaitMs", async () => {
  const pool = onePool();
  const { spawnFn, children } = fakeSpawn();
  const r = runner("unused", pool, { spawnFn, reapWaitMs: 20, disposeWaitMs: 30_000 });
  const running = r.run({ input: bytes("x") });
  running.catch(() => {});
  await waitFor(() => children.length === 1, "the spawn");
  setTimeout(() => children[0]?.exit(null, "SIGKILL"), 60);
  const started = performance.now();
  await r.dispose();
  const waited = performance.now() - started;
  assert.ok(waited < 2000, `dispose took ${Math.round(waited)} ms`);
  assert.equal(pool.stats().running, 0, "dispose resolves only after the lease was returned");
  assert.equal(pool.stats().freeMb, ONE_MB);
  await running.catch(() => {});
});

test("constructor: disposeWaitMs must be a non-negative number", () => {
  assert.throws(() => runner("echo", onePool(), { disposeWaitMs: -1 }), RangeError);
  assert.throws(() => runner("echo", onePool(), { disposeWaitMs: Number.NaN }), RangeError);
});

// ---- per-call unavailable is never a fallback (F10) -------------------------------------------------

test("a transient spawn failure rejects that call with unavailable and returns the lease; the next call works", async () => {
  const pool = onePool();
  let calls = 0;
  const r = runner("echo", pool, {
    spawnFn: (file, args, options) => {
      if (++calls === 1) throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
      return spawn(file, args, options);
    },
  });
  const error = await r.run({ input: bytes("first") }).then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof IsolationError && error.reason === "unavailable", String(error));
  assert.deepEqual([pool.stats().freeMb, pool.stats().running], [ONE_MB, 0]);
  const result = await r.run({ input: bytes("second") });
  assert.equal(result.kind === "text" && result.text, "second");
  assert.equal(calls, 2);
});

test("N19: dispose() holds the process open until it returns, even when nothing else is pending", async () => {
  // A real process: its only remaining handle after the kill is dispose()'s own bounded wait. With that timer
  // unref'd, Node would exit (code 13, unsettled top-level await) before dispose resolved.
  const fixture = new URL("./fixtures/dispose-parent.ts", import.meta.url).pathname;
  const parent = spawn(process.execPath, [...process.execArgv.filter((arg) => !arg.startsWith("--test")), fixture], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  parent.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  parent.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => parent.once("close", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stdout, "DISPOSED after the wait\n");
});

// ---- R7: how many children have answered their caller but not died --------------------------------------

test("unreapedChildren counts children whose caller was answered but that are not dead yet", async () => {
  const pool = onePool();
  const { spawnFn, children } = fakeSpawn();
  const r = runner("unused", pool, { spawnFn, reapWaitMs: 20 });
  assert.equal(r.unreapedChildren, 0);
  const controller = new AbortController();
  const running = r.run({ input: bytes("x") }, { signal: controller.signal });
  running.catch(() => {});
  await waitFor(() => children.length === 1, "the spawn");
  assert.equal(r.unreapedChildren, 0, "a child that is merely running is not unreaped");

  controller.abort();
  await assert.rejects(running, AbortError);
  await waitFor(() => r.unreapedChildren === 1, "the unreaped child to be counted");
  assert.equal(pool.stats().running, 1, "and its lease is what keeps later requests waiting");

  children[0]?.exit(null, "SIGKILL");
  await waitFor(() => r.unreapedChildren === 0, "the count to drop when the child is finally reaped");
  await waitFor(() => pool.stats().running === 0, "the lease");
});

test("unreapedChildren stays 0 for children that die before the caller hears the result", async () => {
  const r = runner("echo", onePool());
  await r.run({ input: bytes("hi") });
  await assert.rejects(runner("exit-without-terminal", onePool()).run({ input: bytes("x") }), IsolationError);
  await sleep(50);
  assert.equal(r.unreapedChildren, 0);
});

test("unreapedChildren survives dispose: a child that outlives dispose is still counted", async () => {
  const pool = onePool();
  const { spawnFn, children } = fakeSpawn();
  const r = runner("unused", pool, { spawnFn, reapWaitMs: 20, disposeWaitMs: 50 });
  const running = r.run({ input: bytes("x") });
  running.catch(() => {});
  await waitFor(() => children.length === 1, "the spawn");
  await r.dispose();
  await running.catch(() => {});
  assert.equal(r.unreapedChildren, 1);
  children[0]?.exit(null, "SIGKILL");
  await waitFor(() => r.unreapedChildren === 0, "the count to drop");
});
