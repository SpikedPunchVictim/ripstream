import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AbortError,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  ParseTimeoutError,
  type IsolatedParseRequest,
  type IsolatedParseResult,
} from "@spikedpunch/ripstream-core";
import { MemoryPool } from "../src/pool.ts";
import type { ResolvedReuse } from "../src/reuse.ts";
import { parentResultMb } from "../src/runner.ts";
import type { RunDiagnostics } from "../src/supervisor.ts";
import { WarmRunner, type ChildRetireReason, type WarmRunnerOptions } from "../src/warm.ts";
import { expectGroupGone, TEST_TEMP_DIR } from "./fixtures/helpers.ts";

/**
 * Reused children (warm.ts) in REAL processes: fixtures/warm-main.ts is the real runChildMain around a fake pipeline
 * that each request's input steers ("ok", "throw", "spill", ...), and answers with its pid and how many requests it
 * has parsed. So "reused" and "fresh" are checked by pid, and every fault is followed by a request that must succeed
 * in a NEW process.
 */

const WARM = fileURLToPath(new URL("./fixtures/warm-main.ts", import.meta.url));
const MIB = 1024 * 1024;
const CHILD_MB = 512;
const PARENT_MB = parentResultMb(MIB, "text");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const runners: WarmRunner[] = [];
after(async () => {
  await Promise.all(runners.map((runner) => runner.dispose()));
});

function reuse(overrides: Partial<ResolvedReuse> = {}): ResolvedReuse {
  return {
    trustDomain: "tenant-a",
    maxRequests: 100,
    rssCeilingMb: 400,
    rssSampleEvery: 1000,
    idleTimeoutMs: 30_000,
    maxIdleChildren: 4,
    maxTrustDomains: 8,
    ...overrides,
  };
}

/** A pool for `children` children and their result memory, no overshoot. */
function poolFor(children: number, maxQueue = 64): MemoryPool {
  return new MemoryPool({ poolMb: children * (CHILD_MB + PARENT_MB), overshootMb: 0, maxQueue });
}

function warm(
  options: { readonly reuse?: Partial<ResolvedReuse>; readonly pool?: MemoryPool } & Partial<Omit<WarmRunnerOptions, "reuse" | "pool">> = {},
): { runner: WarmRunner; pool: MemoryPool; seen: RunDiagnostics[] } {
  const { reuse: reuseOverrides, pool = poolFor(4), ...rest } = options;
  const seen: RunDiagnostics[] = [];
  const runner = new WarmRunner({
    pool,
    childScript: WARM,
    perChildMb: CHILD_MB,
    heapMb: 128,
    cpuSecs: 30,
    maxTaskMillis: 20_000,
    maxInputBytes: MIB,
    maxResultBytes: MIB,
    rssLimitMb: CHILD_MB,
    tempDir: TEST_TEMP_DIR,
    onRunSettled: (d) => seen.unshift(d),
    reuse: reuse(reuseOverrides),
    ...rest,
  });
  runners.push(runner);
  return { runner, pool, seen };
}

interface Answer {
  readonly pid: number;
  /** Requests this process has parsed, this one included. */
  readonly parsed: number;
  readonly text: string;
}

function answerOf(result: IsolatedParseResult): Answer {
  const metadata = result.kind === "text" ? result.metadata : result.records[0]!.metadata;
  const text = result.kind === "text" ? result.text : result.records[0]!.content;
  return { pid: Number(metadata["pid"]?.[0]), parsed: Number(metadata["parsed"]?.[0]), text };
}

async function ask(runner: WarmRunner, command: string, options: Parameters<WarmRunner["run"]>[1] = {}, request: Partial<IsolatedParseRequest> = {}): Promise<Answer> {
  return answerOf(await runner.run({ input: bytes(command), ...request }, options));
}

function retired(runner: WarmRunner, reason: ChildRetireReason): number {
  return runner.stats().retired[reason] ?? 0;
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await sleep(10);
  }
}

// ---- reuse ------------------------------------------------------------------------------------

test("a clean answer keeps the child: the next request of the same domain runs in the same process", async () => {
  const { runner } = warm();
  const first = await ask(runner, "ok");
  const second = await ask(runner, "ok");
  assert.equal(second.pid, first.pid);
  assert.deepEqual([first.parsed, second.parsed], [1, 2]);
  assert.deepEqual(
    { ...runner.stats(), retired: undefined },
    { domains: 1, idle: 1, busy: 0, spawned: 1, reused: 1, retried: 0, retired: undefined },
  );
  assert.equal(runner.unreapedChildren, 0);
});

test("recycle at maxRequests: the Nth request is the child's last, the next one starts a new process", async () => {
  const { runner } = warm({ reuse: { maxRequests: 3 } });
  const answers = [];
  for (let i = 0; i < 4; i++) answers.push(await ask(runner, "ok"));
  assert.deepEqual(answers.map((a) => a.parsed), [1, 2, 3, 1]);
  assert.equal(new Set(answers.slice(0, 3).map((a) => a.pid)).size, 1);
  assert.notEqual(answers[3]!.pid, answers[0]!.pid);
  assert.equal(retired(runner, "max_requests"), 1);
  await expectGroupGone(answers[0]!.pid);
});

test("a child is kept only for its heap size: a request with another heapMb gets another child", async () => {
  const { runner } = warm();
  const a = await ask(runner, "ok");
  const b = await ask(runner, "ok", { limits: { heapMb: 96 } });
  const c = await ask(runner, "ok");
  assert.notEqual(b.pid, a.pid);
  assert.equal(c.pid, a.pid);
});

// ---- trust domains ------------------------------------------------------------------------------

test("different trust domains never share a child", async () => {
  const { runner } = warm();
  const pids: Record<string, number[]> = { a: [], b: [] };
  for (const domain of ["a", "b", "a", "b", "b", "a"] as const) {
    pids[domain]!.push((await ask(runner, "ok", { trustDomain: domain })).pid);
  }
  assert.equal(new Set(pids["a"]).size, 1);
  assert.equal(new Set(pids["b"]).size, 1);
  assert.notEqual(pids["a"]![0], pids["b"]![0]);
  assert.equal(runner.stats().domains, 2);
});

test("a request that names no domain uses the configured one", async () => {
  const { runner } = warm({ reuse: { trustDomain: "x" } });
  const implicit = await ask(runner, "ok");
  const explicit = await ask(runner, "ok", { trustDomain: "x" });
  const other = await ask(runner, "ok", { trustDomain: "y" });
  assert.equal(explicit.pid, implicit.pid);
  assert.notEqual(other.pid, implicit.pid);
});

test("maxTrustDomains: a new domain clears the least recently used idle domain", async () => {
  const { runner } = warm({ reuse: { maxTrustDomains: 2 } });
  const a = await ask(runner, "ok", { trustDomain: "a" });
  await ask(runner, "ok", { trustDomain: "b" });
  await ask(runner, "ok", { trustDomain: "c" }); // a is the least recently used
  assert.equal(runner.stats().domains, 2);
  assert.equal(retired(runner, "evicted"), 1);
  await expectGroupGone(a.pid);
  assert.notEqual((await ask(runner, "ok", { trustDomain: "a" })).pid, a.pid);
});

test("maxTrustDomains: when every domain has a busy child, the extra domain's child serves one request", async () => {
  const { runner } = warm({ reuse: { maxTrustDomains: 1 } });
  const busy = ask(runner, "slow:400", { trustDomain: "a" });
  await sleep(50);
  const b1 = await ask(runner, "ok", { trustDomain: "b" });
  assert.equal(retired(runner, "single_use"), 1);
  await expectGroupGone(b1.pid);
  await busy;
  const a2 = await ask(runner, "ok", { trustDomain: "a" });
  assert.equal(a2.parsed, 2, "domain a kept its child");
});

test("maxIdleChildren: parking one child too many retires the least recently used idle child", async () => {
  const { runner } = warm({ reuse: { maxIdleChildren: 1 } });
  const a = await ask(runner, "ok", { trustDomain: "a" });
  await ask(runner, "ok", { trustDomain: "b" });
  assert.equal(runner.stats().idle, 1);
  assert.equal(retired(runner, "evicted"), 1);
  await expectGroupGone(a.pid);
});

// ---- idle children --------------------------------------------------------------------------------

test("idle reaping: a child idle for idleTimeoutMs is retired, and the next request starts a new one", async () => {
  const { runner } = warm({ reuse: { idleTimeoutMs: 250 } });
  const first = await ask(runner, "ok");
  await expectGroupGone(first.pid, 3000);
  await until(() => runner.stats().idle === 0);
  assert.equal(retired(runner, "idle_timeout"), 1);
  assert.equal(runner.stats().domains, 0);
  const next = await ask(runner, "ok");
  assert.equal(next.parsed, 1);
});

test("a child that dies while idle is never checked out: the next request gets a new child and succeeds", async () => {
  const { runner } = warm();
  const leaving = await ask(runner, "exit-later");
  await expectGroupGone(leaving.pid);
  await until(() => retired(runner, "exit") === 1);
  const next = await ask(runner, "ok");
  assert.notEqual(next.pid, leaving.pid);
  assert.equal(next.parsed, 1);
});

test("a reused child that dies before it began the request: the request runs once more, on a new child, and succeeds", async () => {
  const { runner, seen } = warm();
  const first = await ask(runner, "die-before-accept");
  const answer = await ask(runner, "ok");
  assert.notEqual(answer.pid, first.pid, "the answer came from a new process");
  assert.equal(answer.parsed, 1);
  assert.equal(answer.text, "ok");
  assert.equal(runner.stats().retried, 1);
  assert.equal(runner.stats().spawned, 2);
  await expectGroupGone(first.pid);
  assert.equal(runner.unreapedChildren, 0);
  assert.equal(seen.length, 3, "the failed attempt is reported like any other run");
});

test("a reused child that dies parsing the request (after it accepted it) is never retried", async () => {
  const { runner } = warm();
  const first = await ask(runner, "ok");
  const error = await ask(runner, "segv").then(
    () => assert.fail("should have failed"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof IsolationError && error.reason === "crash", String(error));
  assert.equal(runner.stats().retried, 0);
  await expectGroupGone(first.pid);
});

test("an idle child does not keep the parent's event loop alive", async () => {
  const { runner } = warm();
  await ask(runner, "ok");
  const kinds = process.getActiveResourcesInfo();
  assert.equal(runner.stats().idle, 1);
  // The child, its pipes and the idle timer are unref'd: none of them is reported as keeping the loop alive.
  assert.ok(!kinds.includes("ChildProcess"), kinds.join(","));
});

// ---- faults: each retires the child, the next request runs in a fresh one ----------------------------

const FAULTS: readonly {
  readonly command: string;
  readonly expect: (error: unknown) => boolean;
  readonly reason: ChildRetireReason;
  readonly options?: Partial<Omit<WarmRunnerOptions, "reuse" | "pool">>;
}[] = [
  { command: "throw", expect: (e) => e instanceof MalformedDocumentError, reason: "error_frame" },
  {
    command: "uncaught", // the crash frame arrives before the exit
    expect: (e) => e instanceof IsolationError && e.reason === "crash",
    reason: "error_frame",
  },
  { command: "segv", expect: (e) => e instanceof IsolationError && e.reason === "crash", reason: "exit" },
  { command: "hang-sync", expect: (e) => e instanceof ParseTimeoutError, reason: "timeout", options: { maxTaskMillis: 1500 } },
  { command: "hang-async", expect: (e) => e instanceof ParseTimeoutError, reason: "timeout", options: { maxTaskMillis: 1500 } },
  { command: "oom", expect: (e) => e instanceof LimitExceededError, reason: "exit", options: { heapMb: 64 } },
];

for (const fault of FAULTS) {
  test(`fault "${fault.command}" on a reused child: ${fault.reason}, the group is gone, the next request runs in a new child`, async () => {
    const { runner } = warm(fault.options ?? {});
    const before = await ask(runner, "ok");
    const error = await ask(runner, fault.command).then(
      () => assert.fail("should have failed"),
      (e: unknown) => e,
    );
    assert.ok(fault.expect(error), String(error));
    assert.equal(runner.stats().reused, 1, "the fault ran on the reused child");
    assert.equal(retired(runner, fault.reason), 1, JSON.stringify(runner.stats().retired));
    await expectGroupGone(before.pid);
    const next = await ask(runner, "ok");
    assert.notEqual(next.pid, before.pid);
    assert.equal(next.parsed, 1);
    assert.equal(runner.unreapedChildren, 0);
  });
}

test("abort of a request on a reused child kills that child; the next request runs in a new child", async () => {
  const { runner } = warm();
  const before = await ask(runner, "ok");
  const controller = new AbortController();
  const pending = ask(runner, "hang-async", { signal: controller.signal });
  await sleep(150);
  controller.abort();
  await assert.rejects(pending, AbortError);
  assert.equal(retired(runner, "abort"), 1);
  await expectGroupGone(before.pid);
  assert.equal((await ask(runner, "ok")).parsed, 1);
});

test("a result over the cap retires the child (limit hit)", async () => {
  const { runner } = warm({ maxResultBytes: 64 * 1024 });
  const before = await ask(runner, "ok");
  await assert.rejects(ask(runner, "big:200000"), LimitExceededError);
  assert.equal(retired(runner, "result_cap"), 1);
  await expectGroupGone(before.pid);
});

test("a result that carries an exception is answered, then the child is retired", async () => {
  const { runner } = warm();
  const result = await runner.run({ input: bytes("exception") });
  assert.equal(result.kind === "text" && result.exception?.name, "MalformedDocumentError");
  assert.equal(retired(runner, "exception"), 1);
  await expectGroupGone(answerOf(result).pid);
});

test("a result with a tk:exception: key is answered, then the child is retired", async () => {
  const { runner } = warm();
  const answer = await ask(runner, "tk-key");
  assert.equal(answer.text, "partial");
  assert.equal(retired(runner, "exception"), 1);
  await expectGroupGone(answer.pid);
});

test("a frame after the answer (nobody asked) retires the child", async () => {
  const { runner } = warm();
  const answer = await ask(runner, "late");
  assert.equal(answer.text, "answered", "the answer itself stands");
  await until(() => retired(runner, "protocol") === 1);
  await expectGroupGone(answer.pid);
  assert.notEqual((await ask(runner, "ok")).pid, answer.pid);
});

test("a child that spends its stderr budget is retired", async () => {
  const { runner } = warm({ stderrBudgetBytes: 1024 });
  const answer = await ask(runner, "stderr:4096");
  assert.equal(answer.text, "noisy");
  await until(() => retired(runner, "stderr_budget") === 1);
  await expectGroupGone(answer.pid);
});

// ---- temp directory --------------------------------------------------------------------------------

test("a file left in TMPDIR retires the child, and its directory is gone when the caller is answered", async () => {
  const { runner, seen } = warm();
  const before = await ask(runner, "ok");
  const spilled = await ask(runner, "spill");
  assert.equal(spilled.pid, before.pid);
  assert.equal(spilled.text, "spilled", "the answer itself stands");
  const callDir = seen[0]!.callDir;
  assert.ok(callDir !== null);
  assert.equal(existsSync(callDir), false, `${callDir} still exists`);
  assert.equal(retired(runner, "temp_leftover"), 1);
  await expectGroupGone(before.pid);
  assert.equal((await ask(runner, "ok")).parsed, 1);
});

test("a large input (several pipe buffers) on a reused child is consumed whole, and the child is kept", async () => {
  const { runner } = warm({ maxInputBytes: 4 * MIB });
  const first = await ask(runner, "ok");
  const big = await ask(runner, `ok:${"x".repeat(2 * MIB)}`);
  const after = await ask(runner, "ok");
  assert.deepEqual([big.pid, after.pid], [first.pid, first.pid]);
  assert.equal(after.parsed, 3);
  assert.equal(retired(runner, "protocol"), 0);
});

test("a child that cleans up after itself is kept", async () => {
  const { runner } = warm();
  const cleaned = await ask(runner, "spill-clean");
  const next = await ask(runner, "ok");
  assert.equal(next.pid, cleaned.pid);
  assert.equal(retired(runner, "temp_leftover"), 0);
});

// ---- CPU per request ---------------------------------------------------------------------------------

test("CPU is a per-request budget: what one request adds is compared, not the process total (sampler seam)", async () => {
  let cpu = 0;
  const { runner } = warm({ cpuSecs: 1, cpuSampler: () => cpu, cpuPollMs: 60_000 });
  cpu = 0.6;
  const a = await ask(runner, "ok");
  cpu = 1.4; // +0.8: within the budget although the total is past it
  const b = await ask(runner, "ok");
  assert.equal(b.pid, a.pid);
  cpu = 2.5; // +1.1
  await assert.rejects(ask(runner, "ok"), (e: unknown) => e instanceof LimitExceededError && /CPU time/.test(e.message));
  assert.equal(retired(runner, "cpu"), 1);
  await expectGroupGone(a.pid);
});

test("CPU that cannot be measured after a request retires the child (the answer stands)", async () => {
  const { runner } = warm({ cpuSampler: () => null, cpuPollMs: 60_000 });
  const answer = await ask(runner, "ok");
  assert.equal(answer.text, "ok");
  assert.equal(retired(runner, "cpu_unmeasured"), 1);
  await expectGroupGone(answer.pid);
});

test("CPU, real: three requests of 0.4 s each on one child with a 1 s budget all succeed", async () => {
  const { runner } = warm({ cpuSecs: 1 });
  const answers = [];
  for (let i = 0; i < 3; i++) answers.push(await ask(runner, "burn:400"));
  assert.equal(new Set(answers.map((a) => a.pid)).size, 1, "the process total passed 1 s; no request did");
  assert.equal(retired(runner, "cpu"), 0);
});

test("CPU, real: a request that burns past its budget is killed during the request", async () => {
  const { runner } = warm({ cpuSecs: 1, cpuPollMs: 100 });
  const before = await ask(runner, "ok");
  const started = Date.now();
  await assert.rejects(ask(runner, "burn:10000"), (e: unknown) => e instanceof LimitExceededError && /CPU time/.test(e.message));
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  assert.equal(retired(runner, "cpu"), 1);
  await expectGroupGone(before.pid);
});

// ---- RSS ceiling -------------------------------------------------------------------------------------

test("RSS ceiling, real: a child holding more than the ceiling after a request is retired", async () => {
  const { runner } = warm({ reuse: { rssCeilingMb: 200, rssSampleEvery: 1 } });
  const small = await ask(runner, "ok");
  const big = await ask(runner, "retain:300");
  assert.equal(big.pid, small.pid, "the first request stayed under the ceiling");
  assert.equal(retired(runner, "rss_ceiling"), 1);
  await expectGroupGone(small.pid);
  assert.equal((await ask(runner, "ok")).parsed, 1);
});

test("RSS ceiling: memory is measured only every rssSampleEvery requests (sampler seam)", async () => {
  const sampled: number[] = [];
  const { runner } = warm({
    reuse: { rssCeilingMb: 100, rssSampleEvery: 3 },
    rssCeilingSampler: (pid) => {
      sampled.push(pid);
      return 150;
    },
  });
  const answers = [];
  for (let i = 0; i < 3; i++) answers.push(await ask(runner, "ok"));
  assert.equal(sampled.length, 1, "sampled after the 3rd request only");
  assert.equal(new Set(answers.map((a) => a.pid)).size, 1);
  assert.equal(retired(runner, "rss_ceiling"), 1);
});

// ---- memory pool ---------------------------------------------------------------------------------------

test("lease accounting: busy holds child + result memory, idle holds the child only, dead holds nothing", async () => {
  const pool = poolFor(2);
  const { runner } = warm({ pool });
  const slow = ask(runner, "slow:300");
  await sleep(100);
  assert.equal(pool.stats().reservedMb, CHILD_MB + PARENT_MB);
  await slow;
  assert.equal(pool.stats().reservedMb, CHILD_MB, "the idle child keeps its own memory, the result memory went back");
  await ask(runner, "ok");
  assert.equal(pool.stats().reservedMb, CHILD_MB);
  await runner.dispose();
  assert.equal(pool.stats().reservedMb, 0);
  assert.equal(pool.stats().running, 0);
});

test("a request waiting for memory makes the pool reclaim an idle child of another domain", async () => {
  const pool = poolFor(1);
  const { runner } = warm({ pool });
  const a = await ask(runner, "ok", { trustDomain: "a" });
  assert.equal(pool.stats().reservedMb, CHILD_MB);
  const b = await ask(runner, "ok", { trustDomain: "b" });
  assert.notEqual(b.pid, a.pid);
  assert.equal(retired(runner, "evicted"), 1);
  await expectGroupGone(a.pid);
});

test("with no waiting room, a request of another domain still takes the memory of an idle child, which is retired (tikajs-moxa)", async () => {
  const pool = poolFor(1, 0);
  const { runner } = warm({ pool });
  const a = await ask(runner, "ok", { trustDomain: "a" });
  await sleep(100); // a's child is idle: its lease is the whole pool
  const b = await ask(runner, "ok", { trustDomain: "b" });
  assert.notEqual(b.pid, a.pid);
  assert.equal(retired(runner, "evicted"), 1);
  await expectGroupGone(a.pid);
});

test("with no waiting room and every child busy, another request is refused at once (tikajs-moxa)", async () => {
  const pool = poolFor(1, 0);
  const { runner } = warm({ pool });
  const busy = ask(runner, "slow:600", { trustDomain: "a" });
  await sleep(150);
  await assert.rejects(ask(runner, "ok", { trustDomain: "b" }), (error) => error instanceof IsolationError && error.reason === "queue_full");
  await busy;
});

test("a child that finishes while someone else waits for memory is retired, not parked", async () => {
  const pool = poolFor(1);
  const { runner } = warm({ pool });
  const busy = ask(runner, "slow:300");
  await sleep(100);
  const foreign = pool.acquire(CHILD_MB, { parentMb: PARENT_MB });
  assert.equal(pool.stats().queued, 1);
  const answer = await busy;
  const lease = await foreign;
  assert.equal(retired(runner, "evicted"), 1);
  await expectGroupGone(answer.pid);
  lease.release();
});

test("a request that can never fit the pool fails as before (the runner does not hide it)", async () => {
  const pool = new MemoryPool({ poolMb: CHILD_MB, overshootMb: 0, maxQueue: 4 });
  const { runner } = warm({ pool });
  await assert.rejects(ask(runner, "ok"), (e: unknown) => e instanceof IsolationError && /exceeds the whole memory pool/.test(e.message));
});

for (const size of [1, 2, 4]) {
  test(`concurrency, pool of ${size}: ${size * 3} requests share at most ${size} children, every answer correct`, async () => {
    const pool = poolFor(size);
    const { runner } = warm({ pool });
    const answers = await Promise.all(Array.from({ length: size * 3 }, () => ask(runner, "slow:100")));
    assert.ok(answers.every((a) => a.text === "slow-ok"));
    const pids = new Set(answers.map((a) => a.pid));
    assert.ok(pids.size <= size, `${pids.size} children for a pool of ${size}`);
    assert.equal(runner.stats().spawned, pids.size);
    assert.equal(runner.stats().reused, size * 3 - pids.size);
    assert.ok(pool.stats().reservedMb <= pool.stats().poolMb);
    assert.equal(pool.stats().queued, 0);
    await runner.dispose();
    assert.equal(pool.stats().reservedMb, 0);
  });
}

// ---- requests on a reused child carry all their options ---------------------------------------------------

test("records, segments, emailHeaders, onOutputLimit and onEmbeddedLimit reach a reused child as they reach a fresh one", async () => {
  const { runner } = warm();
  const request: Partial<IsolatedParseRequest> = {
    output: "records",
    segments: true,
    emailHeaders: true,
    truncateOutput: true,
    truncateEmbedded: true,
    recordFailures: true,
    maxOutputChars: 5000,
    filename: "mail.eml",
  };
  const fresh = await ask(runner, "options", {}, request);
  const reused = await ask(runner, "options", {}, request);
  assert.equal(reused.pid, fresh.pid);
  assert.equal(reused.parsed, 2);
  assert.equal(reused.text, fresh.text);
  const options = JSON.parse(reused.text) as Record<string, unknown>;
  assert.equal(options["segments"], true);
  assert.equal(options["emailHeaders"], true);
  assert.equal(options["onOutputLimit"], "truncate");
  assert.equal(options["onEmbeddedLimit"], "truncate");
  assert.equal(options["onDocumentFailure"], "record");
  assert.equal(options["filename"], "mail.eml");
  // and a plain request after it is told nothing of the previous one
  const plain = JSON.parse((await ask(runner, "options")).text) as Record<string, unknown>;
  assert.equal(plain["segments"], undefined);
  assert.equal(plain["emailHeaders"], undefined);
  assert.equal(plain["filename"], undefined);
});

test("records output on a reused child: every record arrives", async () => {
  const { runner } = warm();
  await ask(runner, "ok");
  const result = await runner.run({ input: bytes("ok"), output: "records" });
  assert.equal(result.kind, "records");
  assert.deepEqual(
    result.kind === "records" ? result.records.map((r) => r.content) : [],
    ["ok", "inner"],
  );
  assert.equal(answerOf(result).parsed, 2);
});

// ---- lifecycle ---------------------------------------------------------------------------------------------

test("dispose retires idle children, waits for them, and refuses later requests", async () => {
  const pool = poolFor(2);
  const { runner } = warm({ pool });
  const a = await ask(runner, "ok", { trustDomain: "a" });
  const b = await ask(runner, "ok", { trustDomain: "b" });
  await runner.dispose();
  assert.equal(retired(runner, "dispose"), 2);
  await expectGroupGone(a.pid, 500);
  await expectGroupGone(b.pid, 500);
  assert.equal(pool.stats().reservedMb, 0);
  await assert.rejects(ask(runner, "ok"), (e: unknown) => e instanceof IsolationError && e.reason === "unavailable");
});

test("dispose during a request rejects it as unavailable and kills its child", async () => {
  const { runner, seen } = warm();
  const pending = ask(runner, "hang-async");
  await sleep(500);
  await runner.dispose();
  await assert.rejects(pending, (e: unknown) => e instanceof IsolationError && e.reason === "unavailable");
  const pid = seen[0]?.pid;
  assert.ok(pid !== undefined);
  await expectGroupGone(pid);
});

test("diagnostics are reported per request, for reused children too", async () => {
  const { runner, seen } = warm();
  await ask(runner, "ok");
  await ask(runner, "ok");
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.pid, seen[1]!.pid);
  assert.equal(seen[0]!.terminal, "done");
  assert.equal(seen[0]!.outcome, "alive", "a kept child is still alive when its request settles");
  assert.equal(seen[1]!.callDir, seen[0]!.callDir, "one directory per child, not per request");
});
