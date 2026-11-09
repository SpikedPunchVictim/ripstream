import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { IsolationError, type IsolatedParseRequest, type IsolatedParseResult } from "@spikedpunch/ripstream-core";
import { encodeInputPrefix, type InputHeader } from "./child-io.ts";
import {
  classifyExit,
  MARKER_CARRY_CHARS,
  scanStderrMarkers,
  type ExitFacts,
  type KillReason,
} from "./classify.ts";
import {
  createCallDir,
  DEFAULT_DISK_POLL_MS,
  DiskPoller,
  removeCallDir,
  type DiskPollerOptions,
  type DiskStats,
} from "./disk.ts";
import { FrameReader, type FrameEvent, type FrameViolationKind } from "./frames.ts";
import { DEFAULT_POLL_MS, RssPoller, type RssPollerOptions, type RssStats } from "./rss.ts";
import { rssPollKind } from "./containment.ts";
import { StderrRing } from "./ring.ts";
import { clampTimerMs } from "./timers.ts";
import { buildWrapperCommand } from "./wrapper.ts";

/** How a frame-reader objection is recorded as the reason the child was killed. */
const KILL_REASON_BY_VIOLATION: Readonly<Record<FrameViolationKind, KillReason>> = {
  total_too_large: "result_cap",
  frame_too_large: "frame_cap",
  metadata_cap: "metadata_cap",
  protocol: "protocol",
};

/**
 * Spawns ONE child through the ulimit wrapper and supervises it until it has
 * produced a result or been killed. Every path resolves or rejects exactly once
 * and releases every timer, listener and stream.
 *
 * Process model (design v3): `child_process.spawn` (never fork/IPC), detached
 * so the child leads its own process group, stdio = [stdin pipe, ignored,
 * stderr pipe -> 8 KiB ring, fd 3 pipe -> FrameReader]. The parent's stdio is
 * never inherited. All kills are `SIGKILL` of the whole group (`-pid`), with
 * the kill reason recorded BEFORE the signal is sent.
 *
 * Lifecycle:
 *  - pre-ready: nothing is written to stdin until the child's "ready" frame
 *    arrives. A ready deadline (default 10 s, never later than the overall
 *    deadline) kills a child that never gets there; that is infrastructure
 *    failure (unavailable), not a timeout.
 *  - post-ready: input is written to stdin; the wall-clock deadline, the
 *    AbortSignal, the RSS poll, the disk poll and the frame reader's caps can
 *    kill the group.
 *  - terminal frame ("done" | "error"): the child gets `graceMs` to exit by
 *    itself, then the group is killed. The run settles when the group leader
 *    has been reaped; it never waits for 'close', which a grandchild that
 *    inherited the stdio fds can hold open for seconds (chaos rows j and n).
 *  - leader 'exit': the group is swept (SIGKILL, idempotent) so lingering
 *    grandchildren die. Without a terminal frame the run then waits briefly
 *    for 'close' so frames still in the pipe are not lost.
 *
 * Two promises, two questions. `result` answers the CALLER and settles
 * promptly (if the leader is not reaped within `reapWaitMs` after a kill, the
 * caller is answered anyway). `dead` answers the RESOURCE OWNER: it resolves
 * only once the leader has been reaped (and the group swept) and the call's
 * temporary directory is removed, or at once when nothing was ever spawned.
 * Whoever holds memory for the child (the pool lease) must release it on
 * `dead`, not on `result`, or a child that survives its SIGKILL would be paid
 * for by nobody.
 *
 * Disk (L6): every call gets a private directory under `tempDir`, handed to the
 * child as TMPDIR (the working directory is left alone: relative input and
 * script paths resolve against it). The directory is removed once the leader is
 * reaped and its group swept, on every outcome, and never before: a child that
 * is still running could keep writing into it. The caller is answered after
 * the removal when the leader was reaped, so a verdict never races its own
 * cleanup. A removal that fails is reported (`onTempCleanupError`,
 * `RunDiagnostics.tempCleanupError`) and never changes the verdict. A leader
 * that is never reaped leaves its directory behind, as it leaves its memory.
 *
 * stderr has two budgets, one per side, and the child's is the smaller:
 *  - The CHILD (every child entry calls `initChildProcess()`, child-io.ts)
 *    lets 256 KiB of JS-level stderr output through and silently drops the
 *    rest, and ignores EPIPE on process.stderr. A legitimate child therefore
 *    never gets near the parent's budget, never dies of a closed pipe, and
 *    its native last words (V8's "heap out of memory", node's uncaught
 *    exception report, written straight to fd 2) always reach the parent, so
 *    an OOM or a string-length RangeError is still classified as such.
 *  - The PARENT reads stderr into the 8 KiB ring until `stderrBudgetBytes`
 *    (default 1 MiB) have been seen, then destroys the pipe: reading a hostile
 *    child's endless 1-byte writes would saturate a CPU for as long as it cares
 *    to write. This is the backstop for children that do not limit themselves.
 *    The child is NOT killed for it (the deadline governs), but from then on
 *    its writes to stderr fail with EPIPE (Node ignores SIGPIPE; macOS answers
 *    the first write after the close with ENOTCONN). A child that handles
 *    that error carries on. One that does not (a child that skipped
 *    `initChildProcess()`: an unhandled 'error' event on process.stderr) dies
 *    with an uncaught exception and is classified as a crash, and a native
 *    fatal message written after the close is lost. That is deliberately NOT
 *    reclassified as "probably out of memory": a crash after the budget is
 *    equally what a bug looks like, and a guess would hide it. The fix is on
 *    the child side, hence the rule that the child entry calls
 *    `initChildProcess()` first.
 */

export const DEFAULT_READY_TIMEOUT_MS = 10_000;
export const DEFAULT_GRACE_MS = 250;
/** Bytes of child stderr read before the pipe is closed. */
export const DEFAULT_STDERR_BUDGET_BYTES = 1024 * 1024;
/** After 'exit' without a verdict: how long to wait for the pipes to drain. */
const DRAIN_MS = 500;
/** After a kill: how long to wait for the leader to be reaped before answering the caller anyway. */
const REAP_WAIT_MS = 2000;

type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface RunChildOptions {
  /** Node executable. Default process.execPath. */
  readonly nodePath?: string;
  /** Child entry script. */
  readonly scriptPath: string;
  readonly scriptArgs?: readonly string[];
  readonly execArgv?: readonly string[];
  /** Soft RLIMIT_CPU seconds (hard = soft + 2). */
  readonly cpuSecs: number;
  /** V8 old-space MB (L1). */
  readonly heapMb: number;
  /** Coarse RLIMIT_AS in KB (L4), Linux only. */
  readonly vmemKb?: number;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;

  readonly request: IsolatedParseRequest;
  /** Wall-clock budget for the whole run in ms (L2), measured from this call. */
  readonly deadlineMs: number;
  /** Default 10 s. */
  readonly readyTimeoutMs?: number;
  /** Time the child gets to exit after its terminal frame. Default 250 ms. */
  readonly graceMs?: number;
  /** RSS limit in MiB (L3). Omit to disable the poll. */
  readonly rssLimitMb?: number;
  /** RSS poll interval. Default 20 ms (Linux); macOS never polls faster than 250 ms. */
  readonly pollMs?: number;
  /** Most bytes accepted over fd 3 (frame JSON, newlines included). */
  readonly maxResultBytes: number;
  /** Longest single frame in bytes. Default 1 MiB. */
  readonly maxFrameBytes?: number;
  /** The child's own parse timer, sent in the input header (InputHeader.maxParseMillis). Omitted: the child's default. */
  readonly maxParseMillis?: number;
  /** Most frames accepted over fd 3. Default 1,000,000 (see DEFAULT_MAX_FRAMES). */
  readonly maxFrames?: number;
  /** Bytes of stderr read before its pipe is closed. Default 1 MiB. */
  readonly stderrBudgetBytes?: number;
  readonly signal?: AbortSignal;
  /**
   * Where the call's private directory is made (L6). Default os.tmpdir(). The child gets the directory as TMPDIR and
   * it is removed when the child is gone. The caller validates the path (absolute, existing); a directory that
   * cannot be created here is "unavailable".
   */
  readonly tempDir?: string;
  /** Budget for the call's directory in MiB of allocated bytes (L6). Omit to disable the poll. */
  readonly maxDiskMb?: number;
  /** Disk poll interval. Default 100 ms. */
  readonly diskPollMs?: number;
  /** Called with a description when the call's directory could not be removed. The run's outcome is unaffected. */
  readonly onTempCleanupError?: (message: string) => void;
  /** Called once, just before the run settles, with what was observed. Never throws into the run. */
  readonly onSettled?: (diagnostics: RunDiagnostics) => void;
  /** @internal Test seam for spawn failures. */
  readonly spawnFn?: SpawnFn;
  /** @internal How long to wait for the leader to be reaped after a kill before answering the caller. Default 2000. */
  readonly reapWaitMs?: number;
  /** @internal Replaces the RSS measurement (test seam). */
  readonly rssSampler?: RssPollerOptions["sample"];
  /** @internal Replaces the disk measurement (test seam). */
  readonly diskSampler?: DiskPollerOptions["sample"];
}

/** What `startChild` returns; see the two-promise note at the top of this file. */
export interface ChildRun {
  /** The verdict, for the caller. */
  readonly result: Promise<IsolatedParseResult>;
  /** The leader was reaped and its group swept, or nothing was spawned. Never rejects. */
  readonly dead: Promise<void>;
}

export interface RunDiagnostics {
  readonly pid: number | undefined;
  readonly spawnError: { readonly code: string | undefined; readonly syscall: string | undefined } | null;
  readonly phase: "pre-ready" | "post-ready";
  readonly terminal: "done" | "error" | null;
  readonly killReason: KillReason | null;
  /** The ready deadline fired (the group was killed without a kill reason). */
  readonly readyTimedOut: boolean;
  /** The group was killed after the terminal frame because the child did not exit within the grace. */
  readonly graceKilled: boolean;
  readonly code: number | null;
  readonly signal: string | null;
  /** The group leader's exit was observed before the run settled. */
  readonly reaped: boolean;
  readonly readyMs: number | null;
  readonly terminalMs: number | null;
  readonly exitMs: number | null;
  readonly settledMs: number;
  readonly fd3Bytes: number;
  readonly frameCount: number;
  readonly stderrTail: string;
  /** Bytes of stderr read (it stops at the budget). */
  readonly stderrBytes: number;
  /** The stderr pipe was closed because the child used up its budget. */
  readonly stderrClosed: boolean;
  readonly stdinError: string | null;
  readonly rss: RssStats | null;
  readonly disk: DiskStats | null;
  /** The call's private directory (removed when the child is gone), or null when none was made. */
  readonly callDir: string | null;
  /** Why the directory could not be removed, or null (removed, or the leader had not been reaped yet). */
  readonly tempCleanupError: string | null;
  /** "signal:SIGKILL" | "code:0" | "spawn:ENOENT" | "unreaped" */
  readonly outcome: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkFinite(name: string, value: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new RangeError(`${name} must be a finite number >= ${min}, got ${String(value)}`);
  }
  return value;
}

/** A failure decided before anything was spawned (already aborted, zero budget). */
function earlyFailure(killReason: "abort" | "timeout", abortReason?: unknown): Error {
  const facts: ExitFacts = {
    phase: "pre-ready",
    terminal: null,
    killReason,
    code: null,
    signal: null,
    stderrTail: "",
    ...(killReason === "abort" ? { abortReason } : {}),
  };
  const error = classifyExit(facts);
  if (error === null) throw new Error("unreachable: a kill reason always classifies to an error");
  return error;
}

/** Starts one supervised child. Never throws: every failure is a rejection of `result`. */
export function startChild(options: RunChildOptions): ChildRun {
  let markDead!: () => void;
  const dead = new Promise<void>((resolve) => {
    markDead = resolve;
  });
  const result = new Promise<IsolatedParseResult>((resolve, reject) => {
    try {
      const deadlineMs = checkFinite("deadlineMs", options.deadlineMs, 0);
      if (options.signal?.aborted === true) throw earlyFailure("abort", options.signal.reason);
      if (deadlineMs === 0) throw earlyFailure("timeout");
      new Supervision(options, deadlineMs, resolve, reject, markDead).start();
    } catch (error) {
      markDead(); // nothing was spawned
      reject(error);
    }
  });
  return { result, dead };
}

export function runChild(options: RunChildOptions): Promise<IsolatedParseResult> {
  return startChild(options).result;
}

class Supervision {
  readonly #options: RunChildOptions;
  readonly #platform: NodeJS.Platform;
  readonly #deadlineMs: number;
  readonly #graceMs: number;
  readonly #readyTimeoutMs: number;
  readonly #resolve: (result: IsolatedParseResult) => void;
  readonly #reject: (error: Error) => void;
  readonly #markDead: () => void;
  readonly #reapWaitMs: number;
  readonly #stderrBudget: number;
  readonly #output: "text" | "records";
  readonly #reader: FrameReader;
  readonly #ring = new StderrRing(8 * 1024);

  #child: ChildProcess | null = null;
  #prefix: Buffer | null = null;
  #t0 = 0;
  #poller: RssPoller | null = null;
  #diskPoller: DiskPoller | null = null;
  #callDir: string | null = null;
  #removal: Promise<void> | null = null;
  #removed = false;
  #tempCleanupError: string | null = null;
  #deadlineTimer: NodeJS.Timeout | undefined;
  #readyTimer: NodeJS.Timeout | undefined;
  #graceTimer: NodeJS.Timeout | undefined;
  #reapTimer: NodeJS.Timeout | undefined;
  #drainTimer: NodeJS.Timeout | undefined;

  #settled = false;
  #exited = false;
  #stopping = false;
  #terminalSeen = false;
  #killReason: KillReason | null = null;
  #abortReason: unknown;
  #protocolDetail: string | undefined;
  #readyTimedOut = false;
  #graceKilled = false;
  #code: number | null = null;
  #signal: string | null = null;
  #spawnError: RunDiagnostics["spawnError"] = null;
  #stdinError: string | null = null;
  #fd3Bytes = 0;
  #stderrBytes = 0;
  // Markers seen in ANY stderr chunk (see ExitFacts.stderrMarkers); the carry is the end of the previous chunk.
  #stderrMarkers = { memory: false, stringLength: false };
  #stderrCarry = "";
  #stderrClosed = false;
  #readyMs: number | null = null;
  #terminalMs: number | null = null;
  #exitMs: number | null = null;

  constructor(
    options: RunChildOptions,
    deadlineMs: number,
    resolve: (result: IsolatedParseResult) => void,
    reject: (error: Error) => void,
    markDead: () => void,
  ) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
    this.#deadlineMs = deadlineMs;
    this.#graceMs = checkFinite("graceMs", options.graceMs ?? DEFAULT_GRACE_MS, 0);
    this.#readyTimeoutMs = checkFinite("readyTimeoutMs", options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 1);
    if (options.rssLimitMb !== undefined) checkFinite("rssLimitMb", options.rssLimitMb, 1);
    checkFinite("pollMs", options.pollMs ?? DEFAULT_POLL_MS, 1);
    if (options.maxDiskMb !== undefined) checkFinite("maxDiskMb", options.maxDiskMb, 1);
    checkFinite("diskPollMs", options.diskPollMs ?? DEFAULT_DISK_POLL_MS, 1);
    this.#reapWaitMs = checkFinite("reapWaitMs", options.reapWaitMs ?? REAP_WAIT_MS, 0);
    this.#stderrBudget = checkFinite("stderrBudgetBytes", options.stderrBudgetBytes ?? DEFAULT_STDERR_BUDGET_BYTES, 1);
    this.#resolve = resolve;
    this.#reject = reject;
    this.#markDead = markDead;
    this.#output = options.request.output ?? "text";
    this.#reader = new FrameReader({
      maxTotalBytes: options.maxResultBytes,
      output: this.#output,
      ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
      ...(options.maxFrames === undefined ? {} : { maxFrames: options.maxFrames }),
    });
  }

  start(): void {
    const options = this.#options;
    let callDir: string;
    try {
      callDir = createCallDir(options.tempDir ?? tmpdir());
    } catch (error) {
      this.#markDead(); // nothing was spawned
      this.#reject(
        new IsolationError("unavailable", `Could not create the isolated parser's temporary directory: ${errorText(error)}`, {
          cause: error,
        }),
      );
      return;
    }
    this.#callDir = callDir;
    let wrapperArgs: ReturnType<typeof buildWrapperCommand>;
    try {
      wrapperArgs = buildWrapperCommand({
        nodePath: options.nodePath ?? process.execPath,
        scriptPath: options.scriptPath,
        ...(options.scriptArgs === undefined ? {} : { scriptArgs: options.scriptArgs }),
        ...(options.execArgv === undefined ? {} : { execArgv: options.execArgv }),
        cpuSecs: options.cpuSecs,
        heapMb: options.heapMb,
        ...(options.vmemKb === undefined ? {} : { vmemKb: options.vmemKb }),
        ...(options.parentEnv === undefined ? {} : { parentEnv: options.parentEnv }),
        platform: this.#platform,
        tmpDir: callDir,
      });
      this.#prefix = encodeInputPrefix(this.#header());
    } catch (error) {
      this.#failBeforeSpawn(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    this.#t0 = performance.now();
    let child: ChildProcess;
    try {
      child = (options.spawnFn ?? spawn)(wrapperArgs.file, wrapperArgs.args, {
        detached: true,
        stdio: ["pipe", "ignore", "pipe", "pipe"],
        env: wrapperArgs.env,
      });
    } catch (error) {
      this.#failBeforeSpawn(
        new IsolationError("unavailable", `Could not start the isolated parser: ${String(error)}`, { cause: error }),
      );
      return;
    }
    this.#child = child;

    // Listeners first: every stream error is expected noise (EPIPE, resets) once a child dies.
    child.on("error", (error: NodeJS.ErrnoException) => this.#onChildError(error));
    child.once("exit", (code, signal) => this.#onExit(code, signal));
    child.once("close", () => this.#onClose());
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      this.#stdinError = error.code ?? error.message;
    });
    const stderr = child.stderr as Readable | null;
    stderr?.on("error", () => {});
    stderr?.on("data", (chunk: Uint8Array) => this.#onStderr(chunk));
    const fd3 = this.#fd3();
    fd3?.on("error", () => {});
    fd3?.on("data", (chunk: Uint8Array) => this.#onFrameBytes(chunk));

    this.#deadlineTimer = setTimeout(() => this.#kill("timeout"), clampTimerMs(this.#deadlineMs));
    if (this.#readyTimeoutMs < this.#deadlineMs) {
      this.#readyTimer = setTimeout(() => this.#onReadyTimeout(), clampTimerMs(this.#readyTimeoutMs));
    }
    options.signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  #header(): InputHeader {
    const { request } = this.#options;
    const inline = request.input instanceof Uint8Array;
    if (!inline && (typeof request.input.path !== "string" || request.input.path.length === 0)) {
      throw new TypeError("request.input.path must be a non-empty string");
    }
    return {
      v: 1,
      output: this.#output,
      byteLength: inline ? request.input.length : 0,
      ...(inline ? {} : { path: (request.input as { path: string }).path }),
      ...(request.filename === undefined ? {} : { filename: request.filename }),
      ...(request.maxOutputChars === undefined ? {} : { maxOutputChars: request.maxOutputChars }),
      ...(request.maxEmbeddedResources === undefined ? {} : { maxEmbeddedResources: request.maxEmbeddedResources }),
      ...(this.#options.maxParseMillis === undefined ? {} : { maxParseMillis: this.#options.maxParseMillis }),
    };
  }

  #fd3(): Readable | null {
    return (this.#child?.stdio[3] as Readable | null | undefined) ?? null;
  }

  #now(): number {
    return Math.round(performance.now() - this.#t0);
  }

  // ---- inputs: frames, timers, signals --------------------------------------

  readonly #onAbort = (): void => {
    this.#abortReason = this.#options.signal?.reason;
    this.#kill("abort");
  };

  /** Feeds the ring; once the budget is spent the pipe is closed (see the note at the top of this file). */
  #onStderr(chunk: Uint8Array): void {
    this.#stderrBytes += chunk.length;
    this.#ring.push(chunk);
    // latin1 keeps every byte one character, so the ASCII markers survive and the carry stays a fixed byte count.
    const text = this.#stderrCarry + Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length).toString("latin1");
    const seen = scanStderrMarkers(text);
    this.#stderrMarkers = {
      memory: this.#stderrMarkers.memory || seen.memory,
      stringLength: this.#stderrMarkers.stringLength || seen.stringLength,
    };
    this.#stderrCarry = text.slice(-MARKER_CARRY_CHARS);
    if (this.#stderrBytes >= this.#stderrBudget && !this.#stderrClosed) {
      this.#stderrClosed = true;
      (this.#child?.stderr as Readable | null | undefined)?.destroy();
    }
  }

  #onFrameBytes(chunk: Uint8Array): void {
    if (this.#settled || this.#terminalSeen || this.#stopping) return;
    this.#fd3Bytes += chunk.length;
    const events: FrameEvent[] = this.#reader.push(chunk);
    for (const event of events) {
      if (event.type === "violation") {
        this.#protocolDetail = event.message;
        this.#kill(KILL_REASON_BY_VIOLATION[event.kind]);
        return;
      }
      if (event.frame.t === "ready") this.#onReady();
      else if (event.frame.t === "done" || event.frame.t === "error") {
        this.#onTerminal();
        return; // anything after the terminal frame is ignored
      }
    }
  }

  #onReady(): void {
    this.#readyMs = this.#now();
    if (this.#readyTimer !== undefined) clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
    this.#startPoller();
    this.#startDiskPoller();
    this.#writeInput();
  }

  #startPoller(): void {
    const { rssLimitMb, pollMs } = this.#options;
    const child = this.#child;
    if (rssLimitMb === undefined || child?.pid === undefined || rssPollKind(this.#platform) === "none") return;
    this.#poller = new RssPoller({
      pid: child.pid,
      platform: this.#platform,
      limitMb: rssLimitMb,
      pollMs: pollMs ?? DEFAULT_POLL_MS,
      onOverLimit: () => this.#kill("rss"),
      ...(this.#options.rssSampler === undefined ? {} : { sample: this.#options.rssSampler }),
    });
    this.#poller.start();
  }

  /** Disk writes start with the input, so the budget is watched from "ready" on, like the RSS limit. */
  #startDiskPoller(): void {
    const { maxDiskMb, diskPollMs, diskSampler } = this.#options;
    const dir = this.#callDir;
    if (maxDiskMb === undefined || dir === null) return;
    this.#diskPoller = new DiskPoller({
      dir,
      limitMb: maxDiskMb,
      pollMs: diskPollMs ?? DEFAULT_DISK_POLL_MS,
      onOverLimit: () => this.#kill("disk"),
      ...(diskSampler === undefined ? {} : { sample: diskSampler }),
    });
    this.#diskPoller.start();
  }

  #stopPollers(): void {
    this.#poller?.stop();
    this.#diskPoller?.stop();
  }

  /** The child sent "ready" BEFORE reading, so the input waits in the pipe until it does. */
  #writeInput(): void {
    const stdin = this.#child?.stdin;
    const prefix = this.#prefix;
    if (stdin === null || stdin === undefined || prefix === null || stdin.destroyed || stdin.writableEnded) return;
    const { input } = this.#options.request;
    // Errors (EPIPE, ERR_STREAM_DESTROYED) arrive on the 'error' listener; the child's exit decides the outcome.
    stdin.write(prefix);
    if (input instanceof Uint8Array && input.length > 0) stdin.write(input);
    stdin.end();
  }

  #onTerminal(): void {
    this.#terminalSeen = true;
    this.#terminalMs = this.#now();
    this.#fd3()?.destroy();
    if (this.#exited) {
      this.#settle();
      return;
    }
    this.#graceTimer = setTimeout(() => {
      this.#graceKilled = true;
      this.#groupKill();
      this.#armReapTimer();
    }, this.#graceMs);
  }

  #onReadyTimeout(): void {
    this.#readyTimedOut = true;
    this.#kill(null);
  }

  // ---- killing --------------------------------------------------------------

  /**
   * Records why FIRST, then kills the group. `null` kills without a recorded reason (ready timeout).
   *
   * The reason is recorded even when the leader has already exited: its 'exit' can overtake bytes still in the
   * pipe, and a cap or protocol violation found while draining them must classify exactly as it would have had
   * the bytes arrived first. The first recorded cause wins, so a run we are already killing keeps its reason.
   */
  #kill(reason: KillReason | null): void {
    if (this.#settled || this.#stopping) return;
    if (reason !== null && this.#killReason === null) this.#killReason = reason;
    if (this.#exited) {
      // Nothing left to kill, and the verdict is now known: do not wait out the drain window.
      if (reason !== null) this.#settle();
      return;
    }
    this.#stopping = true;
    this.#clearTimers();
    this.#stopPollers();
    this.#groupKill();
    this.#armReapTimer();
  }

  /** SIGKILL to the process group. ESRCH (group already gone) is expected and ignored. */
  #groupKill(): void {
    const pid = this.#child?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ESRCH: nothing left to kill. EPERM cannot happen for our own children.
    }
  }

  #armReapTimer(): void {
    if (this.#reapTimer !== undefined || this.#exited) return;
    this.#reapTimer = setTimeout(() => this.#settle(), clampTimerMs(this.#reapWaitMs));
  }

  // ---- child events ---------------------------------------------------------

  #onChildError(error: NodeJS.ErrnoException): void {
    if (this.#child?.pid !== undefined) return; // not a spawn failure; the exit event decides
    this.#spawnError = { code: error.code, syscall: error.syscall };
    this.#clearTimers();
    // Nothing was spawned, so nothing can write to the directory: it goes before the caller is answered.
    void this.#removeCallDir().then(() => {
      this.#markDead();
      this.#settle(
        new IsolationError("unavailable", `Could not start the isolated parser (${error.code ?? error.message})`, {
          cause: error,
        }),
      );
    });
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#exited = true;
    this.#code = code;
    this.#signal = signal;
    this.#exitMs = this.#now();
    this.#stopPollers();
    // The leader is reaped, so no timer can still change the verdict.
    this.#clearTimers();
    // Sweep lingering grandchildren. The leader is reaped, but the group id stays reserved while any member lives, so the
    // negative-pid kill cannot hit an unrelated group; with no member left it is ESRCH (pid reuse in that window is negligible).
    this.#groupKill();
    // Nothing can write to the call directory any more: remove it, THEN report the child dead and answer the caller.
    // Dead BEFORE settling, so a lease released on `dead` is already free when the caller's promise continues.
    // This also runs for a leader reaped after the caller was answered (the reap wait ran out first).
    void this.#removeCallDir().then(() => {
      this.#markDead();
      this.#afterExit();
    });
  }

  #afterExit(): void {
    if (this.#settled) return;
    if (this.#terminalSeen || this.#stopping) {
      this.#settle();
      return;
    }
    // No verdict yet: frames may still be in the pipe. The sweep in #onExit closes any fds a grandchild held.
    this.#drainTimer = setTimeout(() => this.#settle(), DRAIN_MS);
  }

  #onClose(): void {
    if (this.#exited) this.#settle();
  }

  // ---- the call directory ---------------------------------------------------

  /** Removes the call directory, once. A failure is reported and recorded; it never rejects and never changes the verdict. */
  #removeCallDir(): Promise<void> {
    if (this.#removal !== null) return this.#removal;
    const dir = this.#callDir;
    const removal = dir === null ? Promise.resolve() : removeCallDir(dir);
    this.#removal = removal
      .catch((error: unknown) => {
        const message = `Could not remove the isolated parser's temporary directory ${String(dir)}: ${errorText(error)}`;
        this.#tempCleanupError = message;
        try {
          this.#options.onTempCleanupError?.(message);
        } catch {
          // reporting is best effort
        }
      })
      .then(() => {
        this.#removed = true;
      });
    return this.#removal;
  }

  /** A failure before anything was spawned: the directory goes first, then the caller is answered. */
  #failBeforeSpawn(error: Error): void {
    void this.#removeCallDir().then(() => {
      this.#markDead(); // nothing was spawned
      this.#reject(error);
    });
  }

  // ---- settling -------------------------------------------------------------

  #clearTimers(): void {
    for (const timer of [this.#deadlineTimer, this.#readyTimer, this.#graceTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.#deadlineTimer = undefined;
    this.#readyTimer = undefined;
    this.#graceTimer = undefined;
  }

  #facts(): ExitFacts {
    const errorFrame = this.#reader.errorFrame;
    return {
      phase: this.#reader.phase,
      terminal: this.#reader.terminal,
      ...(errorFrame === null ? {} : { errorFrame }),
      killReason: this.#killReason,
      code: this.#code,
      signal: this.#signal,
      stderrTail: this.#ring.text(),
      stderrMarkers: this.#stderrMarkers,
      ...(this.#killReason === "abort" ? { abortReason: this.#abortReason } : {}),
      ...(this.#protocolDetail === undefined ? {} : { protocolDetail: this.#protocolDetail }),
      ...(this.#killReason === "disk" && this.#options.maxDiskMb !== undefined
        ? { disk: { limitMb: this.#options.maxDiskMb, boundHit: this.#diskPoller?.stats().boundHit ?? false, unreadable: this.#diskPoller?.stats().unreadable ?? false } }
        : {}),
    };
  }

  #diagnostics(facts: ExitFacts): RunDiagnostics {
    const outcome = this.#spawnError !== null
      ? `spawn:${this.#spawnError.code ?? "?"}`
      : !this.#exited
        ? "unreaped"
        : this.#signal !== null
          ? `signal:${this.#signal}`
          : `code:${String(this.#code)}`;
    return {
      pid: this.#child?.pid,
      spawnError: this.#spawnError,
      phase: facts.phase,
      terminal: facts.terminal,
      killReason: this.#killReason,
      readyTimedOut: this.#readyTimedOut,
      graceKilled: this.#graceKilled,
      code: this.#code,
      signal: this.#signal,
      reaped: this.#exited,
      readyMs: this.#readyMs,
      terminalMs: this.#terminalMs,
      exitMs: this.#exitMs,
      settledMs: this.#now(),
      fd3Bytes: this.#fd3Bytes,
      frameCount: this.#reader.frameCount,
      stderrTail: facts.stderrTail,
      stderrBytes: this.#stderrBytes,
      stderrClosed: this.#stderrClosed,
      stdinError: this.#stdinError,
      rss: this.#poller?.stats() ?? null,
      disk: this.#diskPoller?.stats() ?? null,
      callDir: this.#callDir,
      tempCleanupError: this.#tempCleanupError,
      outcome,
    };
  }

  /** Settles exactly once. `forced` is an error decided outside the classifier (spawn failure). */
  #settle(forced?: Error): void {
    if (this.#settled) return;
    if (this.#removal !== null && !this.#removed) {
      // The leader is reaped and its directory is being removed: the caller is answered once it is gone.
      void this.#removal.then(() => this.#settle(forced));
      return;
    }
    this.#settled = true;

    const facts = this.#facts();
    const diagnostics = this.#diagnostics(facts);
    let result: IsolatedParseResult | null = null;
    let error: Error | null = forced ?? null;
    if (error === null) {
      try {
        error = classifyExit(facts);
        if (error === null) result = this.#reader.result();
      } catch (thrown) {
        error = thrown instanceof Error ? thrown : new Error(String(thrown));
      }
    }

    this.#cleanup();
    try {
      this.#options.onSettled?.(diagnostics);
    } catch {
      // diagnostics are best effort
    }
    if (result !== null) this.#resolve(result);
    else this.#reject(error ?? new Error("unreachable: no result and no error"));
  }

  #cleanup(): void {
    this.#clearTimers();
    for (const timer of [this.#reapTimer, this.#drainTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.#reapTimer = undefined;
    this.#drainTimer = undefined;
    this.#stopPollers();
    this.#options.signal?.removeEventListener("abort", this.#onAbort);
    const child = this.#child;
    if (child === null) return;
    child.stdin?.destroy();
    (child.stderr as Readable | null)?.destroy();
    this.#fd3()?.destroy();
    // A leader that was never reaped (kill failed) must not keep this process alive.
    if (!this.#exited) child.unref();
    if (!this.#exited) this.#groupKill();
  }
}
