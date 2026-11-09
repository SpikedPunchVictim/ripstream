import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { rssPollKind } from "./containment.ts";

/**
 * L3: resident-set-size polling of the child. Linux reads /proc/<pid>/statm
 * every `pollMs` (default 20 ms, synchronous, microseconds per sample). macOS
 * has no /proc, so it shells out to `ps -o rss=` no more often than every
 * 250 ms: a much weaker bound, and a fast page-touch can overshoot by
 * gigabytes between samples. Even on Linux the poll is only a kill trigger for
 * slow growth (see the P0 d-row), not a precise cap.
 */

export const DEFAULT_POLL_MS = 20;
export const PS_MIN_POLL_MS = 250;

const BYTES_PER_MB = 1048576;
const PS_PATH = "/bin/ps";
const MAX_INTERVAL_SAMPLES = 1024;

let cachedPageSize: number | undefined;

/**
 * The kernel page size, found without spawning: VmRSS (kB) over the resident
 * page count of /proc/self/statm, rounded to a power of two. Falls back to 4096.
 */
export function pageSizeBytes(): number {
  if (cachedPageSize !== undefined) return cachedPageSize;
  let size = 4096;
  try {
    const pages = Number(readFileSync("/proc/self/statm", "ascii").split(" ")[1]);
    const vmRssKb = Number(/VmRSS:\s+(\d+) kB/.exec(readFileSync("/proc/self/status", "ascii"))?.[1]);
    if (Number.isFinite(pages) && pages > 0 && Number.isFinite(vmRssKb) && vmRssKb > 0) {
      const ratio = (vmRssKb * 1024) / pages;
      const exponent = Math.round(Math.log2(ratio));
      if (exponent >= 12 && exponent <= 16) size = 2 ** exponent;
    }
  } catch {
    // no /proc: keep 4096
  }
  cachedPageSize = size;
  return size;
}

function statmRssMb(pid: number): number | null {
  try {
    const pages = Number(readFileSync(`/proc/${pid}/statm`, "ascii").split(" ")[1]);
    return Number.isFinite(pages) ? (pages * pageSizeBytes()) / BYTES_PER_MB : null;
  } catch {
    return null; // process gone
  }
}

function psRssMb(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(PS_PATH, ["-o", "rss=", "-p", String(pid)], { timeout: 2000 }, (error, stdout) => {
      const kb = Number(stdout.trim());
      resolve(error !== null || !Number.isFinite(kb) || stdout.trim() === "" ? null : kb / 1024);
    });
  });
}

/** One RSS sample in MiB, or null when the process is gone or the platform cannot measure it. */
export async function sampleRssMb(pid: number, platform: NodeJS.Platform = process.platform): Promise<number | null> {
  const kind = rssPollKind(platform);
  if (kind === "proc") return statmRssMb(pid);
  if (kind === "ps") return psRssMb(pid);
  return null;
}

export interface RssPollerOptions {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly limitMb: number;
  readonly pollMs: number;
  /** Called once, with the offending sample, the first time RSS exceeds the limit. Polling then stops. */
  readonly onOverLimit: (rssMb: number) => void;
  /** @internal Test seam: replaces the /proc and `ps` measurement. */
  readonly sample?: (pid: number) => number | null | Promise<number | null>;
}

export interface RssStats {
  readonly samples: number;
  readonly peakMb: number;
  /** Largest increase between two consecutive samples. */
  readonly maxStepMb: number;
  /** Real time between the two samples of that largest step. */
  readonly maxStepDtMs: number;
  /** Median of the MEASURED inter-sample delta (not the configured interval). */
  readonly medianIntervalMs: number;
  /** The configured interval after the platform minimum was applied. */
  readonly effectiveIntervalMs: number;
  /** The sample that tripped the limit, or null. */
  readonly rssAtLimitMb: number | null;
}

/** Self-correcting poller: each wake-up is scheduled against the ideal time line, not the previous wake-up. */
export class RssPoller {
  readonly #options: RssPollerOptions;
  readonly #kind: ReturnType<typeof rssPollKind>;
  readonly #intervalMs: number;
  readonly #intervals: number[] = [];
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;
  #nextAt = 0;
  #lastAt = 0;
  #lastRss = 0;
  #samples = 0;
  #peakMb = 0;
  #maxStepMb = 0;
  #maxStepDtMs = 0;
  #rssAtLimitMb: number | null = null;

  constructor(options: RssPollerOptions) {
    this.#options = options;
    this.#kind = rssPollKind(options.platform);
    if (this.#kind === "none") throw new Error(`no RSS measurement on platform ${options.platform}`);
    this.#intervalMs = this.#kind === "ps" ? Math.max(options.pollMs, PS_MIN_POLL_MS) : options.pollMs;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#nextAt = performance.now();
    this.#tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  stats(): RssStats {
    const sorted = [...this.#intervals].sort((a, b) => a - b);
    return {
      samples: this.#samples,
      peakMb: this.#peakMb,
      maxStepMb: this.#maxStepMb,
      maxStepDtMs: this.#maxStepDtMs,
      medianIntervalMs: sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0),
      effectiveIntervalMs: this.#intervalMs,
      rssAtLimitMb: this.#rssAtLimitMb,
    };
  }

  #tick(): void {
    this.#timer = undefined;
    if (this.#stopped) return;
    const { pid, sample } = this.#options;
    if (sample !== undefined) void Promise.resolve(sample(pid)).then((rss) => this.#record(rss));
    else if (this.#kind === "proc") this.#record(statmRssMb(pid));
    else void psRssMb(pid).then((rss) => this.#record(rss));
  }

  #record(rssMb: number | null): void {
    if (this.#stopped) return;
    const now = performance.now();
    if (rssMb !== null) {
      if (this.#samples > 0) {
        const dt = now - this.#lastAt;
        this.#intervals.push(dt);
        if (this.#intervals.length > MAX_INTERVAL_SAMPLES) this.#intervals.shift();
        if (rssMb - this.#lastRss > this.#maxStepMb) {
          this.#maxStepMb = rssMb - this.#lastRss;
          this.#maxStepDtMs = dt;
        }
      }
      this.#samples += 1;
      this.#lastAt = now;
      this.#lastRss = rssMb;
      this.#peakMb = Math.max(this.#peakMb, rssMb);
      if (rssMb > this.#options.limitMb) {
        this.#rssAtLimitMb = rssMb;
        this.stop();
        this.#options.onOverLimit(rssMb);
        return;
      }
    }
    this.#nextAt += this.#intervalMs;
    if (this.#nextAt <= now) this.#nextAt = now + this.#intervalMs; // fell behind: skip, do not burst
    this.#timer = setTimeout(() => this.#tick(), Math.max(0, this.#nextAt - now));
  }
}
