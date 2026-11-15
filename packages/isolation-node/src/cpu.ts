import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { rssPollKind } from "./containment.ts";

/**
 * CPU time of a child, measured by the PARENT (warm.ts). RLIMIT_CPU counts a process's whole life, so a child that
 * answers many requests cannot be held to a per-request budget by the kernel: the parent reads the child's
 * accumulated CPU time and compares what one request added with the budget. Nothing here asks the child, which a
 * compromised parser could make lie.
 *
 * Linux reads utime + stime from /proc/<pid>/stat (microseconds per sample). macOS runs `ps -o cputime=` (about 2 ms
 * per sample; `footprint`, which the RSS poll also runs, is the slow one). Other platforms cannot measure, and reuse
 * is refused there (reuse.ts).
 */

/** USER_HZ: the unit of the /proc/<pid>/stat CPU fields. 100 on every Linux architecture Node supports. */
const CLOCK_TICKS_PER_SEC = 100;
const PS_PATH = "/bin/ps";

export const DEFAULT_CPU_POLL_MS_PROC = 100;
export const DEFAULT_CPU_POLL_MS_PS = 250;

/**
 * utime + stime of a /proc/<pid>/stat line, in seconds. The command name (field 2) is in parentheses and may contain
 * spaces and parentheses itself, so the fields are counted from the LAST ")". Null for a line that does not parse.
 */
export function parseProcStatCpuSecs(line: string, clockTicksPerSec: number = CLOCK_TICKS_PER_SEC): number | null {
  const close = line.lastIndexOf(")");
  if (close === -1) return null;
  // After ")": field 3 (state) is index 0, so utime (field 14) is index 11 and stime (field 15) index 12.
  const fields = line.slice(close + 1).trim().split(/\s+/);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isSafeInteger(utime) || !Number.isSafeInteger(stime) || utime < 0 || stime < 0) return null;
  return (utime + stime) / clockTicksPerSec;
}

/** `ps -o cputime=` output, `[[DD-]HH:]MM:SS[.ss]` (macOS prints minutes past 59 as they are, e.g. "120:21.57"), in seconds. */
export function parsePsCpuTime(text: string): number | null {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (match === null) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  const total = ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
  return Number.isFinite(total) ? total : null;
}

function psCpuSecs(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(PS_PATH, ["-o", "cputime=", "-p", String(pid)], { timeout: 2000 }, (error, stdout) => {
      resolve(error !== null ? null : parsePsCpuTime(stdout));
    });
  });
}

async function procCpuSecs(pid: number): Promise<number | null> {
  try {
    return parseProcStatCpuSecs(await readFile(`/proc/${pid}/stat`, "ascii"));
  } catch {
    return null; // the process is gone
  }
}

/** CPU seconds (user + system) the process has used so far, or null when it is gone or the platform cannot tell. */
export function sampleCpuSecs(pid: number, platform: NodeJS.Platform = process.platform): Promise<number | null> {
  const kind = rssPollKind(platform);
  if (kind === "proc") return procCpuSecs(pid);
  if (kind === "ps") return psCpuSecs(pid);
  return Promise.resolve(null);
}

export type CpuSampler = (pid: number) => number | null | Promise<number | null>;

export interface CpuPollerOptions {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  /** The process's CPU seconds when the request started (what the previous request left). */
  readonly baselineSecs: number;
  /** CPU seconds the request may add to the baseline. */
  readonly budgetSecs: number;
  /** Default: 100 ms with /proc, 250 ms with `ps`. */
  readonly pollMs?: number;
  /** Called once, the first time the request is over its budget. Polling then stops. */
  readonly onOverBudget: (usedSecs: number) => void;
  /** @internal Test seam: replaces the measurement. */
  readonly sample?: CpuSampler;
}

/**
 * Polls the child's CPU time during one request. The first sample is taken one interval in (the baseline is already
 * known), so a request shorter than the interval costs no sample here; the runner takes a final one after the answer.
 */
export class CpuPoller {
  readonly #options: CpuPollerOptions;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;
  #lastSecs: number | null = null;

  constructor(options: CpuPollerOptions) {
    this.#options = options;
    const kind = rssPollKind(options.platform);
    if (kind === "none" && options.sample === undefined) throw new Error(`no CPU measurement on platform ${options.platform}`);
    this.#intervalMs = options.pollMs ?? (kind === "proc" ? DEFAULT_CPU_POLL_MS_PROC : DEFAULT_CPU_POLL_MS_PS);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** The last CPU seconds seen, or null before the first sample. */
  get lastSecs(): number | null {
    return this.#lastSecs;
  }

  #schedule(): void {
    this.#timer = setTimeout(() => this.#tick(), this.#intervalMs);
  }

  #tick(): void {
    this.#timer = undefined;
    if (this.#stopped) return;
    const { pid, platform, sample } = this.#options;
    void Promise.resolve(sample === undefined ? sampleCpuSecs(pid, platform) : sample(pid)).then(
      (secs) => this.#record(secs),
      () => this.#record(null),
    );
  }

  #record(secs: number | null): void {
    if (this.#stopped) return;
    if (secs !== null) {
      this.#lastSecs = secs;
      const used = secs - this.#options.baselineSecs;
      if (used > this.#options.budgetSecs) {
        this.stop();
        this.#options.onOverBudget(used);
        return;
      }
    }
    this.#schedule();
  }
}
