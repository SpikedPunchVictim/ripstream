import { stat } from "node:fs/promises";
import { AbortError, IsolationError, LimitExceededError, type IsolatedParseRequest, type IsolatedParseResult } from "@spikedpunch/ripstream-core";
import type { MemoryPool } from "./pool.ts";
import { startChild, type RunChildOptions, type RunDiagnostics } from "./supervisor.ts";
import { clampTimerMs } from "./timers.ts";

/**
 * Facade over pool + supervisor for one kind of child. It owns no policy
 * beyond ordering: input cap, pool lease (queue wait counts against the task
 * budget), supervised run, lease released once the child is DEAD. Routing and
 * what the child script does are P3's job; the pool is injected so a server
 * can share one gate across runners.
 *
 * The caller is answered when the run has a verdict; the pool lease is
 * released later, when the supervisor reports the child dead (`ChildRun.dead`).
 * Usually that is the same instant. For a child that survives its SIGKILL
 * (uninterruptible sleep, a stuck mount) the caller is answered promptly but
 * the child's memory stays reserved until the kernel really reaps it, so the
 * pool never admits work on top of memory that is still in use.
 */

const MIB = 1024 * 1024;

/**
 * The PARENT's memory for holding one result: `ceil(maxResultBytes * factor / MiB) + PARENT_RESULT_SLACK_MB`.
 * The reader folds text into one string and parses each record as it arrives, so the parent holds the final
 * result plus transient parse garbage, never the raw frames. Measured on the real supervisor (peak RSS above the
 * idle baseline, one run in flight, worst shapes of each kind; the peak is a GC-timing high-water mark and moves
 * by about +-10% between runs). Peak delta in MiB (factor = delta / wire bytes):
 *
 *   output "text"    4.1x - 6.5x at 1 - 40 MB of wire, worst shape = a flood of one-character chunks
 *                    (1 KiB, 1 MiB and CJK chunks are 1.0x - 3.6x); 34 MiB at 8 MB of wire.
 *   output "records" the worst shapes are records whose metadata is many short keys (V8 spends ~100 bytes per
 *                    JSON.parse'd property on a ~7 byte wire entry) or many unique keys:
 *
 *                      wire    macOS arm64 (node 24)      Linux arm64 (node 24, docker)
 *                      40 MB   9.3x - 13.5x (~360 - 515)  10.0x - 16.9x (381 - 645)
 *                      16 MB   15x - 23x (233 - 347)      (not measured)
 *                       8 MB   19x - 31x (146 - 237)      14.8x - 30.5x (113 - 230)
 *                       4 MB   20x - 32x (76 - 121)       (not measured)
 *                       2 MB   24x - 32x (44 - 60)        22x - 33x (42 - 60)
 *                       1 MB   25x - 36x (23 - 34)        25x - 45x (23 - 43)
 *
 * The factor is NOT constant: the parent's heap grows in steps and parse garbage is collected late, a cost of
 * about 20 - 60 MiB that does not scale with the result and dominates when the result is small (the factors of
 * 25 - 45x at 1 MB of wire are that fixed cost, not a per-byte cost). So the reservation is a per-byte factor
 * for the large end (24x for records, 6x for text: the worst 40 MB figure plus 40%) plus a fixed 96 MiB. At the
 * measured worst point (about 8 MB of wire, many unique keys) the reservation (24x + 96 MiB = 288 MiB) is about
 * 20% above the observed peak of 237 MiB (a first version with 64 MiB had only 4 - 10% there); at 1, 2, 4, 16 and
 * 40 MB it is 20% or more above. Do not trim these
 * numbers without re-measuring.
 *
 * It is reserved up front at admission, through the pool's `parentMb`, instead of `pool.charge()` mid-run:
 * charging can fail halfway through a parse, and the pool must never admit more than the cgroup holds.
 *
 * Caveat: the reservation is released when the CHILD dies, not when the caller drops the result. From the moment
 * the caller starts holding the result until it lets go, that memory is not covered by the reservation. That gap
 * is what the parent headroom (default 512 MB, see cgroup.ts) is for. If the shape of results changes,
 * re-measure; do not tune by feel.
 */
const TEXT_RESULT_FACTOR = 6;
const RECORDS_RESULT_FACTOR = 24;

/**
 * Fixed part of the reservation, in MiB: heap-growth overhead that does not scale with the result (see the
 * measurements above).
 */
export const PARENT_RESULT_SLACK_MB = 96;

/** MiB of parent memory to reserve for a result of at most `maxResultBytes`. */
export function parentResultMb(maxResultBytes: number, output: "text" | "records" | undefined): number {
  const factor = output === "records" ? RECORDS_RESULT_FACTOR : TEXT_RESULT_FACTOR;
  return Math.ceil((maxResultBytes * factor) / MIB) + PARENT_RESULT_SLACK_MB;
}

/** Default for `ChildRunnerOptions.disposeWaitMs`. */
export const DEFAULT_DISPOSE_WAIT_MS = 5000;

export interface ChildRunnerOptions {
  readonly pool: MemoryPool;
  /** Child entry script (absolute path). */
  readonly childScript: string;
  readonly childArgs?: readonly string[];
  /**
   * Per-child memory reservation passed to the pool, in MiB. The parent's own
   * memory for the result (`maxResultBytes` times a measured factor, plus a
   * fixed 96 MiB) is reserved ON TOP of this, per request. Must be at least
   * `rssLimitMb`.
   */
  readonly perChildMb: number;
  /** V8 old-space of the child, MiB. Must be below `rssLimitMb`. */
  readonly heapMb: number;
  /** Soft RLIMIT_CPU, seconds. */
  readonly cpuSecs: number;
  /** Wall-clock budget per request in ms, queue wait included. */
  readonly maxTaskMillis: number;
  readonly maxInputBytes: number;
  readonly maxResultBytes: number;
  /** RSS kill limit, MiB. Must be above `heapMb` (the heap alone would trip it) and at most `perChildMb`. */
  readonly rssLimitMb: number;
  readonly nodePath?: string;
  readonly execArgv?: readonly string[];
  readonly vmemKb?: number;
  readonly pollMs?: number;
  readonly readyTimeoutMs?: number;
  readonly graceMs?: number;
  readonly maxFrameBytes?: number;
  /** Most frames accepted from one child. Default: see DEFAULT_MAX_FRAMES in frames.ts. */
  readonly maxFrames?: number;
  /** Bytes of child stderr read before its pipe is closed. Default 1 MiB. */
  readonly stderrBudgetBytes?: number;
  /**
   * How long `dispose()` waits for killed children to be reaped before it
   * returns anyway. Default 5000. A child that outlives this keeps its pool
   * lease until it dies.
   */
  readonly disposeWaitMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Called with each run's observations. Never throws into the run. */
  readonly onRunSettled?: (diagnostics: RunDiagnostics) => void;
  /** @internal Test seams, passed to the supervisor unchanged. */
  readonly spawnFn?: RunChildOptions["spawnFn"];
  readonly reapWaitMs?: number;
}

/**
 * Per-run replacements for the runner's defaults, for callers whose limits depend on the request (the facade
 * derives them from the request's output cap). Every field is optional; an omitted field keeps the runner's value.
 * The heap is checked against the same `heapMb < rssLimitMb <= perChildMb` rule as the constructor's.
 */
export interface RunLimits {
  readonly heapMb?: number;
  readonly maxResultBytes?: number;
  readonly maxFrameBytes?: number;
  /** The child's own parse timer in ms (InputHeader.maxParseMillis). Omitted: none is sent. */
  readonly maxParseMillis?: number;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer, got ${String(value)}`);
  }
}

// The RSS limit must leave room for the heap (else every child trips it) and fit inside the pool reservation
// (else a child can be admitted for less memory than it is allowed to use).
function requireMemoryOrder(heapMb: number, rssLimitMb: number, perChildMb: number): void {
  if (!(heapMb < rssLimitMb && rssLimitMb <= perChildMb)) {
    throw new RangeError(
      `heapMb < rssLimitMb <= perChildMb is required, got heapMb=${heapMb}, ` +
        `rssLimitMb=${rssLimitMb}, perChildMb=${perChildMb}`,
    );
  }
}

export class ChildRunner {
  readonly #options: ChildRunnerOptions;
  readonly #controllers = new Set<AbortController>();
  readonly #inflight = new Set<Promise<unknown>>();
  /** One entry per child that has been started and not yet reported dead. */
  readonly #deaths = new Set<Promise<void>>();
  readonly #disposeWaitMs: number;
  #unreaped = 0;
  #disposed = false;

  constructor(options: ChildRunnerOptions) {
    for (const name of ["perChildMb", "heapMb", "cpuSecs", "maxTaskMillis", "maxInputBytes", "maxResultBytes", "rssLimitMb"] as const) {
      requirePositiveInteger(name, options[name]);
    }
    if (options.childScript.length === 0) throw new TypeError("childScript must be a non-empty path");
    requireMemoryOrder(options.heapMb, options.rssLimitMb, options.perChildMb);
    this.#disposeWaitMs = options.disposeWaitMs ?? DEFAULT_DISPOSE_WAIT_MS;
    if (!Number.isFinite(this.#disposeWaitMs) || this.#disposeWaitMs < 0) {
      throw new RangeError(`disposeWaitMs must be a non-negative number, got ${String(this.#disposeWaitMs)}`);
    }
    this.#options = options;
  }

  /**
   * Runs one request in an isolated child.
   *
   * Every rejection is about THIS call. In particular a per-call
   * `IsolationError` with reason `unavailable` (the child could not be
   * spawned, never became ready, the pool is too small for one request, the
   * runner was disposed) is NEVER a signal to fall back to parsing in the
   * caller's process: the whole point of isolation is that untrusted input
   * does not get parsed there. Retry, queue or fail the request instead. Only
   * the one-time capability probe (`probeIsolation`) decides, at startup,
   * whether isolation is offered at all.
   */
  async run(
    request: IsolatedParseRequest,
    options: { readonly signal?: AbortSignal; readonly limits?: RunLimits } = {},
  ): Promise<IsolatedParseResult> {
    if (this.#disposed) throw disposedError();
    const controller = new AbortController();
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
    this.#controllers.add(controller);
    const work = this.#run(request, signal, options.limits ?? {});
    this.#inflight.add(work);
    try {
      return await work;
    } catch (error) {
      // Our own dispose() aborts with an AbortError; callers should see why.
      throw this.#disposed && error instanceof AbortError ? disposedError() : error;
    } finally {
      this.#inflight.delete(work);
      this.#controllers.delete(controller);
    }
  }

  /**
   * Rejects this runner's queued and running requests (children are SIGKILLed)
   * and waits until the children are dead, for at most `disposeWaitMs`. A
   * child that is still alive after that (it survived SIGKILL) keeps its pool
   * lease; it is released when the kernel finally reaps it.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const controller of this.#controllers) controller.abort(disposedError());
    await Promise.allSettled([...this.#inflight]);
    if (this.#deaths.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<void>((resolve) => {
      // Deliberately NOT unref'd: with an unreaped child and nothing else pending, an unref'd timer would let the
      // process exit while the caller is still awaiting dispose(). The wait is bounded by disposeWaitMs anyway.
      timer = setTimeout(resolve, clampTimerMs(this.#disposeWaitMs));
    });
    try {
      await Promise.race([Promise.allSettled([...this.#deaths]), gaveUp]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #run(request: IsolatedParseRequest, signal: AbortSignal, limits: RunLimits): Promise<IsolatedParseResult> {
    const o = this.#options;
    const heapMb = limits.heapMb ?? o.heapMb;
    const maxResultBytes = limits.maxResultBytes ?? o.maxResultBytes;
    const maxFrameBytes = limits.maxFrameBytes ?? o.maxFrameBytes;
    for (const [name, value] of [["heapMb", limits.heapMb], ["maxResultBytes", limits.maxResultBytes], ["maxFrameBytes", limits.maxFrameBytes], ["maxParseMillis", limits.maxParseMillis]] as const) {
      if (value !== undefined) requirePositiveInteger(name, value);
    }
    requireMemoryOrder(heapMb, o.rssLimitMb, o.perChildMb);
    await this.#checkInputSize(request);
    const lease = await o.pool.acquire(o.perChildMb, {
      signal,
      deadlineMs: o.maxTaskMillis,
      parentMb: parentResultMb(maxResultBytes, request.output),
    });
    let run;
    try {
      run = startChild({
        scriptPath: o.childScript,
        ...(o.childArgs === undefined ? {} : { scriptArgs: o.childArgs }),
        ...(o.nodePath === undefined ? {} : { nodePath: o.nodePath }),
        ...(o.execArgv === undefined ? {} : { execArgv: o.execArgv }),
        ...(o.vmemKb === undefined ? {} : { vmemKb: o.vmemKb }),
        ...(o.pollMs === undefined ? {} : { pollMs: o.pollMs }),
        ...(o.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: o.readyTimeoutMs }),
        ...(o.graceMs === undefined ? {} : { graceMs: o.graceMs }),
        ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
        ...(limits.maxParseMillis === undefined ? {} : { maxParseMillis: limits.maxParseMillis }),
        ...(o.maxFrames === undefined ? {} : { maxFrames: o.maxFrames }),
        ...(o.stderrBudgetBytes === undefined ? {} : { stderrBudgetBytes: o.stderrBudgetBytes }),
        ...(o.platform === undefined ? {} : { platform: o.platform }),
        ...(o.parentEnv === undefined ? {} : { parentEnv: o.parentEnv }),
        ...(o.onRunSettled === undefined ? {} : { onSettled: o.onRunSettled }),
        ...(o.spawnFn === undefined ? {} : { spawnFn: o.spawnFn }),
        ...(o.reapWaitMs === undefined ? {} : { reapWaitMs: o.reapWaitMs }),
        cpuSecs: o.cpuSecs,
        heapMb,
        rssLimitMb: o.rssLimitMb,
        maxResultBytes,
        request,
        deadlineMs: lease.remainingMs(),
        signal,
      });
    } catch (error) {
      lease.release(); // startChild reports failures through `result`, so this is defensive only
      throw error;
    }
    // The lease belongs to the child, not to the caller's promise: it is returned when the child is dead.
    const child = { answered: false, dead: false };
    void run.result.then(
      () => this.#answered(child),
      () => this.#answered(child),
    );
    const death: Promise<void> = run.dead.then(() => {
      child.dead = true;
      if (child.answered) this.#unreaped--;
      lease.release();
    });
    this.#deaths.add(death);
    void death.finally(() => this.#deaths.delete(death));
    return await run.result;
  }

  #answered(child: { answered: boolean; dead: boolean }): void {
    child.answered = true;
    if (!child.dead) this.#unreaped++;
  }

  /**
   * Children whose caller has been answered but that the kernel has not reaped yet (they survived their SIGKILL).
   * Each still holds its pool lease, so while this is above 0 queued requests wait on memory that is in use; a
   * metric for the server (it should be 0).
   */
  get unreapedChildren(): number {
    return this.#unreaped;
  }

  /**
   * Inline bytes are measured directly; a `{ path }` is stat'ed (the child
   * reads the file itself). An unreadable path is a caller bug: the fs error
   * propagates unchanged.
   */
  async #checkInputSize(request: IsolatedParseRequest): Promise<void> {
    const { input } = request;
    const size = input instanceof Uint8Array ? input.length : (await stat(input.path)).size;
    if (size > this.#options.maxInputBytes) {
      throw new LimitExceededError(`Input of ${size} bytes exceeds the maximum of ${this.#options.maxInputBytes} bytes`);
    }
  }
}

function disposedError(): IsolationError {
  return new IsolationError("unavailable", "ChildRunner was disposed");
}
