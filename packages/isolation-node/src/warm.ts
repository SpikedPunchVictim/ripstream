import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import {
  AbortError,
  IsolationError,
  LimitExceededError,
  type IsolatedParseRequest,
  type IsolatedParseResult,
} from "@spikedpunch/ripstream-core";
import { encodeInputPrefix } from "./child-io.ts";
import { classifyExit, MARKER_CARRY_CHARS, scanStderrMarkers, type ExitFacts, type KillReason } from "./classify.ts";
import { rssPollKind } from "./containment.ts";
import { CpuPoller, sampleCpuSecs, type CpuSampler } from "./cpu.ts";
import { createCallDir, DEFAULT_DISK_POLL_MS, DiskPoller, removeCallDir, requireTempDir } from "./disk.ts";
import { FrameReader, type FrameEvent } from "./frames.ts";
import { DEFAULT_MAX_DISK_MB } from "./limits.ts";
import type { Lease, MemoryPool } from "./pool.ts";
import type { ResolvedReuse } from "./reuse.ts";
import { StderrRing } from "./ring.ts";
import { DEFAULT_POLL_MS, RssPoller, sampleRssMb } from "./rss.ts";
import {
  DEFAULT_DISPOSE_WAIT_MS,
  parentResultMb,
  requireMemoryOrder,
  requirePositiveInteger,
  segmentBytesFor,
  type ChildRunnerOptions,
  type RunLimits,
} from "./runner.ts";
import {
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_STDERR_BUDGET_BYTES,
  DRAIN_MS,
  inputHeaderFor,
  KILL_REASON_BY_VIOLATION,
  REAP_WAIT_MS,
  type RunDiagnostics,
} from "./supervisor.ts";
import { clampTimerMs } from "./timers.ts";
import { buildWrapperCommand } from "./wrapper.ts";

/**
 * Reused ("warm") isolated children: the opt-in alternative to ChildRunner (reuse.ts has the switch). A child is
 * started through the same ulimit wrapper with the same limits, told by an environment variable to serve more than
 * one request (child-main.ts), and kept after a clean answer for the next request of the SAME trust domain and heap
 * size. Everything about one request is watched as for a fresh child (wall-clock deadline, abort, RSS poll, disk
 * poll, frame caps), and the parent adds the checks a long-lived process needs, none of which relies on the child:
 *
 *  - CPU per request: RLIMIT_CPU counts the process's whole life, so the wrapper's limit is only a backstop
 *    (`cpuSecs * maxRequests`, at most a day). The parent polls the child's CPU time during the request and samples
 *    it once more after the answer; what the request added (CPU spent while idle included) must stay within
 *    `cpuSecs`, or the answer becomes a LimitExceededError and the child is retired.
 *  - The child's TMPDIR is listed after every request: anything left in it retires the child (its directory is
 *    removed with it). A cleanup that depended on the parser would be no cleanup at all.
 *  - Memory: every `rssSampleEvery` requests the child's RSS is measured; above `rssCeilingMb` it is retired.
 *  - Anything unusual retires it: an error frame, a result that carries an exception or any `tk:exception:` key (a
 *    parse that failed halfway may leave a parser's module state inconsistent), bytes on fd 3 outside a request's
 *    frames, input the child did not consume, a spent stderr budget, an exit, `maxRequests` reached.
 * A retired child is SIGKILLed with its group; a request whose child is retired is answered once the child is dead
 * and its directory removed (or after the reap wait, as for a fresh child).
 *
 * Memory accounting (pool.ts). A child holds ONE pool lease from its start until it is dead: while busy, its cap plus
 * the overshoot plus the parent's result memory of the request it serves; while idle, the result memory is refunded
 * and the child keeps its cap plus the overshoot. So the pool never holds more children than it was sized for, and
 * an idle child's memory is never counted twice. The next request takes the result memory back only when that does
 * not jump the queue (`tryCharge`); otherwise it waits in the pool queue like any request. Idle memory is never
 * stranded: a request that has to wait makes the pool call this runner's reclaimer, which retires idle children
 * (least recently used first), and a child that finishes while requests are queued is either handed to the request
 * at the head of the queue (when it is this runner's, wants the same kind of child and needs no more memory than the
 * child holds) or retired, so its memory goes to that head. Strict FIFO is kept.
 */

export type ChildRetireReason =
  | KillReason
  /** The child sent an error frame (whatever the error, the child is not trusted to be in a sound state after it). */
  | "error_frame"
  /** The child exited by itself (a crash, an odd or a zero exit, an EOF it was not sent). */
  | "exit"
  /** The child could not be started or never became ready. */
  | "unavailable"
  /** Something was left in the child's TMPDIR, or the directory itself was replaced or removed. */
  | "temp_leftover"
  /** The result carried an exception or a `tk:exception:` key. */
  | "exception"
  /** The child's CPU time could not be measured after the request. */
  | "cpu_unmeasured"
  /** The child used up its stderr budget and the parent closed the pipe. */
  | "stderr_budget"
  /** The child's memory was above `rssCeilingMb`, or could not be measured. */
  | "rss_ceiling"
  | "max_requests"
  /** A child started for a trust domain beyond `maxTrustDomains`: it serves one request. */
  | "single_use"
  | "idle_timeout"
  /** Retired to make room: for memory another request waits for, or for another idle child or trust domain. */
  | "evicted"
  | "dispose";

export interface ChildReuseStats {
  /** Trust domains with live children. */
  readonly domains: number;
  readonly idle: number;
  readonly busy: number;
  readonly spawned: number;
  /** Requests answered by a child that had answered one before. */
  readonly reused: number;
  /** Children retired so far, by reason. Reasons that never happened are absent. */
  readonly retired: Readonly<Partial<Record<ChildRetireReason, number>>>;
}

export interface WarmRunnerOptions extends ChildRunnerOptions {
  readonly reuse: ResolvedReuse;
  /** @internal Test seam: replaces the CPU measurement (polls and the final sample). */
  readonly cpuSampler?: CpuSampler;
  /** @internal CPU poll interval. Default: 100 ms with /proc, 250 ms with `ps`. */
  readonly cpuPollMs?: number;
  /** @internal Test seam: replaces the RSS ceiling measurement. */
  readonly rssCeilingSampler?: (pid: number) => number | null | Promise<number | null>;
}

export interface WarmRunOptions {
  readonly signal?: AbortSignal;
  readonly limits?: RunLimits;
  /** Default: the configured `reuse.trustDomain`. */
  readonly trustDomain?: string;
}

const MAX_CPU_BACKSTOP_SECS = 86_400;
const TIKA_EXCEPTION_PREFIX = "tk:exception:";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function carriesFault(result: IsolatedParseResult): boolean {
  const keyed = (metadata: Readonly<Record<string, unknown>>): boolean =>
    Object.keys(metadata).some((key) => key.startsWith(TIKA_EXCEPTION_PREFIX));
  if (result.kind === "text") return result.exception !== undefined || keyed(result.metadata);
  return result.records.some((record) => record.exception !== null || keyed(record.metadata));
}

/** What one request needs that the child does not already know. */
interface RequestSpec {
  readonly request: IsolatedParseRequest;
  readonly prefix: Buffer;
  /** performance.now() at which the request's wall-clock budget ends. */
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly maxResultBytes: number;
  readonly maxFrameBytes: number | undefined;
  /** Bytes of segments frames the request may carry; undefined: none. */
  readonly maxSegmentBytes: number | undefined;
}

interface Verdict {
  readonly result: IsolatedParseResult | null;
  readonly error: Error | null;
  /** Why the child was retired, or null when it may serve again. */
  readonly retire: ChildRetireReason | null;
}

/** One request on one child. */
interface ActiveRequest {
  readonly spec: RequestSpec;
  readonly reader: FrameReader;
  readonly resolve: (verdict: Verdict) => void;
  /** A new process (its own "ready" frame comes first), not a reused one. */
  readonly fresh: boolean;
  readonly t0: number;
  readonly onAbort: () => void;
  deadlineTimer: NodeJS.Timeout | undefined;
  readyTimer: NodeJS.Timeout | undefined;
  reapTimer: NodeJS.Timeout | undefined;
  drainTimer: NodeJS.Timeout | undefined;
  rss: RssPoller | null;
  disk: DiskPoller | null;
  cpu: CpuPoller | null;
  killReason: KillReason | null;
  abortReason: unknown;
  protocolDetail: string | undefined;
  readyTimedOut: boolean;
  stopping: boolean;
  terminalSeen: boolean;
  settled: boolean;
  fd3Bytes: number;
  readyMs: number | null;
  terminalMs: number | null;
  /** Resolves true once the kernel took the whole request (the last write's callback), false on a write error. */
  flushed: Promise<boolean> | null;
}

interface WarmChildConfig {
  readonly options: WarmRunnerOptions;
  readonly platform: NodeJS.Platform;
  readonly reapWaitMs: number;
  readonly readyTimeoutMs: number;
  readonly stderrBudget: number;
  readonly key: string;
  /** null: a single-use child (its domain was beyond `maxTrustDomains`). */
  readonly domain: string | null;
  readonly heapMb: number;
  readonly callDir: string;
  /** Called once, synchronously, when the child is retired or found dead, with the state it was in. */
  readonly onRetired: (child: WarmChild, reason: ChildRetireReason, was: "busy" | "idle") => void;
}

/** One reusable child process and the request it is serving, if any. */
class WarmChild {
  readonly key: string;
  readonly domain: string | null;
  readonly dead: Promise<void>;
  lease: Lease;
  state: "busy" | "idle" | "retired" = "busy";
  retireReason: ChildRetireReason | null = null;
  served = 0;
  lastUsedAt = performance.now();
  /** Counted in WarmRunner's unreaped figure (answered while it was still alive after being retired). */
  countedUnreaped = false;

  readonly #config: WarmChildConfig;
  readonly #proc: ChildProcess;
  #markDead!: () => void;
  #isDead = false;
  #exited = false;
  #code: number | null = null;
  #signal: string | null = null;
  #exitMs: number | null = null;
  #spawnError: { readonly code: string | undefined; readonly syscall: string | undefined } | null = null;
  #stdinError: string | null = null;
  #removal: Promise<void> | null = null;
  #tempCleanupError: string | null = null;
  #cpuBaselineSecs = 0;
  #stderrBytes = 0;
  #stderrClosed = false;
  #ring = new StderrRing(8 * 1024);
  #markers = { memory: false, stringLength: false, heap: false };
  #carry = "";
  /** Bytes arrived on fd 3 outside a request's frames. */
  #lateBytes = false;
  #req: ActiveRequest | null = null;
  #idleTimer: NodeJS.Timeout | undefined;

  constructor(proc: ChildProcess, lease: Lease, config: WarmChildConfig) {
    this.#proc = proc;
    this.lease = lease;
    this.#config = config;
    this.key = config.key;
    this.domain = config.domain;
    this.dead = new Promise<void>((resolve) => {
      this.#markDead = () => {
        this.#isDead = true;
        resolve();
      };
    });
    proc.on("error", (error: NodeJS.ErrnoException) => this.#onProcError(error));
    proc.once("exit", (code, signal) => this.#onExit(code, signal));
    proc.once("close", () => this.#onClose());
    proc.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      this.#stdinError = error.code ?? error.message;
    });
    const stderr = proc.stderr as Readable | null;
    stderr?.on("error", () => {});
    stderr?.on("data", (chunk: Uint8Array) => this.#onStderr(chunk));
    const fd3 = this.#fd3();
    fd3?.on("error", () => {});
    fd3?.on("data", (chunk: Uint8Array) => this.#onFd3(chunk));
    fd3?.on("end", () => {
      // fd 3 closed while idle: the child is exiting (its pipes close before its exit is reported), or it closed its
      // answer channel and can never answer again. Either way it is not checked out.
      if (this.state === "idle") this.retire("exit");
    });
  }

  get pid(): number | undefined {
    return this.#proc.pid;
  }

  get isDead(): boolean {
    return this.#isDead;
  }

  /** Serves one request. Never rejects: failures are verdicts. The child holds the lease for the request already. */
  serve(spec: RequestSpec, fresh: boolean): Promise<Verdict> {
    return new Promise<Verdict>((resolve) => {
      const req: ActiveRequest = {
        spec,
        reader: new FrameReader({
          maxTotalBytes: spec.maxResultBytes,
          output: spec.request.output ?? "text",
          ...(spec.maxFrameBytes === undefined ? {} : { maxFrameBytes: spec.maxFrameBytes }),
          ...(this.#config.options.maxFrames === undefined ? {} : { maxFrames: this.#config.options.maxFrames }),
          ...(spec.request.unpackBytes === undefined ? {} : { unpackBytes: spec.request.unpackBytes }),
          ...(spec.maxSegmentBytes === undefined ? {} : { maxSegmentBytes: spec.maxSegmentBytes }),
        }),
        resolve,
        fresh,
        t0: performance.now(),
        onAbort: () => {
          req.abortReason = spec.signal.reason;
          this.#kill(req, "abort");
        },
        deadlineTimer: undefined,
        readyTimer: undefined,
        reapTimer: undefined,
        drainTimer: undefined,
        rss: null,
        disk: null,
        cpu: null,
        killReason: null,
        abortReason: undefined,
        protocolDetail: undefined,
        readyTimedOut: false,
        stopping: false,
        terminalSeen: false,
        settled: false,
        fd3Bytes: 0,
        readyMs: null,
        terminalMs: null,
        flushed: null,
      };
      this.#req = req;
      this.served += 1;
      this.lastUsedAt = performance.now();
      // Stderr facts are per request: a marker seen during an earlier request must not classify this one.
      this.#ring = new StderrRing(8 * 1024);
      this.#markers = { memory: false, stringLength: false, heap: false };
      this.#carry = "";
      if (this.state === "retired") {
        // Died between checkout and now (a reused child checked out from the idle list is alive, so this is defensive).
        this.#finishDead(req, new IsolationError("unavailable", "The reused isolated parser ended before the request was sent"));
        return;
      }
      this.#setRef(true);
      const remaining = spec.deadlineAt - performance.now();
      req.deadlineTimer = setTimeout(() => this.#kill(req, "timeout"), clampTimerMs(Math.max(0, remaining)));
      if (spec.signal.aborted) {
        req.onAbort();
        return;
      }
      spec.signal.addEventListener("abort", req.onAbort, { once: true });
      if (fresh) {
        if (this.#config.readyTimeoutMs < remaining) {
          req.readyTimer = setTimeout(() => {
            req.readyTimedOut = true;
            this.#kill(req, null);
          }, clampTimerMs(this.#config.readyTimeoutMs));
        }
        return; // the child's own "ready" frame arrives on fd 3
      }
      // A reused child said "ready" once, at boot; its frame reader for this request starts after it.
      this.#feed(req, Buffer.from(`${JSON.stringify({ t: "ready", pid: this.pid })}\n`, "utf8"));
    });
  }

  /** Parks the child: it no longer keeps this process alive, and it is retired after `idleTimeoutMs`. */
  goIdle(idleTimeoutMs: number): void {
    if (this.state !== "busy") return;
    this.state = "idle";
    this.#req = null;
    this.lastUsedAt = performance.now();
    this.#setRef(false);
    this.#idleTimer = setTimeout(() => this.retire("idle_timeout"), clampTimerMs(idleTimeoutMs));
    this.#idleTimer.unref();
    // Late bytes that arrived between the answer and now count as if they arrived now.
    if (this.#lateBytes) this.retire("protocol");
  }

  /** Taken from the idle list for a request. */
  checkOut(): void {
    if (this.state !== "idle") throw new Error(`unreachable: checking out a ${this.state} child`);
    this.state = "busy";
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  /** Kills the child's group and reports it retired (once). Its lease is released when it is dead. */
  retire(reason: ChildRetireReason): void {
    if (this.state !== "retired") {
      const was = this.state;
      this.state = "retired";
      this.retireReason = reason;
      if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
      this.#config.onRetired(this, reason, was);
    }
    this.#groupKill();
  }

  // ---- process events -------------------------------------------------------

  #fd3(): Readable | null {
    return (this.#proc.stdio[3] as Readable | null | undefined) ?? null;
  }

  #setRef(on: boolean): void {
    const proc = this.#proc;
    for (const stream of [proc.stdin, proc.stderr, this.#fd3()]) {
      const handle = stream as unknown as { ref?: () => void; unref?: () => void } | null;
      if (on) handle?.ref?.();
      else handle?.unref?.();
    }
    if (on) proc.ref();
    else proc.unref();
  }

  #onStderr(chunk: Uint8Array): void {
    this.#stderrBytes += chunk.length;
    this.#ring.push(chunk);
    const text = this.#carry + Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length).toString("latin1");
    const seen = scanStderrMarkers(text);
    this.#markers = {
      memory: this.#markers.memory || seen.memory,
      stringLength: this.#markers.stringLength || seen.stringLength,
      heap: this.#markers.heap || seen.heap === true,
    };
    this.#carry = text.slice(-MARKER_CARRY_CHARS);
    if (this.#stderrBytes >= this.#config.stderrBudget && !this.#stderrClosed) {
      this.#stderrClosed = true;
      (this.#proc.stderr as Readable | null)?.destroy();
      if (this.state === "idle") this.retire("stderr_budget");
    }
  }

  #onFd3(chunk: Uint8Array): void {
    const req = this.#req;
    if (req === null || req.terminalSeen || req.stopping || req.settled) {
      if (chunk.length === 0) return;
      // Nobody asked: the child wrote past its answer or while idle. It is not kept.
      this.#lateBytes = true;
      if (this.state === "idle") this.retire("protocol");
      return;
    }
    this.#feed(req, chunk);
  }

  #feed(req: ActiveRequest, chunk: Uint8Array): void {
    req.fd3Bytes += chunk.length;
    const events: FrameEvent[] = req.reader.push(chunk);
    for (const event of events) {
      if (event.type === "violation") {
        req.protocolDetail = event.message;
        this.#kill(req, KILL_REASON_BY_VIOLATION[event.kind]);
        return;
      }
      if (event.frame.t === "ready") this.#onReady(req);
      else if (event.frame.t === "done" || event.frame.t === "error") {
        this.#onTerminal(req);
        return;
      }
    }
  }

  #onReady(req: ActiveRequest): void {
    req.readyMs = Math.round(performance.now() - req.t0);
    if (req.readyTimer !== undefined) clearTimeout(req.readyTimer);
    req.readyTimer = undefined;
    this.#startPollers(req);
    const stdin = this.#proc.stdin;
    if (stdin === null || stdin.destroyed || stdin.writableEnded) return; // the exit decides
    // Errors (EPIPE) arrive on the 'error' listener; the child's exit decides the outcome. stdin stays open: the
    // next request follows on it, and closing it is how the parent tells an idle child to exit.
    const { input } = req.spec.request;
    const chunks = input instanceof Uint8Array && input.length > 0 ? [req.spec.prefix, input] : [req.spec.prefix];
    req.flushed = new Promise<boolean>((resolve) => {
      chunks.forEach((chunk, index) => {
        if (index < chunks.length - 1) stdin.write(chunk);
        else stdin.write(chunk, (error) => resolve(error === null || error === undefined));
      });
    });
  }

  #startPollers(req: ActiveRequest): void {
    const o = this.#config.options;
    const pid = this.pid;
    if (pid === undefined) return;
    if (rssPollKind(this.#config.platform) !== "none") {
      req.rss = new RssPoller({
        pid,
        platform: this.#config.platform,
        limitMb: o.rssLimitMb,
        pollMs: o.pollMs ?? DEFAULT_POLL_MS,
        delayFirstSample: !req.fresh,
        onOverLimit: () => this.#kill(req, "rss"),
      });
      req.rss.start();
    }
    req.disk = new DiskPoller({
      dir: this.#config.callDir,
      limitMb: o.maxDiskMb ?? DEFAULT_MAX_DISK_MB,
      pollMs: o.diskPollMs ?? DEFAULT_DISK_POLL_MS,
      onOverLimit: () => this.#kill(req, "disk"),
    });
    req.disk.start();
    req.cpu = new CpuPoller({
      pid,
      platform: this.#config.platform,
      baselineSecs: this.#cpuBaselineSecs,
      budgetSecs: o.cpuSecs,
      ...(o.cpuPollMs === undefined ? {} : { pollMs: o.cpuPollMs }),
      ...(o.cpuSampler === undefined ? {} : { sample: o.cpuSampler }),
      onOverBudget: () => this.#kill(req, "cpu"),
    });
    req.cpu.start();
  }

  #stopRequestWatch(req: ActiveRequest): void {
    for (const timer of [req.deadlineTimer, req.readyTimer]) if (timer !== undefined) clearTimeout(timer);
    req.deadlineTimer = undefined;
    req.readyTimer = undefined;
    req.rss?.stop();
    req.disk?.stop();
    req.cpu?.stop();
    req.spec.signal.removeEventListener("abort", req.onAbort);
  }

  #onTerminal(req: ActiveRequest): void {
    req.terminalSeen = true;
    req.terminalMs = Math.round(performance.now() - req.t0);
    if (req.reader.trailingBytes) this.#lateBytes = true;
    if (req.drainTimer !== undefined) clearTimeout(req.drainTimer);
    req.drainTimer = undefined;
    this.#stopRequestWatch(req);
    void this.#finishAnswered(req);
  }

  /** Records why FIRST, then kills the group (a reused child is never asked to stop: it is retired). */
  #kill(req: ActiveRequest, reason: KillReason | null): void {
    if (req.settled || req.stopping || req.terminalSeen) return;
    if (reason !== null && req.killReason === null) req.killReason = reason;
    if (this.#exited) {
      if (reason !== null) this.#finishDead(req);
      return;
    }
    req.stopping = true;
    this.#stopRequestWatch(req);
    this.retire(reason ?? "unavailable");
    req.reapTimer = setTimeout(() => this.#finishDead(req), clampTimerMs(this.#config.reapWaitMs));
  }

  #groupKill(): void {
    const pid = this.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ESRCH: nothing left to kill.
    }
  }

  #onProcError(error: NodeJS.ErrnoException): void {
    if (this.pid !== undefined) return; // not a spawn failure; the exit event decides
    this.#spawnError = { code: error.code, syscall: error.syscall };
    if (this.state !== "retired") this.retire("unavailable");
    void this.#removeCallDir().then(() => {
      this.#markDead();
      const req = this.#req;
      if (req !== null && !req.settled) {
        this.#finishDead(
          req,
          new IsolationError("unavailable", `Could not start the isolated parser (${error.code ?? error.message})`, { cause: error }),
        );
      }
    });
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#exited = true;
    this.#code = code;
    this.#signal = signal;
    const req = this.#req;
    this.#exitMs = req === null ? null : Math.round(performance.now() - req.t0);
    if (req !== null && !req.terminalSeen) {
      for (const timer of [req.deadlineTimer, req.readyTimer]) if (timer !== undefined) clearTimeout(timer);
      req.deadlineTimer = undefined;
      req.readyTimer = undefined;
      req.rss?.stop();
      req.disk?.stop();
      req.cpu?.stop();
    }
    if (this.state !== "retired") this.retire("exit");
    this.#groupKill(); // sweep lingering grandchildren
    void this.#removeCallDir().then(() => {
      this.#markDead();
      if (req === null || req.settled || req.terminalSeen) return; // the answered path sees #exited itself
      if (req.stopping) {
        this.#finishDead(req);
        return;
      }
      // No verdict yet: frames may still be in the pipe.
      req.drainTimer = setTimeout(() => this.#finishDead(req), DRAIN_MS);
    });
  }

  #onClose(): void {
    const req = this.#req;
    if (this.#exited && req !== null && !req.settled && !req.terminalSeen) this.#finishDead(req);
  }

  #removeCallDir(): Promise<void> {
    if (this.#removal !== null) return this.#removal;
    const dir = this.#config.callDir;
    this.#removal = removeCallDir(dir).catch((error: unknown) => {
      const message = `Could not remove the isolated parser's temporary directory ${dir}: ${errorText(error)}`;
      this.#tempCleanupError = message;
      try {
        this.#config.options.onTempCleanupError?.(message);
      } catch {
        // reporting is best effort
      }
    });
    return this.#removal;
  }

  // ---- verdicts -------------------------------------------------------------

  #facts(req: ActiveRequest): ExitFacts {
    const errorFrame = req.reader.errorFrame;
    const o = this.#config.options;
    return {
      phase: req.reader.phase,
      terminal: req.reader.terminal,
      ...(errorFrame === null ? {} : { errorFrame }),
      killReason: req.killReason,
      code: this.#code,
      signal: this.#signal,
      stderrTail: this.#ring.text(),
      stderrMarkers: this.#markers,
      memory: {
        heapMb: this.#config.heapMb,
        rssLimitMb: o.rssLimitMb,
        peakRssMb: req.rss?.stats().samples ? req.rss.stats().peakMb : null,
      },
      ...(req.killReason === "abort" ? { abortReason: req.abortReason } : {}),
      ...(req.protocolDetail === undefined ? {} : { protocolDetail: req.protocolDetail }),
      ...(req.killReason === "disk"
        ? {
            disk: {
              limitMb: o.maxDiskMb ?? DEFAULT_MAX_DISK_MB,
              boundHit: req.disk?.stats().boundHit ?? false,
              unreadable: req.disk?.stats().unreadable ?? false,
            },
          }
        : {}),
    };
  }

  /** The child is dead (or did not die within the reap wait): classify what was seen, as for a fresh child. */
  #finishDead(req: ActiveRequest, forced?: Error): void {
    if (req.settled) return;
    if (this.#exited && !this.#isDead) {
      void this.dead.then(() => this.#finishDead(req, forced));
      return;
    }
    let result: IsolatedParseResult | null = null;
    let error: Error | null = forced ?? null;
    if (error === null) {
      try {
        error = classifyExit(this.#facts(req));
        if (error === null) result = req.reader.result();
      } catch (thrown) {
        error = thrown instanceof Error ? thrown : new Error(String(thrown));
      }
    }
    if (this.state !== "retired") this.retire("exit");
    this.#settle(req, { result, error, retire: this.retireReason ?? "exit" });
  }

  /** A terminal frame arrived: decide whether the answer stands and whether the child may serve again. */
  async #finishAnswered(req: ActiveRequest): Promise<void> {
    let result: IsolatedParseResult | null = null;
    let error: Error | null = null;
    try {
      error = classifyExit(this.#facts(req));
      if (error === null) result = req.reader.result();
    } catch (thrown) {
      error = thrown instanceof Error ? thrown : new Error(String(thrown));
    }
    let retire: ChildRetireReason | null = null;
    if (req.reader.terminal === "error") retire = "error_frame";
    else if (error !== null) retire = "protocol";
    else retire = await this.#afterCleanAnswer(req, result);
    if (retire === "cpu") {
      result = null;
      error = new LimitExceededError("Isolated parser exceeded its CPU time limit");
    }
    if (retire !== null) {
      this.retire(this.state === "retired" ? (this.retireReason ?? retire) : retire);
      await this.#deadOrGiveUp();
    }
    this.#settle(req, { result, error, retire: retire === null ? null : (this.retireReason ?? retire) });
  }

  /** The checks a clean answer must pass before the child is kept. Null: keep it. */
  async #afterCleanAnswer(req: ActiveRequest, result: IsolatedParseResult | null): Promise<ChildRetireReason | null> {
    const o = this.#config.options;
    const pid = this.pid;
    if (this.#gone() || pid === undefined) return this.retireReason ?? "exit";
    const [cpuSecs, tempOk, flushed] = await Promise.all([
      Promise.resolve(o.cpuSampler === undefined ? sampleCpuSecs(pid, this.#config.platform) : o.cpuSampler(pid)).catch(() => null),
      this.#tempDirIsClean(),
      this.#flushedWithin(req, DRAIN_MS),
    ]);
    if (this.#gone()) return this.retireReason ?? "exit";
    if (cpuSecs === null) return "cpu_unmeasured";
    if (cpuSecs - this.#cpuBaselineSecs > o.cpuSecs) return "cpu";
    this.#cpuBaselineSecs = cpuSecs;
    if (this.#lateBytes) return "protocol";
    // The child answered, yet the kernel never took the whole request: it did not read its input.
    if (!flushed) return "protocol";
    if (!tempOk) return "temp_leftover";
    if (this.#stderrClosed) return "stderr_budget";
    if (result !== null && carriesFault(result)) return "exception";
    if (this.served >= o.reuse.maxRequests) return "max_requests";
    if (this.domain === null) return "single_use";
    if (this.served % o.reuse.rssSampleEvery === 0) {
      const sampler = o.rssCeilingSampler;
      const rssMb = await Promise.resolve(sampler === undefined ? sampleRssMb(pid, this.#config.platform) : sampler(pid)).catch(() => null);
      if (this.#gone()) return this.retireReason ?? "exit";
      if (rssMb === null || rssMb > o.reuse.rssCeilingMb) return "rss_ceiling";
    }
    return null;
  }

  /** Whether the request's last write completed within `ms` (it has, unless the child stopped reading its input). */
  async #flushedWithin(req: ActiveRequest, ms: number): Promise<boolean> {
    if (req.flushed === null) return false;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([req.flushed, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retired or exited (re-read after every await: either can happen while the parent measures). */
  #gone(): boolean {
    return this.state === "retired" || this.#exited;
  }

  /** The child's TMPDIR is still a real directory, and empty. Measured by the parent; the parser is not asked. */
  async #tempDirIsClean(): Promise<boolean> {
    const dir = this.#config.callDir;
    try {
      if (!(await lstat(dir)).isDirectory()) return false;
      return (await readdir(dir)).length === 0;
    } catch {
      return false; // removed, made unreadable, or replaced: not kept
    }
  }

  /** Waits for the retired child to be dead, at most the reap wait (a child that survives SIGKILL keeps its lease). */
  async #deadOrGiveUp(): Promise<void> {
    if (this.#isDead) return;
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, clampTimerMs(this.#config.reapWaitMs));
    });
    try {
      await Promise.race([this.dead, gaveUp]);
    } finally {
      clearTimeout(timer);
    }
  }

  #settle(req: ActiveRequest, verdict: Verdict): void {
    if (req.settled) return;
    req.settled = true;
    this.#stopRequestWatch(req);
    for (const timer of [req.reapTimer, req.drainTimer]) if (timer !== undefined) clearTimeout(timer);
    req.reapTimer = undefined;
    req.drainTimer = undefined;
    if (this.state === "retired") {
      this.#proc.stdin?.destroy();
      (this.#proc.stderr as Readable | null)?.destroy();
      this.#fd3()?.destroy();
      if (!this.#exited) this.#proc.unref();
    }
    try {
      this.#config.options.onRunSettled?.(this.#diagnostics(req));
    } catch {
      // diagnostics are best effort
    }
    req.resolve(verdict);
  }

  #diagnostics(req: ActiveRequest): RunDiagnostics {
    const outcome =
      this.#spawnError !== null
        ? `spawn:${this.#spawnError.code ?? "?"}`
        : !this.#exited
          ? this.state === "retired"
            ? "unreaped"
            : "alive"
          : this.#signal !== null
            ? `signal:${this.#signal}`
            : `code:${String(this.#code)}`;
    return {
      pid: this.pid,
      spawnError: this.#spawnError,
      phase: req.reader.phase,
      terminal: req.reader.terminal,
      killReason: req.killReason,
      readyTimedOut: req.readyTimedOut,
      graceKilled: false,
      code: this.#code,
      signal: this.#signal,
      reaped: this.#exited,
      readyMs: req.readyMs,
      terminalMs: req.terminalMs,
      exitMs: this.#exitMs,
      settledMs: Math.round(performance.now() - req.t0),
      fd3Bytes: req.fd3Bytes,
      frameCount: req.reader.frameCount,
      stderrTail: this.#ring.text(),
      stderrBytes: this.#stderrBytes,
      stderrClosed: this.#stderrClosed,
      stdinError: this.#stdinError,
      rss: req.rss?.stats() ?? null,
      disk: req.disk?.stats() ?? null,
      callDir: this.#config.callDir,
      tempCleanupError: this.#tempCleanupError,
      outcome,
    };
  }
}

/** A request of this runner waiting in the pool queue, which a finishing child of its kind can be handed to. */
interface PendingRequest {
  readonly key: string;
  readonly parentMb: number;
  /** Hands `child` over; false when the request is no longer waiting. */
  give(child: WarmChild): boolean;
}

interface DomainEntry {
  /** Oldest first. */
  readonly idle: WarmChild[];
  busy: number;
  lastUsedAt: number;
}

/**
 * ChildRunner's counterpart for reused children: same `run` / `dispose` / `unreapedChildren` surface, plus the trust
 * domain per request and `stats()`.
 */
export class WarmRunner {
  readonly #options: WarmRunnerOptions;
  readonly #reuse: ResolvedReuse;
  readonly #platform: NodeJS.Platform;
  readonly #controllers = new Set<AbortController>();
  readonly #inflight = new Set<Promise<unknown>>();
  readonly #deaths = new Set<Promise<void>>();
  readonly #domains = new Map<string, DomainEntry>();
  readonly #pending = new Set<PendingRequest>();
  readonly #retired: Partial<Record<ChildRetireReason, number>> = {};
  readonly #disposeWaitMs: number;
  readonly #removeReclaimer: () => void;
  #idleCount = 0;
  #spawned = 0;
  #reused = 0;
  #unreaped = 0;
  #disposed = false;

  constructor(options: WarmRunnerOptions) {
    for (const name of ["perChildMb", "heapMb", "cpuSecs", "maxTaskMillis", "maxInputBytes", "maxResultBytes", "rssLimitMb"] as const) {
      requirePositiveInteger(name, options[name]);
    }
    if (options.maxDiskMb !== undefined) requirePositiveInteger("maxDiskMb", options.maxDiskMb);
    if (options.tempDir !== undefined) requireTempDir(options.tempDir);
    if (options.childScript.length === 0) throw new TypeError("childScript must be a non-empty path");
    requireMemoryOrder(options.heapMb, options.rssLimitMb, options.perChildMb);
    if (options.reuse.rssCeilingMb >= options.rssLimitMb) {
      throw new RangeError(`reuse.rssCeilingMb (${options.reuse.rssCeilingMb}) must be below rssLimitMb (${options.rssLimitMb})`);
    }
    this.#platform = options.platform ?? process.platform;
    if (rssPollKind(this.#platform) === "none" && options.cpuSampler === undefined) {
      throw new RangeError(`reuse cannot be enabled on ${this.#platform}: the parent cannot measure a child's CPU time per request there`);
    }
    this.#disposeWaitMs = options.disposeWaitMs ?? DEFAULT_DISPOSE_WAIT_MS;
    if (!Number.isFinite(this.#disposeWaitMs) || this.#disposeWaitMs < 0) {
      throw new RangeError(`disposeWaitMs must be a non-negative number, got ${String(this.#disposeWaitMs)}`);
    }
    this.#options = options;
    this.#reuse = options.reuse;
    this.#removeReclaimer = options.pool.addReclaimer((shortfallMb) => this.#reclaim(shortfallMb));
  }

  /** Runs one request on a reused child of its trust domain, or on a new one. Rejections are as ChildRunner's. */
  async run(request: IsolatedParseRequest, options: WarmRunOptions = {}): Promise<IsolatedParseResult> {
    if (this.#disposed) throw disposedError();
    const controller = new AbortController();
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
    this.#controllers.add(controller);
    const work = this.#run(request, signal, options.limits ?? {}, options.trustDomain ?? this.#reuse.trustDomain);
    this.#inflight.add(work);
    try {
      return await work;
    } catch (error) {
      throw this.#disposed && error instanceof AbortError ? disposedError() : error;
    } finally {
      this.#inflight.delete(work);
      this.#controllers.delete(controller);
    }
  }

  /** Rejects running and queued requests, retires every child and waits (at most `disposeWaitMs`) until they are dead. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#removeReclaimer();
    for (const controller of this.#controllers) controller.abort(disposedError());
    await Promise.allSettled([...this.#inflight]);
    for (const child of this.#idleChildren()) child.retire("dispose");
    if (this.#deaths.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, clampTimerMs(this.#disposeWaitMs));
    });
    try {
      await Promise.race([Promise.allSettled([...this.#deaths]), gaveUp]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retired children whose request was answered before the kernel reaped them; they still hold their lease. Should be 0. */
  get unreapedChildren(): number {
    return this.#unreaped;
  }

  stats(): ChildReuseStats {
    let busy = 0;
    for (const entry of this.#domains.values()) busy += entry.busy;
    return {
      domains: this.#domains.size,
      idle: this.#idleCount,
      busy,
      spawned: this.#spawned,
      reused: this.#reused,
      retired: { ...this.#retired },
    };
  }

  async #run(request: IsolatedParseRequest, signal: AbortSignal, limits: RunLimits, domain: string): Promise<IsolatedParseResult> {
    const o = this.#options;
    const deadlineAt = performance.now() + o.maxTaskMillis;
    const heapMb = limits.heapMb ?? o.heapMb;
    const maxResultBytes = limits.maxResultBytes ?? o.maxResultBytes;
    const maxFrameBytes = limits.maxFrameBytes ?? o.maxFrameBytes;
    for (const [name, value] of [["heapMb", limits.heapMb], ["maxResultBytes", limits.maxResultBytes], ["maxFrameBytes", limits.maxFrameBytes], ["maxParseMillis", limits.maxParseMillis]] as const) {
      if (value !== undefined) requirePositiveInteger(name, value);
    }
    requireMemoryOrder(heapMb, o.rssLimitMb, o.perChildMb);
    await this.#checkInputSize(request);
    const prefix = encodeInputPrefix(inputHeaderFor(request, o.components, limits.maxParseMillis));
    const segmentBytes = segmentBytesFor(request, limits);
    const parentMb = parentResultMb(
      maxResultBytes,
      request.output,
      request.unpackBytes === undefined ? undefined : { bytes: request.unpackBytes, wireBytes: limits.unpackWireBytes ?? 0 },
      request.maxOutputChars,
      segmentBytes,
    );
    // Heap first: the domain is the caller's string and may contain anything.
    const key = `${heapMb}:${domain}`;
    const spec: RequestSpec = { request, prefix, deadlineAt, signal, maxResultBytes, maxFrameBytes, maxSegmentBytes: segmentBytes };

    let child = this.#reuseIdle(key, parentMb);
    let fresh = false;
    if (child === null) {
      const got = await this.#acquire(key, parentMb, signal, deadlineAt);
      if ("child" in got) {
        child = got.child;
      } else {
        child = this.#adoptIdle(key, got.lease);
        if (child === null) {
          child = this.#spawn(domain, key, heapMb, got.lease);
          fresh = true;
        }
      }
    }
    if (!fresh) this.#reused += 1;
    this.#touch(child);
    const verdict = await child.serve(spec, fresh);
    if (verdict.retire === null) this.#checkIn(child, parentMb);
    else if (!child.isDead && !child.countedUnreaped) {
      child.countedUnreaped = true;
      this.#unreaped += 1;
    }
    if (verdict.result !== null) return verdict.result;
    throw verdict.error ?? new Error("unreachable: a verdict without a result or an error");
  }

  async #checkInputSize(request: IsolatedParseRequest): Promise<void> {
    const { input } = request;
    const size = input instanceof Uint8Array ? input.length : (await stat(input.path)).size;
    if (size > this.#options.maxInputBytes) {
      throw new LimitExceededError(`Input of ${size} bytes exceeds the maximum of ${this.#options.maxInputBytes} bytes`);
    }
  }

  // ---- checkout ---------------------------------------------------------------

  /** An idle child of `key` whose lease can take this request's result memory without jumping the queue. */
  #reuseIdle(key: string, parentMb: number): WarmChild | null {
    const child = this.#findIdle(key);
    if (child === null || !this.#options.pool.tryCharge(child.lease, parentMb)) return null;
    this.#takeIdle(child);
    return child;
  }

  /**
   * After a full grant: an idle child of `key` (one may have been parked while this request waited) takes the new
   * lease, and its idle lease goes back to the pool.
   */
  #adoptIdle(key: string, lease: Lease): WarmChild | null {
    const child = this.#findIdle(key);
    if (child === null) return null;
    this.#takeIdle(child);
    const idleLease = child.lease;
    child.lease = lease;
    idleLease.release();
    return child;
  }

  /** The pool's normal FIFO path; while it waits, a finishing child of the same kind can be handed over instead. */
  #acquire(key: string, parentMb: number, signal: AbortSignal, deadlineAt: number): Promise<{ lease: Lease } | { child: WarmChild }> {
    const o = this.#options;
    const controller = new AbortController();
    const forward = (): void => controller.abort(signal.reason);
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
    return new Promise<{ lease: Lease } | { child: WarmChild }>((resolve, reject) => {
      let done = false;
      const pending: PendingRequest = {
        key,
        parentMb,
        give: (child) => {
          if (done) return false;
          done = true;
          this.#pending.delete(pending);
          signal.removeEventListener("abort", forward);
          resolve({ child });
          controller.abort(); // leaves the queue; the rejection that follows is ignored
          return true;
        },
      };
      this.#pending.add(pending);
      o.pool
        .acquire(o.perChildMb, {
          signal: controller.signal,
          deadlineMs: Math.max(0, deadlineAt - performance.now()),
          parentMb,
          tag: pending,
        })
        .then(
          (lease) => {
            if (done) {
              lease.release();
              return;
            }
            done = true;
            this.#pending.delete(pending);
            signal.removeEventListener("abort", forward);
            resolve({ lease });
          },
          (error: unknown) => {
            if (done) return;
            done = true;
            this.#pending.delete(pending);
            signal.removeEventListener("abort", forward);
            reject(error);
          },
        );
    });
  }

  #spawn(domain: string, key: string, heapMb: number, lease: Lease): WarmChild {
    const o = this.#options;
    const pooled = this.#makeRoomForDomain(domain);
    let callDir: string;
    try {
      callDir = createCallDir(o.tempDir ?? tmpdir());
    } catch (error) {
      lease.release();
      throw new IsolationError("unavailable", `Could not create the isolated parser's temporary directory: ${errorText(error)}`, {
        cause: error,
      });
    }
    let proc: ChildProcess;
    try {
      const wrapper = buildWrapperCommand({
        nodePath: o.nodePath ?? process.execPath,
        scriptPath: o.childScript,
        ...(o.childArgs === undefined ? {} : { scriptArgs: o.childArgs }),
        ...(o.execArgv === undefined ? {} : { execArgv: o.execArgv }),
        // The kernel's limit counts the process's whole life: a backstop for all its requests. Each request's own
        // budget is the parent's to enforce (see the note at the top of this file).
        cpuSecs: Math.min(MAX_CPU_BACKSTOP_SECS, o.cpuSecs * this.#reuse.maxRequests),
        heapMb,
        ...(o.vmemKb === undefined ? {} : { vmemKb: o.vmemKb }),
        ...(o.parentEnv === undefined ? {} : { parentEnv: o.parentEnv }),
        platform: this.#platform,
        tmpDir: callDir,
        serve: true,
      });
      try {
        proc = (o.spawnFn ?? spawn)(wrapper.file, wrapper.args, {
          detached: true,
          stdio: ["pipe", "ignore", "pipe", "pipe"],
          env: wrapper.env,
        });
      } catch (error) {
        throw new IsolationError("unavailable", `Could not start the isolated parser: ${String(error)}`, { cause: error });
      }
    } catch (error) {
      void removeCallDir(callDir).catch((removalError: unknown) => {
        o.onTempCleanupError?.(`Could not remove the isolated parser's temporary directory ${callDir}: ${errorText(removalError)}`);
      });
      lease.release();
      throw error;
    }
    const child = new WarmChild(proc, lease, {
      options: o,
      platform: this.#platform,
      reapWaitMs: o.reapWaitMs ?? REAP_WAIT_MS,
      readyTimeoutMs: o.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      stderrBudget: o.stderrBudgetBytes ?? DEFAULT_STDERR_BUDGET_BYTES,
      key,
      domain: pooled ? domain : null,
      heapMb,
      callDir,
      onRetired: (retired, reason, was) => this.#onRetired(retired, reason, was),
    });
    this.#spawned += 1;
    if (pooled) this.#entry(domain).busy += 1;
    // The lease belongs to the child, not to a request: it is returned when the child is dead.
    const death = child.dead.then(() => {
      child.lease.release();
      if (child.countedUnreaped) this.#unreaped -= 1;
    });
    this.#deaths.add(death);
    void death.finally(() => this.#deaths.delete(death));
    return child;
  }

  /**
   * Whether a new child of `domain` may be kept after its request. A domain beyond `maxTrustDomains` takes the place
   * of the least recently used domain whose children are all idle; when every domain has a busy child, the new child
   * serves one request.
   */
  #makeRoomForDomain(domain: string): boolean {
    if (this.#domains.has(domain) || this.#domains.size < this.#reuse.maxTrustDomains) return true;
    let victim: [string, DomainEntry] | null = null;
    for (const entry of this.#domains.entries()) {
      if (entry[1].busy === 0 && (victim === null || entry[1].lastUsedAt < victim[1].lastUsedAt)) victim = entry;
    }
    if (victim === null) return false;
    for (const child of [...victim[1].idle]) child.retire("evicted");
    this.#domains.delete(victim[0]);
    return true;
  }

  // ---- checkin ----------------------------------------------------------------

  /** A child that answered cleanly: hand it to the head of the queue, park it, or retire it so the queue gets its memory. */
  #checkIn(child: WarmChild, parentMb: number): void {
    const pool = this.#options.pool;
    if (child.state !== "busy") return; // retired meanwhile; #onRetired did the bookkeeping
    const head = pool.headTag();
    if (head !== undefined && this.#pending.has(head as PendingRequest)) {
      const pending = head as PendingRequest;
      if (pending.key === child.key && pending.parentMb <= parentMb && pending.give(child)) {
        pool.refund(child.lease, parentMb - pending.parentMb);
        return;
      }
    }
    pool.refund(child.lease, parentMb);
    if (this.#disposed || pool.stats().queued > 0) {
      // Someone is still waiting for memory: an idle child must not hold it.
      child.retire(this.#disposed ? "dispose" : "evicted");
      return;
    }
    this.#park(child);
  }

  #park(child: WarmChild): void {
    const domain = child.domain;
    if (domain === null) {
      child.retire("single_use");
      return;
    }
    const entry = this.#entry(domain);
    entry.busy -= 1;
    child.goIdle(this.#reuse.idleTimeoutMs);
    if (child.state !== "idle") return; // goIdle retired it (late bytes); #onRetired counted it as idle
    entry.idle.push(child);
    this.#idleCount += 1;
    while (this.#idleCount > this.#reuse.maxIdleChildren) {
      const oldest = this.#leastRecentlyUsedIdle();
      if (oldest === null) break;
      oldest.retire("evicted");
    }
  }

  // ---- bookkeeping --------------------------------------------------------------

  #entry(domain: string): DomainEntry {
    let entry = this.#domains.get(domain);
    if (entry === undefined) {
      entry = { idle: [], busy: 0, lastUsedAt: performance.now() };
      this.#domains.set(domain, entry);
    }
    return entry;
  }

  #touch(child: WarmChild): void {
    if (child.domain === null) return;
    const entry = this.#domains.get(child.domain);
    if (entry !== undefined) entry.lastUsedAt = performance.now();
  }

  /** The most recently parked idle child of `key` (keeping the others idle lets them age out). */
  #findIdle(key: string): WarmChild | null {
    for (const entry of this.#domains.values()) {
      for (let index = entry.idle.length - 1; index >= 0; index -= 1) {
        const child = entry.idle[index]!;
        if (child.key === key && child.state === "idle") return child;
      }
    }
    return null;
  }

  #takeIdle(child: WarmChild): void {
    const entry = child.domain === null ? undefined : this.#domains.get(child.domain);
    if (entry === undefined) throw new Error("unreachable: an idle child without its domain entry");
    const index = entry.idle.indexOf(child);
    if (index === -1) throw new Error("unreachable: an idle child missing from its domain's idle list");
    entry.idle.splice(index, 1);
    this.#idleCount -= 1;
    entry.busy += 1;
    child.checkOut();
  }

  *#idleChildren(): Generator<WarmChild> {
    for (const entry of [...this.#domains.values()]) yield* [...entry.idle];
  }

  #leastRecentlyUsedIdle(): WarmChild | null {
    let oldest: WarmChild | null = null;
    for (const child of this.#idleChildren()) {
      if (oldest === null || child.lastUsedAt < oldest.lastUsedAt) oldest = child;
    }
    return oldest;
  }

  #onRetired(child: WarmChild, reason: ChildRetireReason, was: "busy" | "idle"): void {
    this.#retired[reason] = (this.#retired[reason] ?? 0) + 1;
    if (child.domain === null) return;
    const entry = this.#domains.get(child.domain);
    if (entry === undefined) return;
    if (was === "idle") {
      const index = entry.idle.indexOf(child);
      if (index !== -1) {
        entry.idle.splice(index, 1);
        this.#idleCount -= 1;
      }
    } else {
      entry.busy -= 1;
    }
    if (entry.busy === 0 && entry.idle.length === 0) this.#domains.delete(child.domain);
  }

  /** The pool's reclaimer: retires idle children, least recently used first, until `shortfallMb` is on its way back. */
  #reclaim(shortfallMb: number): void {
    let freed = 0;
    while (freed < shortfallMb) {
      const oldest = this.#leastRecentlyUsedIdle();
      if (oldest === null) return;
      freed += oldest.lease.reservedMb;
      oldest.retire("evicted");
    }
  }
}

function disposedError(): IsolationError {
  return new IsolationError("unavailable", "ChildRunner was disposed");
}
