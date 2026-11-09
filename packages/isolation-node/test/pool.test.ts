import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortError,
  IsolationError,
  LimitExceededError,
  ParseTimeoutError,
} from "@spikedpunch/ripstream-core";
import { MemoryPool, type Lease, type PoolClock, type PoolStats } from "../src/pool.ts";

class FakeClock implements PoolClock {
  #now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  get pendingTimers(): number {
    return this.#timers.size;
  }
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.#timers.get(nextId);
      this.#timers.delete(nextId);
      this.#now = nextAt;
      timer?.callback();
    }
    this.#now = target;
  }
}

type Settled =
  | { status: "pending" }
  | { status: "fulfilled"; lease: Lease }
  | { status: "rejected"; error: unknown };

/** Tracks a promise so tests can ask "has it settled yet?" without awaiting it. */
function track(promise: Promise<Lease>): { state(): Settled; promise: Promise<Lease> } {
  let settled: Settled = { status: "pending" };
  promise.then(
    (lease) => {
      settled = { status: "fulfilled", lease };
    },
    (error: unknown) => {
      settled = { status: "rejected", error };
    },
  );
  return { state: () => settled, promise };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function granted(t: { state(): Settled }): Lease {
  const state = t.state();
  assert.equal(state.status, "fulfilled");
  return (state as Extract<Settled, { status: "fulfilled" }>).lease;
}

function rejection(t: { state(): Settled }): unknown {
  const state = t.state();
  assert.equal(state.status, "rejected");
  return (state as Extract<Settled, { status: "rejected" }>).error;
}

function isolationReason(error: unknown): string {
  assert.ok(error instanceof IsolationError, `expected IsolationError, got ${String(error)}`);
  return error.reason;
}

function makePool(poolMb: number, maxQueue: number, overshootMb = 0) {
  const clock = new FakeClock();
  const pool = new MemoryPool({ poolMb, maxQueue, overshootMb, clock });
  return { pool, clock };
}

function initialStats(poolMb: number): PoolStats {
  return { poolMb, freeMb: poolMb, reservedMb: 0, queued: 0, running: 0 };
}

test("fast path: grants immediately and accounts the reservation", async () => {
  const { pool } = makePool(1000, 2);
  const lease = await pool.acquire(300);
  assert.equal(lease.reservedMb, 300);
  assert.deepEqual(pool.stats(), { poolMb: 1000, freeMb: 700, reservedMb: 300, queued: 0, running: 1 });
  lease.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("reservation is perChildMb plus overshootMb (default overshoot 1024)", async () => {
  const pool = new MemoryPool({ poolMb: 4096, maxQueue: 0 });
  const lease = await pool.acquire(1000);
  assert.equal(lease.reservedMb, 2024);
  assert.equal(pool.stats().freeMb, 2072);
  lease.release();
});

test("an exact fit is granted", async () => {
  const { pool } = makePool(1000, 0);
  const lease = await pool.acquire(1000);
  assert.equal(pool.stats().freeMb, 0);
  lease.release();
});

test("waits when the pool is full and is granted on release", async () => {
  const { pool } = makePool(1000, 2);
  const first = await pool.acquire(800);
  const second = track(pool.acquire(400));
  await tick();
  assert.equal(second.state().status, "pending");
  assert.equal(pool.stats().queued, 1);
  first.release();
  await tick();
  assert.equal(granted(second).reservedMb, 400);
  assert.deepEqual(pool.stats(), { poolMb: 1000, freeMb: 600, reservedMb: 400, queued: 0, running: 1 });
});

test("strict FIFO: waiters are served in arrival order", async () => {
  const { pool } = makePool(1000, 5);
  const holder = await pool.acquire(1000);
  const order: string[] = [];
  const waiters = ["a", "b", "c"].map((name) => {
    const t = track(pool.acquire(1000));
    void t.promise.then((lease) => {
      order.push(name);
      lease.release();
    });
    return t;
  });
  holder.release();
  await tick();
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.ok(waiters.every((w) => w.state().status === "fulfilled"));
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("head-of-line: a small request does not jump a larger waiting request", async () => {
  const { pool } = makePool(1000, 5);
  const holder = await pool.acquire(600); // 400 free
  const big = track(pool.acquire(900));
  const small = track(pool.acquire(100)); // would fit in 400 free, but must wait behind big
  await tick();
  assert.equal(big.state().status, "pending");
  assert.equal(small.state().status, "pending");
  assert.equal(pool.stats().queued, 2);

  holder.release();
  await tick();
  const bigLease = granted(big);
  // big took 900, leaving exactly the 100 that small needs: it is admitted right behind big.
  const smallLease = granted(small);
  assert.equal(pool.stats().freeMb, 0);
  bigLease.release();
  smallLease.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("head-of-line: small request stays blocked while the head cannot fit", async () => {
  const { pool } = makePool(1000, 5);
  const holder = await pool.acquire(500); // 500 free
  const big = track(pool.acquire(800));
  const small = track(pool.acquire(100));
  await tick();
  assert.equal(small.state().status, "pending");
  assert.equal(pool.stats().freeMb, 500);
  holder.release();
  await tick();
  granted(big).release();
  granted(small).release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("wake-up cascade: one release admits several small waiters in order", async () => {
  const { pool } = makePool(1000, 10);
  const holder = await pool.acquire(1000);
  const order: number[] = [];
  const waiters = [100, 200, 300, 700].map((size, i) => {
    const t = track(pool.acquire(size));
    void t.promise.then(() => order.push(i));
    return t;
  });
  holder.release();
  await tick();
  // 100 + 200 + 300 = 600 fit; 700 does not (400 free) and stays queued.
  assert.deepEqual(order, [0, 1, 2]);
  assert.equal(waiters[3]?.state().status, "pending");
  assert.deepEqual(pool.stats(), { poolMb: 1000, freeMb: 400, reservedMb: 600, queued: 1, running: 3 });
  for (const w of waiters.slice(0, 3)) granted(w).release();
  await tick();
  granted(waiters[3]!).release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("queue_full: rejects immediately when the queue holds maxQueue waiters", async () => {
  const { pool } = makePool(1000, 2);
  const holder = await pool.acquire(1000);
  const w1 = track(pool.acquire(100));
  const w2 = track(pool.acquire(100));
  const w3 = track(pool.acquire(100));
  await tick();
  assert.equal(isolationReason(rejection(w3)), "queue_full");
  assert.equal(w1.state().status, "pending");
  assert.equal(w2.state().status, "pending");
  assert.equal(pool.stats().queued, 2);
  holder.release();
  await tick();
  granted(w1).release();
  granted(w2).release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("queue_full: maxQueue 0 means no waiting room", async () => {
  const { pool } = makePool(1000, 0);
  const holder = await pool.acquire(600);
  const rejected = track(pool.acquire(600));
  await tick();
  assert.equal(isolationReason(rejection(rejected)), "queue_full");
  assert.equal(pool.stats().queued, 0);
  // A request that still fits is granted even with no waiting room.
  const fits = await pool.acquire(400);
  fits.release();
  holder.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("a small request is queued (not granted) behind existing waiters even if it fits", async () => {
  const { pool } = makePool(1000, 1);
  const holder = await pool.acquire(600);
  const big = track(pool.acquire(900));
  const small = track(pool.acquire(100)); // queue (max 1) is full -> queue_full, never jumps
  await tick();
  assert.equal(isolationReason(rejection(small)), "queue_full");
  holder.release();
  await tick();
  granted(big).release();
});

test("oversize request: rejected immediately as unavailable, naming the numbers", async () => {
  const { pool } = makePool(1000, 5, 100);
  const t = track(pool.acquire(901));
  await tick();
  const error = rejection(t);
  assert.equal(isolationReason(error), "unavailable");
  const message = (error as Error).message;
  assert.ok(message.includes("1001") && message.includes("1000") && message.includes("100"), message);
  assert.deepEqual(pool.stats(), initialStats(1000));
  // 900 + 100 overshoot == pool is the largest that can ever be satisfied.
  const largest = await pool.acquire(900);
  assert.equal(largest.reservedMb, 1000);
  largest.release();
});

test("oversize request is rejected even when the queue is full or the pool busy", async () => {
  const { pool } = makePool(1000, 0);
  const holder = await pool.acquire(500);
  const t = track(pool.acquire(2000));
  await tick();
  assert.equal(isolationReason(rejection(t)), "unavailable");
  holder.release();
});

test("deadline: expires while queued -> ParseTimeoutError, dequeued", async () => {
  const { pool, clock } = makePool(1000, 5);
  const holder = await pool.acquire(1000);
  const t = track(pool.acquire(500, { deadlineMs: 50 }));
  await tick();
  clock.advance(49);
  await tick();
  assert.equal(t.state().status, "pending");
  clock.advance(1);
  await tick();
  assert.ok(rejection(t) instanceof ParseTimeoutError);
  assert.equal(pool.stats().queued, 0);
  assert.equal(clock.pendingTimers, 0);
  holder.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("deadline: expiry of a blocking head lets the waiter behind it in", async () => {
  const { pool, clock } = makePool(1000, 5);
  const holder = await pool.acquire(600); // 400 free
  const big = track(pool.acquire(900, { deadlineMs: 10 }));
  const small = track(pool.acquire(300));
  await tick();
  assert.equal(small.state().status, "pending");
  clock.advance(10);
  await tick();
  assert.ok(rejection(big) instanceof ParseTimeoutError);
  assert.equal(granted(small).reservedMb, 300);
  granted(small).release();
  holder.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("deadline 0 with no free memory rejects immediately without queueing", async () => {
  const { pool, clock } = makePool(1000, 5);
  const holder = await pool.acquire(1000);
  const t = track(pool.acquire(100, { deadlineMs: 0 }));
  await tick();
  assert.ok(rejection(t) instanceof ParseTimeoutError);
  assert.equal(pool.stats().queued, 0);
  assert.equal(clock.pendingTimers, 0);
  holder.release();
});

test("deadline: real timers also work (small real delay)", async () => {
  const pool = new MemoryPool({ poolMb: 1000, maxQueue: 1, overshootMb: 0 });
  const holder = await pool.acquire(1000);
  await assert.rejects(pool.acquire(10, { deadlineMs: 10 }), ParseTimeoutError);
  assert.equal(pool.stats().queued, 0);
  holder.release();
});

test("lease.remainingMs: shares one budget with queue wait", async () => {
  const { pool, clock } = makePool(1000, 5);
  const holder = await pool.acquire(1000);
  const t = track(pool.acquire(100, { deadlineMs: 100 }));
  await tick();
  clock.advance(30);
  holder.release();
  await tick();
  const lease = granted(t);
  assert.equal(lease.remainingMs(), 70);
  clock.advance(50);
  assert.equal(lease.remainingMs(), 20);
  clock.advance(500);
  assert.equal(lease.remainingMs(), 0);
  lease.release();
  assert.equal(clock.pendingTimers, 0);
});

test("lease.remainingMs: Infinity without a deadline, full budget on the fast path", async () => {
  const { pool } = makePool(1000, 0);
  const noDeadline = await pool.acquire(100);
  assert.equal(noDeadline.remainingMs(), Number.POSITIVE_INFINITY);
  const withDeadline = await pool.acquire(100, { deadlineMs: 250 });
  assert.equal(withDeadline.remainingMs(), 250);
  noDeadline.release();
  withDeadline.release();
});

test("abort while queued: generic reason -> AbortError, dequeued", async () => {
  const { pool } = makePool(1000, 5);
  const holder = await pool.acquire(1000);
  const controller = new AbortController();
  const t = track(pool.acquire(100, { signal: controller.signal }));
  await tick();
  controller.abort(new Error("client went away"));
  await tick();
  assert.ok(rejection(t) instanceof AbortError);
  assert.equal(pool.stats().queued, 0);
  holder.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("abort while queued: default abort reason (AbortError DOMException) -> AbortError", async () => {
  const { pool } = makePool(1000, 5);
  const holder = await pool.acquire(1000);
  const controller = new AbortController();
  const t = track(pool.acquire(100, { signal: controller.signal }));
  controller.abort();
  await tick();
  assert.ok(rejection(t) instanceof AbortError);
  holder.release();
});

test("abort while queued: TimeoutError reason -> ParseTimeoutError", async () => {
  const { pool } = makePool(1000, 5);
  const holder = await pool.acquire(1000);
  const controller = new AbortController();
  const t = track(pool.acquire(100, { signal: controller.signal }));
  controller.abort(new DOMException("timed out", "TimeoutError"));
  await tick();
  assert.ok(rejection(t) instanceof ParseTimeoutError);
  assert.equal(pool.stats().queued, 0);
  holder.release();
});

test("abort while queued: a ParseTimeoutError reason stays a ParseTimeoutError", async () => {
  const { pool } = makePool(1000, 5);
  const holder = await pool.acquire(1000);
  const controller = new AbortController();
  const t = track(pool.acquire(100, { signal: controller.signal }));
  controller.abort(new ParseTimeoutError());
  await tick();
  assert.ok(rejection(t) instanceof ParseTimeoutError);
  holder.release();
});

test("abort of a blocking head lets the waiter behind it in", async () => {
  const { pool } = makePool(1000, 5);
  const holder = await pool.acquire(600);
  const controller = new AbortController();
  const big = track(pool.acquire(900, { signal: controller.signal }));
  const small = track(pool.acquire(300));
  await tick();
  controller.abort();
  await tick();
  assert.ok(rejection(big) instanceof AbortError);
  granted(small).release();
  holder.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("pre-aborted signal rejects without enqueueing or reserving", async () => {
  const { pool } = makePool(1000, 5);
  const generic = AbortSignal.abort(new Error("no"));
  await assert.rejects(pool.acquire(100, { signal: generic }), AbortError);
  const timeout = AbortSignal.abort(new DOMException("t", "TimeoutError"));
  await assert.rejects(pool.acquire(100, { signal: timeout }), ParseTimeoutError);
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("abort after the grant has no effect and leaves no listener behind", async () => {
  const { pool } = makePool(1000, 5);
  const controller = new AbortController();
  const lease = await pool.acquire(100, { signal: controller.signal });
  controller.abort();
  assert.equal(pool.stats().running, 1);
  lease.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("release is idempotent and does not over-credit the pool", async () => {
  const { pool } = makePool(1000, 5);
  const a = await pool.acquire(400);
  const b = await pool.acquire(400);
  a.release();
  a.release();
  a.release();
  assert.deepEqual(pool.stats(), { poolMb: 1000, freeMb: 600, reservedMb: 400, queued: 0, running: 1 });
  b.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("dispose: rejects all waiters, refuses new acquires, live leases can still release", async () => {
  const { pool, clock } = makePool(1000, 5);
  const holder = await pool.acquire(1000);
  const controller = new AbortController();
  const w1 = track(pool.acquire(100, { deadlineMs: 1000 }));
  const w2 = track(pool.acquire(100, { signal: controller.signal }));
  await tick();
  pool.dispose();
  await tick();
  assert.equal(isolationReason(rejection(w1)), "unavailable");
  assert.equal(isolationReason(rejection(w2)), "unavailable");
  assert.equal(clock.pendingTimers, 0);
  const after = track(pool.acquire(1));
  await tick();
  assert.equal(isolationReason(rejection(after)), "unavailable");
  controller.abort(); // listener was removed; must be harmless
  holder.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
  pool.dispose(); // idempotent
});

test("charge: accounts extra memory on the lease and release returns all of it", async () => {
  const { pool } = makePool(1000, 5);
  const lease = await pool.acquire(300);
  pool.charge(lease, 200);
  assert.equal(lease.reservedMb, 500);
  assert.deepEqual(pool.stats(), { poolMb: 1000, freeMb: 500, reservedMb: 500, queued: 0, running: 1 });
  pool.charge(lease, 0);
  assert.equal(lease.reservedMb, 500);
  lease.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("charge: beyond the free pool is rejected with LimitExceededError and changes nothing", async () => {
  const { pool } = makePool(1000, 5);
  const lease = await pool.acquire(300);
  assert.throws(() => pool.charge(lease, 701), LimitExceededError);
  assert.equal(lease.reservedMb, 300);
  assert.equal(pool.stats().freeMb, 700);
  pool.charge(lease, 700); // exactly the free memory is allowed
  assert.equal(pool.stats().freeMb, 0);
  lease.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("charge: released lease, foreign lease and bad amounts are programming errors", async () => {
  const { pool } = makePool(1000, 5);
  const other = makePool(1000, 5).pool;
  const lease = await pool.acquire(100);
  assert.throws(() => pool.charge(lease, -1), RangeError);
  assert.throws(() => pool.charge(lease, 1.5), RangeError);
  assert.throws(() => pool.charge(lease, Number.NaN), RangeError);
  assert.throws(() => other.charge(lease, 1), TypeError);
  lease.release();
  assert.throws(() => pool.charge(lease, 1), /already released/);
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("charge then release wakes a waiter that needed that memory", async () => {
  const { pool } = makePool(1000, 5);
  const lease = await pool.acquire(300);
  pool.charge(lease, 400); // 300 free
  const waiter = track(pool.acquire(500));
  await tick();
  assert.equal(waiter.state().status, "pending");
  lease.release();
  await tick();
  granted(waiter).release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("argument validation: constructor", () => {
  for (const poolMb of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new MemoryPool({ poolMb, maxQueue: 0 }), RangeError, `poolMb ${poolMb}`);
  }
  for (const maxQueue of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new MemoryPool({ poolMb: 10, maxQueue }), RangeError, `maxQueue ${maxQueue}`);
  }
  for (const overshootMb of [-1, 0.5, Number.NaN]) {
    assert.throws(() => new MemoryPool({ poolMb: 10, maxQueue: 0, overshootMb }), RangeError);
  }
  // Integers beyond 2^53 are "integers" to Number.isInteger but not exact: refuse them.
  assert.throws(() => new MemoryPool({ poolMb: 2 ** 53, maxQueue: 0 }), RangeError);
  assert.throws(() => new MemoryPool({ poolMb: 10, maxQueue: 2 ** 53 }), RangeError);
});

// ---- parentMb: memory the parent itself needs for this child's result -----------------------

test("parentMb is reserved on top of the cap and the overshoot, and returned on release", async () => {
  const { pool } = makePool(1000, 0, 100);
  const lease = await pool.acquire(300, { parentMb: 50 });
  assert.equal(lease.reservedMb, 450);
  assert.deepEqual(pool.stats(), { poolMb: 1000, freeMb: 550, reservedMb: 450, queued: 0, running: 1 });
  lease.release();
  assert.deepEqual(pool.stats(), initialStats(1000));
});

test("parentMb defaults to 0 (existing callers are unchanged)", async () => {
  const { pool } = makePool(1000, 0, 100);
  assert.equal((await pool.acquire(300)).reservedMb, 400);
});

test("parentMb counts toward admission: a reservation that only fits without it queues or is refused", async () => {
  const { pool } = makePool(1000, 1, 0);
  const first = await pool.acquire(600);
  const waiting = track(pool.acquire(300, { parentMb: 150 })); // 450 > 400 free: waits
  await tick();
  assert.equal(waiting.state().status, "pending");
  first.release();
  await tick();
  assert.equal(granted(waiting).reservedMb, 450);
});

test("a reservation that exceeds the whole pool because of parentMb can never be satisfied", async () => {
  const { pool } = makePool(1000, 5, 100);
  const error = await pool.acquire(800, { parentMb: 101 }).then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof IsolationError && error.reason === "unavailable");
  assert.match((error as Error).message, /101 MiB.*parent/);
});

// ---- timers: a deadline past 2^31-1 ms must not overflow setTimeout (F3) -------------------

class SpyClock extends FakeClock {
  readonly delays: number[] = [];
  override setTimeout(callback: () => void, ms: number): unknown {
    this.delays.push(ms);
    return super.setTimeout(callback, ms);
  }
}

test("a deadline beyond 2^31-1 ms is clamped when the queue timer is armed", async () => {
  const clock = new SpyClock();
  const pool = new MemoryPool({ poolMb: 100, maxQueue: 1, overshootMb: 0, clock });
  const holder = await pool.acquire(100);
  const waiting = track(pool.acquire(10, { deadlineMs: 3_000_000_000 }));
  await tick();
  assert.deepEqual(clock.delays, [2 ** 31 - 1]);
  assert.equal(waiting.state().status, "pending");
  holder.release();
  await tick();
  assert.equal(granted(waiting).reservedMb, 10);
});

test("a real 3e9 ms deadline does not fire early (Node would run an overflowing timer after ~1 ms)", async () => {
  const pool = new MemoryPool({ poolMb: 100, maxQueue: 1, overshootMb: 0 });
  const holder = await pool.acquire(100);
  const waiting = track(pool.acquire(10, { deadlineMs: 3_000_000_000 }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(waiting.state().status, "pending");
  holder.release();
  await tick();
  granted(waiting).release();
});

test("argument validation: acquire rejects bad sizes and deadlines without side effects", async () => {
  const { pool } = makePool(1000, 5);
  for (const size of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    await assert.rejects(pool.acquire(size), RangeError, `size ${size}`);
  }
  for (const parentMb of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    await assert.rejects(pool.acquire(10, { parentMb }), RangeError, `parentMb ${parentMb}`);
  }
  for (const deadlineMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(pool.acquire(10, { deadlineMs }), RangeError, `deadline ${deadlineMs}`);
  }
  assert.deepEqual(pool.stats(), initialStats(1000));
});

// mulberry32: tiny seeded PRNG so the randomised run is reproducible.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const seed of [1, 2, 3, 42, 1234, 99999]) {
  test(`randomised operations never leak (seed ${seed})`, async () => {
    const random = prng(seed);
    const int = (n: number): number => Math.floor(random() * n);
    const POOL = 1000;
    const clock = new FakeClock();
    const pool = new MemoryPool({ poolMb: POOL, maxQueue: 1 + int(6), overshootMb: 50, clock });

    const live: Lease[] = [];
    const controllers: AbortController[] = [];
    const pending: Array<ReturnType<typeof track>> = [];

    const checkInvariants = (): void => {
      const stats = pool.stats();
      assert.ok(stats.freeMb >= 0 && stats.freeMb <= POOL, "free in range");
      assert.equal(stats.freeMb + stats.reservedMb, POOL);
      assert.equal(
        stats.reservedMb,
        live.reduce((sum, lease) => sum + lease.reservedMb, 0),
        "reserved equals the sum of live leases",
      );
      assert.equal(stats.running, live.length);
    };

    for (let step = 0; step < 400; step++) {
      const op = int(10);
      if (op <= 3) {
        const options: { signal?: AbortSignal; deadlineMs?: number } = {};
        if (random() < 0.4) {
          const controller = new AbortController();
          controllers.push(controller);
          options.signal = controller.signal;
        }
        if (random() < 0.4) options.deadlineMs = int(80);
        const t = track(pool.acquire(1 + int(900), options));
        pending.push(t);
        void t.promise.then(
          (lease) => live.push(lease),
          () => undefined,
        );
      } else if (op <= 5) {
        const lease = live.splice(int(live.length || 1), 1)[0];
        lease?.release();
        if (lease !== undefined && random() < 0.3) lease.release();
      } else if (op === 6) {
        const controller = controllers[int(controllers.length || 1)];
        if (controller !== undefined && random() < 0.5) {
          controller.abort(random() < 0.5 ? new Error("x") : new DOMException("t", "TimeoutError"));
        }
      } else if (op === 7) {
        clock.advance(int(40));
      } else if (op === 8) {
        const lease = live[int(live.length || 1)];
        if (lease !== undefined) {
          try {
            pool.charge(lease, int(100));
          } catch (error) {
            assert.ok(error instanceof LimitExceededError);
          }
        }
      }
      await tick();
      checkInvariants();
      assert.ok(pool.stats().queued <= 7);
    }

    // Drain: every request fits the whole pool, so releasing everything must
    // eventually admit or reject every waiter.
    for (let guard = 0; guard < 1000 && (live.length > 0 || pool.stats().queued > 0); guard++) {
      const lease = live.pop();
      if (lease !== undefined) lease.release();
      else clock.advance(100);
      await tick();
    }
    await Promise.allSettled(pending.map((t) => t.promise));
    assert.deepEqual(pool.stats(), initialStats(POOL));
    assert.equal(clock.pendingTimers, 0, "no timers left behind");
    assert.ok(pending.every((t) => t.state().status !== "pending"));
  });
}
