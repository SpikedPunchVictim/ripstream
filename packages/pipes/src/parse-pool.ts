import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker, type ResourceLimits } from "node:worker_threads";
import {
  IsolationError,
  LimitExceededError,
  ParseContext,
  ParseTimeoutError,
  type InputSource,
  type ParseOptions,
  type ParseRecord,
  type ParseResult,
} from "@spikedpunch/ripstream-core";
import {
  assertWireInput,
  decodeError,
  decodeParseResult,
  decodeRecords,
  effectiveParseMillis,
  wireInput,
  wireOptions,
  type TaskMessage,
  type WireParseOptions,
  type WorkerData,
  type WorkerMessage,
  type WorkerRipstreamSpec,
} from "./parse-worker-codec.ts";
import { PipesFatalError } from "./result.ts";

/*
 * A fixed number of worker threads, each running parse-worker-main.ts, and a FIFO queue of parses in front of them.
 * Each worker parses one document at a time. A worker that crashes, runs out of memory, or does not stop when its parse
 * should have (the watchdog, or an abort it does not act on) is terminated and replaced; when a replacement cannot be
 * started, the pool fails and every parse after that rejects with a PipesFatalError, which ends a pipes run.
 *
 * Each worker gets a temporary directory of its own as TMPDIR, removed when the worker exits: `terminate()` does not
 * run `finally` blocks, so whatever a parse left there (a spooled input, an OCR scratch directory) goes with it.
 */

/** How long past its maxParseMillis a parse runs before its worker is terminated, and how long an abort is waited on. */
const GRACE_MS = 5_000;
/** The largest setTimeout delay; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How long close() waits for the workers to exit. */
const CLOSE_MS = 5_000;
/** Attempts to start a worker before the pool fails; the waits between them grow from SPAWN_BACKOFF_MS fourfold. */
const SPAWN_ATTEMPTS = 4;
const SPAWN_BACKOFF_MS = 100;

/** Node's default `--stack-size`, in KiB. */
const DEFAULT_STACK_KIB = 984;
/**
 * A worker's stackSizeMb that gives about as deep a recursion as `--stack-size` gives the main thread (Node's default
 * for a worker, 4 MB, recurses four times as deep: a document that overflows the stack in-process would parse in a
 * worker). Measured: 1.17 MB recurses 10,293 frames where the main thread's 984 KiB recurses 10,357.
 */
export function workerStackSizeMb(execArgv: readonly string[]): number {
  let kib = DEFAULT_STACK_KIB;
  for (const [index, arg] of execArgv.entries()) {
    const value = arg.startsWith("--stack-size=") ? arg.slice("--stack-size=".length) : arg === "--stack-size" ? execArgv[index + 1] : undefined;
    const parsed = Number(value);
    if (value !== undefined && Number.isFinite(parsed) && parsed > 0) kib = parsed;
  }
  return (1.17 * kib) / DEFAULT_STACK_KIB;
}

/**
 * The parent's execArgv a worker keeps: only flags that change how modules resolve and load or how warnings print.
 * Everything else is dropped, preloads (`--import`, `--require`, loaders) included: a worker runs the parse entry and
 * nothing else, and a preload written for the main thread can do there what it should not (exit, re-execute, listen).
 * Heap and other V8 flags are refused by Worker, and the stack size is set through resourceLimits.
 */
const KEPT_FLAGS = new Set([
  "--conditions",
  "-C",
  "--disable-warning",
  "--enable-source-maps",
  "--no-deprecation",
  "--no-warnings",
  "--pending-deprecation",
  "--throw-deprecation",
  "--trace-deprecation",
  "--trace-uncaught",
  "--trace-warnings",
  "--experimental-strip-types",
  "--no-experimental-strip-types",
  "--experimental-transform-types",
  "--experimental-require-module",
  "--no-experimental-require-module",
]);
/** Kept flags that take a value, which may be the next argument. */
const KEPT_VALUE_FLAGS = new Set(["--conditions", "-C", "--disable-warning"]);

export function workerExecArgv(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index]!;
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (!KEPT_FLAGS.has(flag)) continue;
    kept.push(arg);
    if (equals === -1 && KEPT_VALUE_FLAGS.has(flag) && index + 1 < execArgv.length) {
      index += 1;
      kept.push(execArgv[index]!);
    }
  }
  return kept;
}

export interface WorkerParsePoolOptions {
  readonly spec: WorkerRipstreamSpec;
  readonly size: number;
  /** The worker module: parse-worker.ts, or a test's. */
  readonly entry: URL;
  /** Where the pool's temporary directory goes (default `os.tmpdir()`). */
  readonly tempRoot?: string;
  /** For tests: GRACE_MS and SPAWN_BACKOFF_MS. */
  readonly graceMs?: number;
  readonly spawnBackoffMs?: number;
}

type DoneMessage = Extract<WorkerMessage, { t: "done" }>;
type Reply = DoneMessage | Extract<WorkerMessage, { t: "failed" }>;

/** A worker that started and failed to build its ripstream: the configuration is wrong, and trying again will not help. */
class WorkerInitError extends Error {
  readonly error: unknown;

  constructor(error: unknown) {
    super("a parse worker could not build its ripstream", { cause: error });
    this.error = error;
  }
}

interface ThreadOptions {
  readonly entry: URL;
  readonly spec: WorkerRipstreamSpec;
  readonly root: string;
  readonly execArgv: readonly string[];
  readonly stackSizeMb: number;
}

/** One worker thread, from its start until it has exited and its temporary directory is gone. */
class Thread {
  static async start(options: ThreadOptions): Promise<Thread> {
    const directory = await mkdtemp(join(options.root, "worker-"));
    let thread: Thread;
    try {
      thread = new Thread(options, directory);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    try {
      await thread.#ready;
    } catch (error) {
      await thread.stop();
      throw error;
    }
    return thread;
  }

  readonly worker: Worker;
  /** Settles once the thread has exited and its temporary directory is removed. */
  readonly gone: Promise<void>;
  /** Taken when the thread is ready: after it exits, Worker reports none. */
  limits: ResourceLimits = {};
  readonly #ready: Promise<void>;
  #pending: { readonly id: number; readonly resolve: (reply: Reply) => void; readonly reject: (death: unknown) => void } | null = null;
  #death: unknown = undefined;
  #exited = false;

  private constructor(options: ThreadOptions, directory: string) {
    this.worker = new Worker(options.entry, {
      workerData: { spec: options.spec } satisfies WorkerData,
      env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
      execArgv: [...options.execArgv],
      resourceLimits: { stackSizeMb: options.stackSizeMb },
    });
    let ready!: () => void;
    let failed!: (error: unknown) => void;
    this.#ready = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    // Nothing awaits it once the thread is ready; a later rejection must not be reported as unhandled.
    this.#ready.catch(() => undefined);
    this.worker.on("message", (message: WorkerMessage) => {
      if (message?.t === "ready") {
        this.limits = { ...this.worker.resourceLimits };
        ready();
      } else if (message?.t === "init-error") {
        failed(new WorkerInitError(decodeError(message.error)));
        this.worker.terminate().catch(() => undefined);
      } else {
        this.#reply(message);
      }
    });
    this.worker.on("error", (error) => {
      this.#death ??= error;
    });
    this.gone = new Promise<void>((resolve) => {
      this.worker.once("exit", (code) => {
        this.#exited = true;
        const death = this.#death ?? new Error(`the parse worker exited with code ${code}`);
        failed(death);
        this.#pending?.reject(death);
        this.#pending = null;
        void rm(directory, { recursive: true, force: true })
          .catch(() => undefined)
          .then(resolve);
      });
    });
  }

  /** Running nothing and not exited: a message posted to an exited worker goes nowhere. */
  get idle(): boolean {
    return this.#pending === null && !this.#exited;
  }

  /**
   * Posts a task; the reply settles it, and the thread's exit rejects it with what ended the thread. It throws, posting
   * nothing, when the task cannot be copied to the worker.
   */
  run(task: TaskMessage, transfer: ArrayBuffer[]): Promise<Reply> {
    this.worker.postMessage(task, transfer);
    this.worker.ref();
    return new Promise<Reply>((resolve, reject) => {
      this.#pending = { id: task.id, resolve, reject };
    });
  }

  abort(id: number): void {
    if (this.#pending?.id === id) this.worker.postMessage({ t: "abort", id });
  }

  stop(): Promise<void> {
    this.worker.unref();
    this.worker.terminate().catch(() => undefined);
    return this.gone;
  }

  #reply(message: WorkerMessage): void {
    const pending = this.#pending;
    if (pending !== null && (message?.t === "done" || message?.t === "failed") && message.id === pending.id) {
      this.#pending = null;
      this.worker.unref();
      pending.resolve(message);
      return;
    }
    // A message out of turn: the worker is not following the protocol, and is not trusted with another document.
    this.#death ??= new IsolationError("crash", `the parse worker sent an unexpected message (${describe(message)})`);
    this.worker.terminate().catch(() => undefined);
  }
}

class Task {
  settled = false;
  /** Set while a worker runs it: tells the worker to stop, and terminates it if it does not. */
  stopRunning: (() => void) | null = null;
  readonly #resolve: (value: unknown) => void;
  readonly #reject: (error: unknown) => void;
  readonly #cleanups: (() => void)[] = [];

  readonly id: number;
  readonly op: TaskMessage["op"];
  readonly source: InputSource;
  readonly options: WireParseOptions;
  /** The maxParseMillis it runs under. */
  readonly millis: number;
  readonly decode: (reply: DoneMessage) => unknown;

  constructor(
    fields: Pick<Task, "id" | "op" | "source" | "options" | "millis" | "decode">,
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void,
  ) {
    this.id = fields.id;
    this.op = fields.op;
    this.source = fields.source;
    this.options = fields.options;
    this.millis = fields.millis;
    this.decode = fields.decode;
    this.#resolve = resolve;
    this.#reject = reject;
  }

  onSettle(cleanup: () => void): void {
    this.#cleanups.push(cleanup);
  }

  succeed(value: unknown): void {
    if (this.#settle()) this.#resolve(value);
  }

  fail(error: unknown): void {
    if (this.#settle()) this.#reject(error);
  }

  #settle(): boolean {
    if (this.settled) return false;
    this.settled = true;
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
    return true;
  }
}

interface Slot {
  /** The slot's worker while it can take a task; null while one is being started or replaced. */
  thread: Thread | null;
}

export class WorkerParsePool {
  /**
   * Starts every worker and waits until each is ready. A worker that cannot build its ripstream rejects with why (a
   * RipstreamConfigError, say); one that cannot start is tried again a few times first.
   */
  static async start(options: WorkerParsePoolOptions): Promise<WorkerParsePool> {
    const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), "ripstream-workers-"));
    const pool = new WorkerParsePool(options, root);
    // Settled, not raced: a worker still starting when another fails would otherwise be left running.
    const started = await Promise.allSettled(pool.#slots.map(() => pool.#startThread()));
    const failed = started.find((each) => each.status === "rejected");
    if (failed !== undefined) {
      await Promise.all(started.map((each) => (each.status === "fulfilled" ? each.value.stop() : undefined)));
      await pool.close();
      const error: unknown = failed.reason;
      throw error instanceof WorkerInitError ? error.error : new PipesFatalError(`the parse pool could not start a worker: ${describe(error)}`, { cause: error });
    }
    started.forEach((each, index) => pool.#attach(pool.#slots[index]!, (each as PromiseFulfilledResult<Thread>).value));
    return pool;
  }

  readonly size: number;
  readonly #spec: WorkerRipstreamSpec;
  readonly #graceMs: number;
  readonly #spawnBackoffMs: number;
  readonly #thread: ThreadOptions;
  readonly #root: string;
  readonly #slots: Slot[];
  readonly #queue: Task[] = [];
  readonly #running = new Set<Task>();
  readonly #starting = new Set<Promise<unknown>>();
  #nextId = 1;
  #failure: PipesFatalError | null = null;
  #closing: Promise<void> | null = null;

  private constructor(options: WorkerParsePoolOptions, root: string) {
    this.size = options.size;
    this.#spec = options.spec;
    this.#graceMs = options.graceMs ?? GRACE_MS;
    this.#spawnBackoffMs = options.spawnBackoffMs ?? SPAWN_BACKOFF_MS;
    this.#root = root;
    this.#thread = {
      entry: options.entry,
      spec: options.spec,
      root,
      execArgv: workerExecArgv(process.execArgv),
      stackSizeMb: workerStackSizeMb(process.execArgv),
    };
    this.#slots = Array.from({ length: options.size }, () => ({ thread: null }));
  }

  /** The resource limits each ready worker runs under. */
  get limits(): readonly ResourceLimits[] {
    return this.#slots.flatMap((slot) => (slot.thread === null ? [] : [slot.thread.limits]));
  }

  parse(source: InputSource, options: ParseOptions = {}): Promise<ParseResult> {
    return this.#submit("parse", source, options, (reply) => {
      if (reply.op !== "parse") throw new TypeError("a parseRecursive reply to a parse");
      return decodeParseResult(reply.result);
    }) as Promise<ParseResult>;
  }

  parseRecursive(source: InputSource, options: ParseOptions = {}): Promise<readonly ParseRecord[]> {
    return this.#submit("parseRecursive", source, options, (reply) => {
      if (reply.op !== "parseRecursive") throw new TypeError("a parse reply to a parseRecursive");
      return decodeRecords(reply.records);
    }) as Promise<readonly ParseRecord[]>;
  }

  /**
   * Rejects what is queued and running, terminates the workers, and removes the pool's temporary directory. It waits
   * CLOSE_MS at most for the workers to exit; one that has not by then is left to exit on its own (it holds nothing
   * open that keeps the process alive). Calling it again returns the same promise.
   */
  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    const closed = new Error("the parse pool is closed");
    for (const task of this.#queue.splice(0)) task.fail(closed);
    for (const task of this.#running) task.fail(closed);
    const stopping: Promise<unknown>[] = [...this.#starting];
    for (const slot of this.#slots) {
      if (slot.thread !== null) stopping.push(slot.thread.stop());
      slot.thread = null;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(stopping),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_MS).unref();
      }),
    ]);
    clearTimeout(timer);
    await rm(this.#root, { recursive: true, force: true }).catch(() => undefined);
  }

  #submit(op: TaskMessage["op"], source: InputSource, options: ParseOptions, decode: (reply: DoneMessage) => unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.#closing !== null) throw new Error("the parse pool is closed");
      if (this.#failure !== null) throw this.#failure;
      assertWireInput(source);
      const wire = wireOptions(options);
      const signal = options.signal;
      if (signal?.aborted === true) throw abortErrorFor(signal);
      const millis = effectiveParseMillis(this.#spec, options.limits);
      const task = new Task({ id: this.#nextId++, op, source, options: wire, millis, decode }, resolve, reject);
      if (signal !== undefined) {
        const onAbort = (): void => this.#abort(task, signal);
        signal.addEventListener("abort", onAbort, { once: true });
        task.onSettle(() => signal.removeEventListener("abort", onAbort));
      }
      this.#queue.push(task);
      this.#dispatch();
    });
  }

  #dispatch(): void {
    for (const slot of this.#slots) {
      if (this.#queue.length === 0) return;
      const thread = slot.thread;
      if (thread !== null && thread.idle) this.#execute(slot, thread, this.#queue.shift()!);
    }
  }

  #execute(slot: Slot, thread: Thread, task: Task): void {
    let reply: Promise<Reply>;
    try {
      const { input, transfer } = wireInput(task.source);
      reply = thread.run({ t: "task", id: task.id, op: task.op, input, options: task.options }, transfer);
    } catch (error) {
      task.fail(error);
      this.#dispatch();
      return;
    }
    this.#running.add(task);
    task.onSettle(() => this.#running.delete(task));
    const watchdog = this.#watch(slot, thread, task);
    let grace: NodeJS.Timeout | undefined;
    task.stopRunning = () => {
      thread.abort(task.id);
      grace = setTimeout(() => this.#retire(slot, thread), this.#graceMs).unref();
    };
    const finish = (): void => {
      clearTimeout(watchdog);
      clearTimeout(grace);
      task.stopRunning = null;
    };
    reply.then(
      (message) => {
        finish();
        if (!task.settled) this.#answer(slot, thread, task, message);
        this.#dispatch();
      },
      (death: unknown) => {
        finish();
        task.fail(crashErrorFor(death, thread.limits));
      },
    );
  }

  #answer(slot: Slot, thread: Thread, task: Task, message: Reply): void {
    if (message.t === "failed") {
      task.fail(decodeError(message.error));
      return;
    }
    let value: unknown;
    try {
      value = task.decode(message);
    } catch (error) {
      task.fail(new IsolationError("crash", `the parse worker sent a reply that could not be read: ${describe(error)}`, { cause: error }));
      this.#retire(slot, thread);
      return;
    }
    task.succeed(value);
  }

  /** The parse's watchdog: the worker's own timer stops a parse at maxParseMillis, unless the worker is stuck. */
  #watch(slot: Slot, thread: Thread, task: Task): NodeJS.Timeout | undefined {
    if (!(Number.isFinite(task.millis) && task.millis > 0)) return undefined;
    const millis = Math.min(task.millis + this.#graceMs, MAX_TIMER_MS);
    return setTimeout(() => {
      task.fail(new ParseTimeoutError(`Parse timed out: the parse worker did not stop within ${millis} ms and was terminated`));
      this.#retire(slot, thread);
    }, millis).unref();
  }

  /**
   * The caller is answered at once, as an in-process parse answers when it sees the signal. A running parse is told to
   * stop, and its worker is terminated if it has not stopped within GRACE_MS.
   */
  #abort(task: Task, signal: AbortSignal): void {
    const queued = this.#queue.indexOf(task);
    if (queued !== -1) this.#queue.splice(queued, 1);
    const stopRunning = task.stopRunning;
    task.fail(abortErrorFor(signal));
    stopRunning?.();
  }

  /** Takes a worker out of the pool and terminates it; its slot gets a new one once it has exited. */
  #retire(slot: Slot, thread: Thread): void {
    if (slot.thread === thread) slot.thread = null;
    void thread.stop();
  }

  #attach(slot: Slot, thread: Thread): void {
    slot.thread = thread;
    thread.worker.unref();
    void thread.gone.then(() => this.#replace(slot, thread));
  }

  #replace(slot: Slot, thread: Thread): void {
    if (slot.thread === thread) slot.thread = null;
    if (this.#closing !== null || this.#failure !== null) return;
    const starting = this.#startThread().then(
      (fresh) => {
        if (this.#closing !== null || this.#failure !== null) return fresh.stop();
        this.#attach(slot, fresh);
        this.#dispatch();
        return undefined;
      },
      (error: unknown) => {
        if (this.#closing === null) this.#fail(new PipesFatalError(`the parse pool could not replace a worker: ${describe(error)}`, { cause: error }));
      },
    );
    this.#starting.add(starting);
    void starting.finally(() => this.#starting.delete(starting));
  }

  async #startThread(): Promise<Thread> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await Thread.start(this.#thread);
      } catch (error) {
        if (error instanceof WorkerInitError || attempt >= SPAWN_ATTEMPTS || this.#closing !== null) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.#spawnBackoffMs * 4 ** (attempt - 1)));
        if (this.#closing !== null) throw error;
      }
    }
  }

  /** The pool can no longer parse: what is queued, and every later call, rejects with why. */
  #fail(error: PipesFatalError): void {
    this.#failure ??= error;
    for (const task of this.#queue.splice(0)) task.fail(this.#failure);
  }
}

/** What an in-process parse throws when its signal aborts (ParseContext.throwIfAborted). */
function abortErrorFor(signal: AbortSignal): unknown {
  try {
    new ParseContext({ signal }).throwIfAborted();
  } catch (error) {
    return error;
  }
  return new Error("the parse was aborted");
}

/** What a parse rejects with when its worker exits under it. Exported for its test. */
export function crashErrorFor(death: unknown, limits: ResourceLimits): Error {
  if (death instanceof IsolationError) return death;
  if ((death as { code?: unknown } | null)?.code === "ERR_WORKER_OUT_OF_MEMORY") {
    const heap = limits.maxOldGenerationSizeMb === undefined ? "" : ` (${limits.maxOldGenerationSizeMb} MB heap)`;
    return new LimitExceededError(`the parse worker ran out of memory${heap}`, { cause: death });
  }
  return new IsolationError("crash", `the parse worker stopped: ${describe(death)}`, { cause: death });
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
