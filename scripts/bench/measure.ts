/**
 * Process measurement for the cold lanes and the line-protocol client for the warm lanes.
 *
 * Cold: as xberg's harness, the child is started behind a start barrier
 * (`sh -c 'IFS= read -r _ || exit 125; exec "$@"'`), the clock starts when the barrier is
 * released, and the run is in its own process group so a timeout kills the whole tree.
 * Deviation: peak RSS is the kernel's ru_maxrss via GNU time instead of the harness's
 * 1-10 ms process-tree sampler, so short-lived peaks are never missed.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createInterface, type Interface } from "node:readline";

const BARRIER = 'IFS= read -r _ || exit 125; exec "$@"';
const MAX_STDERR = 64 * 1024;

export interface CommandSpec {
  readonly program: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface Measured {
  readonly wallMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** ru_maxrss of the measured program in bytes, or null when GNU time did not report. */
  readonly maxRssBytes: number | null;
}

export interface MeasureOptions {
  readonly timeoutMs: number;
  /** GNU time binary, e.g. /usr/bin/time; null measures time only. */
  readonly timeBinary: string | null;
  /** Scratch file GNU time writes %M to. */
  readonly rssFile: string;
}

export async function runMeasured(command: CommandSpec, options: MeasureOptions): Promise<Measured> {
  await rm(options.rssFile, { force: true });
  const timed =
    options.timeBinary === null
      ? [command.program, ...command.args]
      : [options.timeBinary, "-f", "%M", "-o", options.rssFile, command.program, ...command.args];
  const child = spawn("sh", ["-c", BARRIER, "bench-start-barrier", ...timed], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...command.env },
  });
  const stdout: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8");
  });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  let timedOut = false;
  const started = performance.now();
  child.stdin.end("start\n");
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, options.timeoutMs);

  const [exitCode, signal] = await new Promise<[number | null, string | null]>((resolve) => {
    child.once("close", (code, closeSignal) => resolve([code, closeSignal]));
  });
  const wallMs = performance.now() - started;
  clearTimeout(timer);

  return {
    wallMs,
    exitCode,
    signal,
    timedOut,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr,
    maxRssBytes: options.timeBinary === null ? null : await readMaxRss(options.rssFile),
  };
}

async function readMaxRss(file: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  // GNU time prefixes "Command exited with non-zero status N" on failure; %M is the last line.
  const last = text.trim().split("\n").pop() ?? "";
  const kilobytes = Number.parseInt(last, 10);
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

/**
 * A persistent process that answers one stdout line per stdin line after printing READY:
 * the protocol of xberg's TikaExtract `server` mode, which inproc-worker.ts also speaks.
 */
export class LineServer {
  readonly #command: CommandSpec;
  #child: ChildProcessWithoutNullStreams | null = null;
  #lines: Interface | null = null;
  #pending: ((line: string | null) => void) | null = null;
  /** Lines that arrived while nobody was waiting; null marks the process closing. */
  #queue: (string | null)[] = [];
  #stderr = "";
  #peakRssBytes = 0;

  constructor(command: CommandSpec) {
    this.#command = command;
  }

  get stderrTail(): string {
    return this.#stderr.slice(-4000);
  }

  /** Highest VmHWM seen over every process this server has started. */
  get peakRssBytes(): number {
    return this.#peakRssBytes;
  }

  async start(timeoutMs: number): Promise<number> {
    const started = performance.now();
    const child = spawn(this.#command.program, [...this.#command.args], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, ...this.#command.env },
    });
    this.#child = child;
    this.#stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-MAX_STDERR);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    this.#lines = lines;
    this.#queue = [];
    lines.on("line", (line) => this.#deliver(line));
    child.once("close", () => this.#deliver(null));
    const deadline = started + timeoutMs;
    for (;;) {
      // Logging libraries may write to stdout before READY; skip until it arrives.
      const line = await this.#nextLine(Math.max(1, deadline - performance.now()));
      if (line === "READY") break;
      if (line === null || line === TIMED_OUT) {
        await this.kill();
        throw new Error(`server did not print READY: ${this.stderrTail}`);
      }
    }
    return performance.now() - started;
  }

  /**
   * Sends one request line; resolves with the first response line that starts with `{`
   * (log lines on stdout are skipped) and the round-trip time.
   */
  async request(line: string, timeoutMs: number): Promise<{ line: string | null; wallMs: number; timedOut: boolean }> {
    const child = this.#child;
    if (child === null) throw new Error("server is not running");
    const started = performance.now();
    let response = this.#nextLine(timeoutMs);
    child.stdin.write(`${line}\n`);
    for (;;) {
      const answer = await response;
      if (answer === TIMED_OUT) return { line: null, wallMs: performance.now() - started, timedOut: true };
      if (answer === null || answer.startsWith("{")) {
        const wallMs = performance.now() - started;
        await this.#sampleRss();
        return { line: answer, wallMs, timedOut: false };
      }
      response = this.#nextLine(Math.max(1, timeoutMs - (performance.now() - started)));
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    await this.#sampleRss();
    this.#child = null;
    this.#lines?.close();
    this.#lines = null;
    child.stdin.end();
    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", () => resolve());
    });
    const timer = setTimeout(() => killGroup(child.pid), 5000);
    await closed;
    clearTimeout(timer);
  }

  /** Kills the process outright; used after a request timed out. */
  async kill(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    this.#child = null;
    this.#lines?.close();
    this.#lines = null;
    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", () => resolve());
    });
    killGroup(child.pid);
    await closed;
  }

  #deliver(line: string | null): void {
    const pending = this.#pending;
    if (pending === null) {
      this.#queue.push(line);
      return;
    }
    this.#pending = null;
    pending(line);
  }

  #nextLine(timeoutMs: number): Promise<string | null | typeof TIMED_OUT> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift() ?? null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending = null;
        resolve(TIMED_OUT);
      }, timeoutMs);
      this.#pending = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
    });
  }

  async #sampleRss(): Promise<void> {
    const pid = this.#child?.pid;
    if (pid === undefined) return;
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = /^VmHWM:\s+(\d+)\s+kB/m.exec(status);
      if (match?.[1] !== undefined) this.#peakRssBytes = Math.max(this.#peakRssBytes, Number(match[1]) * 1024);
    } catch {
      // Not Linux, or the process is gone.
    }
  }
}

const TIMED_OUT = Symbol("timed out");
