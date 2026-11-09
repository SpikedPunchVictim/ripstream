import {
  AbortError,
  IsolationError,
  LimitExceededError,
  ParseTimeoutError,
} from "@spikedpunch/ripstream-core";
import { clampTimerMs } from "./timers.ts";

/**
 * Memory-pool gate: admits a child only when its reservation fits the pool.
 * This is the PRIMARY defence against cgroup OOM (with memory.oom.group=1 the
 * kernel kills the parent together with the child, so oom_score_adj cannot
 * protect it); never admit children whose caps could exceed memory.max.
 *
 * All sizes are integer MiB. A reservation is `perChildMb + overshootMb`
 * (+ `parentMb`, when given): the child's cap plus the measured worst-case
 * overshoot of the polling memory limit (L3), about 1 GiB, plus the memory the
 * PARENT needs to hold the child's result (see runner.ts).
 *
 * Queueing is STRICT FIFO. A new request is granted immediately only when
 * nobody is waiting and it fits. Otherwise it queues behind the existing
 * waiters, even when it is small enough to fit right now, and the head of the
 * queue is never skipped. This is head-of-line blocking by design: it keeps a
 * large request from starving forever behind a stream of small ones.
 *
 * Deadlines are RELATIVE milliseconds measured from the `acquire` call and
 * include queue wait. The lease reports the rest through `remainingMs()` so
 * the caller's run timer shares one budget.
 */

export interface Lease {
  /** MiB held by this lease: the reservation plus anything `charge`d. */
  readonly reservedMb: number;
  /** Milliseconds left of the acquire deadline (floored at 0); Infinity when none. */
  remainingMs(): number;
  /** Returns the memory to the pool and wakes waiters. Idempotent. */
  release(): void;
}

export interface AcquireOptions {
  readonly signal?: AbortSignal;
  /** Relative budget in ms, counted from the acquire call, queue wait included. */
  readonly deadlineMs?: number;
  /**
   * MiB the parent process itself needs for this child's result, reserved on
   * top of the cap and the overshoot. It must be known at admission: charged
   * later it would be too late, the bytes are already materialised. Default 0.
   */
  readonly parentMb?: number;
}

export interface PoolStats {
  readonly poolMb: number;
  readonly freeMb: number;
  readonly reservedMb: number;
  readonly queued: number;
  readonly running: number;
}

/** Time source and timers, injectable so tests need no real sleeping. */
export interface PoolClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: PoolClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface MemoryPoolOptions {
  readonly poolMb: number;
  /** Extra MiB reserved per child on top of its cap. Default 1024. */
  readonly overshootMb?: number;
  /** Waiters allowed before `queue_full`; 0 means no waiting room. */
  readonly maxQueue: number;
  readonly clock?: PoolClock;
}

export const DEFAULT_OVERSHOOT_MB = 1024;

function requireInt(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a safe integer >= ${min}, got ${String(value)}`);
  }
}

/**
 * Maps an abort reason per the core facade rule: a TimeoutError becomes
 * ParseTimeoutError, anything else AbortError. A ParseTimeoutError reason
 * (the facade aborts its own signals with one) stays a ParseTimeoutError.
 */
function errorForAbort(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof ParseTimeoutError) return reason;
  if (reason instanceof Error && reason.name === "TimeoutError") {
    return new ParseTimeoutError("Parse timed out while waiting for memory", { cause: reason });
  }
  return new AbortError();
}

class LeaseImpl implements Lease {
  readonly pool: MemoryPool;
  readonly deadlineAt: number | null;
  totalMb: number;
  released = false;

  constructor(pool: MemoryPool, totalMb: number, deadlineAt: number | null) {
    this.pool = pool;
    this.totalMb = totalMb;
    this.deadlineAt = deadlineAt;
  }

  get reservedMb(): number {
    return this.totalMb;
  }

  remainingMs(): number {
    if (this.deadlineAt === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.deadlineAt - this.pool.clock.now());
  }

  release(): void {
    this.pool.releaseLease(this);
  }
}

interface Waiter {
  readonly sizeMb: number;
  readonly deadlineAt: number | null;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (lease: Lease) => void;
  readonly reject: (error: Error) => void;
  timer: unknown;
  onAbort: (() => void) | null;
}

export class MemoryPool {
  readonly clock: PoolClock;
  readonly #poolMb: number;
  readonly #overshootMb: number;
  readonly #maxQueue: number;
  readonly #queue: Waiter[] = [];
  #reservedMb = 0;
  #running = 0;
  #disposed = false;

  constructor(options: MemoryPoolOptions) {
    requireInt("poolMb", options.poolMb, 1);
    requireInt("overshootMb", options.overshootMb ?? DEFAULT_OVERSHOOT_MB, 0);
    requireInt("maxQueue", options.maxQueue, 0);
    this.#poolMb = options.poolMb;
    this.#overshootMb = options.overshootMb ?? DEFAULT_OVERSHOOT_MB;
    this.#maxQueue = options.maxQueue;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Reserves `perChildMb + overshootMb + parentMb`. Resolves with a lease, or rejects
   * with: RangeError (bad arguments), IsolationError `unavailable` (disposed,
   * or the reservation exceeds the whole pool), IsolationError `queue_full`,
   * ParseTimeoutError (deadline or TimeoutError abort), AbortError.
   */
  acquire(perChildMb: number, options: AcquireOptions = {}): Promise<Lease> {
    try {
      requireInt("perChildMb", perChildMb, 1);
      requireInt("parentMb", options.parentMb ?? 0, 0);
      const { deadlineMs } = options;
      if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs < 0)) {
        throw new RangeError(`deadlineMs must be a finite number >= 0, got ${String(deadlineMs)}`);
      }
    } catch (error) {
      return Promise.reject(error);
    }

    const parentMb = options.parentMb ?? 0;
    const sizeMb = perChildMb + this.#overshootMb + parentMb;
    const { signal, deadlineMs } = options;

    if (this.#disposed) {
      return Promise.reject(new IsolationError("unavailable", "Memory pool is disposed"));
    }
    if (signal?.aborted === true) return Promise.reject(errorForAbort(signal));
    if (sizeMb > this.#poolMb) {
      return Promise.reject(
        new IsolationError(
          "unavailable",
          `Reservation of ${sizeMb} MiB (${perChildMb} MiB per child + ${this.#overshootMb} MiB overshoot + ` +
            `${parentMb} MiB parent result memory) exceeds the whole memory pool of ${this.#poolMb} MiB ` +
            `and can never be satisfied`,
        ),
      );
    }

    const startedAt = this.clock.now();
    const deadlineAt = deadlineMs === undefined ? null : startedAt + deadlineMs;

    if (this.#queue.length === 0 && sizeMb <= this.#poolMb - this.#reservedMb) {
      return Promise.resolve(this.#grant(sizeMb, deadlineAt));
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(
        new IsolationError(
          "queue_full",
          `Memory pool is full (${this.#poolMb - this.#reservedMb} MiB free of ${this.#poolMb} MiB, ` +
            `need ${sizeMb} MiB) and the queue already holds ${this.#queue.length} of ${this.#maxQueue} waiters`,
        ),
      );
    }
    if (deadlineMs === 0) {
      return Promise.reject(new ParseTimeoutError("Parse timed out while waiting for memory"));
    }

    return new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = {
        sizeMb,
        deadlineAt,
        signal,
        resolve,
        reject,
        timer: undefined,
        onAbort: null,
      };
      if (deadlineMs !== undefined) {
        waiter.timer = this.clock.setTimeout(() => {
          this.#dequeue(waiter, new ParseTimeoutError("Parse timed out while waiting for memory"));
        }, clampTimerMs(deadlineMs));
      }
      if (signal !== undefined) {
        waiter.onAbort = () => this.#dequeue(waiter, errorForAbort(signal));
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  /**
   * Accounts `extraMb` more memory against a live lease. The runner does not
   * use it for the parent's result memory (it reserves that up front through
   * `AcquireOptions.parentMb`, see runner.ts); it is for callers that learn a
   * run's real needs only after admission.
   *
   * Rule: the charge must fit the pool's free memory right now; otherwise it
   * is rejected with LimitExceededError and nothing changes. A temporary
   * deficit is not allowed: the pool is the primary OOM defence, and a
   * deficit would admit more memory than the cgroup has. LimitExceededError is
   * the existing document-caused "too big" error (recoverable); the caller
   * should apply it before materialising the result. Waiters are not
   * considered: the charged memory is already in use by a running parse.
   */
  charge(lease: Lease, extraMb: number): void {
    requireInt("extraMb", extraMb, 0);
    if (!(lease instanceof LeaseImpl) || lease.pool !== this) {
      throw new TypeError("charge: lease does not belong to this pool");
    }
    if (lease.released) throw new Error("charge: lease is already released");
    const freeMb = this.#poolMb - this.#reservedMb;
    if (extraMb > freeMb) {
      throw new LimitExceededError(
        `Result needs ${extraMb} MiB of parent memory but only ${freeMb} MiB of the ${this.#poolMb} MiB pool is free`,
      );
    }
    lease.totalMb += extraMb;
    this.#reservedMb += extraMb;
  }

  stats(): PoolStats {
    return {
      poolMb: this.#poolMb,
      freeMb: this.#poolMb - this.#reservedMb,
      reservedMb: this.#reservedMb,
      queued: this.#queue.length,
      running: this.#running,
    };
  }

  /** Rejects all waiters with IsolationError and refuses new acquires. Live leases may still release. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const waiter of this.#queue.splice(0)) {
      this.#settleWaiterResources(waiter);
      waiter.reject(new IsolationError("unavailable", "Memory pool was disposed while waiting"));
    }
  }

  /** @internal Called by LeaseImpl. */
  releaseLease(lease: LeaseImpl): void {
    if (lease.released) return;
    lease.released = true;
    this.#reservedMb -= lease.totalMb;
    this.#running -= 1;
    this.#drain();
  }

  #grant(sizeMb: number, deadlineAt: number | null): Lease {
    this.#reservedMb += sizeMb;
    this.#running += 1;
    return new LeaseImpl(this, sizeMb, deadlineAt);
  }

  /** Admits waiters from the head while they fit; stops at the first that does not (strict FIFO). */
  #drain(): void {
    for (;;) {
      const head = this.#queue[0];
      if (head === undefined || head.sizeMb > this.#poolMb - this.#reservedMb) return;
      this.#queue.shift();
      this.#settleWaiterResources(head);
      head.resolve(this.#grant(head.sizeMb, head.deadlineAt));
    }
  }

  #dequeue(waiter: Waiter, error: Error): void {
    const index = this.#queue.indexOf(waiter);
    if (index === -1) return;
    this.#queue.splice(index, 1);
    this.#settleWaiterResources(waiter);
    waiter.reject(error);
    // Removing a blocking head may let the waiters behind it in.
    this.#drain();
  }

  #settleWaiterResources(waiter: Waiter): void {
    if (waiter.timer !== undefined) this.clock.clearTimeout(waiter.timer);
    if (waiter.onAbort !== null) waiter.signal?.removeEventListener("abort", waiter.onAbort);
  }
}
