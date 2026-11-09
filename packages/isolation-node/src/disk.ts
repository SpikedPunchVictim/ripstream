import { mkdtempSync, statSync, type Dir, type Stats } from "node:fs";
import { chmod, lstat, opendir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * L6: the child's disk. Parsers spool to the temp directory (a stream above 1 MiB, the OCR parser's image), and a
 * hostile document made one child write 270 MiB for a 90 MiB input and leave it behind when it was killed. So each
 * call gets a PRIVATE directory under `tempDir`, handed to the child as TMPDIR, measured by a poll while the child
 * runs and removed once its process group is reaped, whatever the outcome.
 *
 * The measure is ALLOCATED bytes (`blocks * 512`), so a sparse file does not count, and the walk is bounded: a
 * directory of a million empty files must not make the poll expensive, so more than MAX_DISK_ENTRIES entries, or
 * directories nested deeper than MAX_DISK_DEPTH, count as over budget. The poll is the only enforcement: between
 * two samples the child can write `pollMs` x its write rate beyond the budget. That overshoot is accepted.
 */

export const DEFAULT_DISK_POLL_MS = 100;
/** Entries (files, directories, links) seen in one walk before the directory counts as over budget. */
export const MAX_DISK_ENTRIES = 10_000;
/** Directory levels below the call directory that a walk follows before the directory counts as over budget. */
export const MAX_DISK_DEPTH = 8;
/** Name prefix of a call's directory; tests and operators can recognise a leftover by it. */
export const CALL_DIR_PREFIX = "ripstream-call-";

const BYTES_PER_MB = 1048576;

export interface WalkBounds {
  readonly maxEntries: number;
  readonly maxDepth: number;
}

const DEFAULT_BOUNDS: WalkBounds = { maxEntries: MAX_DISK_ENTRIES, maxDepth: MAX_DISK_DEPTH };

export interface DiskUsage {
  /** Allocated bytes of what the walk saw. */
  readonly bytes: number;
  /** Entries seen; one past the bound when the walk stopped on it. */
  readonly entries: number;
  /** A bound was hit and the walk stopped early: the directory counts as over any budget. */
  readonly boundHit: boolean;
}

function allocatedBytes(stats: { readonly blocks?: number; readonly size: number }): number {
  return typeof stats.blocks === "number" ? stats.blocks * 512 : stats.size;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Allocated bytes under `root`, links not followed. An entry that vanishes mid-walk (the child deletes its own
 * files) is skipped; any other failure rejects, and the poller treats that as "no sample this time".
 */
export async function measureDiskUsage(root: string, bounds: WalkBounds = DEFAULT_BOUNDS): Promise<DiskUsage> {
  let bytes = 0;
  let entries = 0;
  const pending: Array<{ readonly path: string; readonly depth: number }> = [{ path: root, depth: 0 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { path, depth } = next;
    let directory: Dir;
    try {
      directory = await opendir(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    // Iterating closes the handle on every exit, including the break below. Names arrive in small batches, so a
    // huge directory is never read whole.
    for await (const entry of directory) {
      entries += 1;
      if (entries > bounds.maxEntries) return { bytes, entries, boundHit: true };
      const full = join(path, entry.name);
      let stats: Stats;
      try {
        stats = await lstat(full);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      bytes += allocatedBytes(stats);
      if (!stats.isDirectory()) continue;
      if (depth + 1 > bounds.maxDepth) return { bytes, entries, boundHit: true };
      pending.push({ path: full, depth: depth + 1 });
    }
  }
  return { bytes, entries, boundHit: false };
}

export type DiskSampler = (dir: string) => DiskUsage | null | Promise<DiskUsage | null>;

export interface DiskPollerOptions {
  readonly dir: string;
  readonly limitMb: number;
  readonly pollMs: number;
  /** Called once, with the offending sample, the first time the directory is over budget. Polling then stops. */
  readonly onOverLimit: (usage: DiskUsage) => void;
  /** @internal Test seam: replaces the measurement. */
  readonly sample?: DiskSampler;
}

export interface DiskStats {
  /** Measurements taken (samples that failed are not counted). */
  readonly samples: number;
  readonly peakBytes: number;
  /** The sample that tripped the budget, or null. */
  readonly bytesAtLimit: number | null;
  /** The walk hit its entry or depth bound. */
  readonly boundHit: boolean;
  /** The directory could not be read for `MAX_FAILED_SAMPLES` samples in a row, which counts as over budget. */
  readonly unreadable: boolean;
}

/** A walk that keeps failing is a directory the child made unreadable; measuring nothing must not mean allowing anything. */
export const MAX_FAILED_SAMPLES = 3;

/**
 * Samples one directory every `pollMs` until stopped or over budget. The next wake-up is scheduled when the
 * previous sample has settled, so a slow walk delays the poll instead of overlapping it, and the timer is unref'd so
 * a poll never keeps the process alive.
 */
export class DiskPoller {
  readonly #options: DiskPollerOptions;
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;
  #samples = 0;
  #peakBytes = 0;
  #bytesAtLimit: number | null = null;
  #boundHit = false;
  #failedSamples = 0;
  #unreadable = false;

  constructor(options: DiskPollerOptions) {
    this.#options = options;
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

  stats(): DiskStats {
    return {
      samples: this.#samples,
      peakBytes: this.#peakBytes,
      bytesAtLimit: this.#bytesAtLimit,
      boundHit: this.#boundHit,
      unreadable: this.#unreadable,
    };
  }

  #schedule(): void {
    this.#timer = setTimeout(() => void this.#tick(), this.#options.pollMs);
    this.#timer.unref();
  }

  async #tick(): Promise<void> {
    this.#timer = undefined;
    if (this.#stopped) return;
    let usage: DiskUsage | null;
    let failed = false;
    try {
      usage = await (this.#options.sample ?? measureDiskUsage)(this.#options.dir);
    } catch {
      usage = null; // one failed walk says nothing about the budget; the next sample tries again
      failed = true;
    }
    if (this.#stopped) return; // the call ended while the walk was running
    if (failed) {
      this.#failedSamples += 1;
      if (this.#failedSamples >= MAX_FAILED_SAMPLES) {
        this.#unreadable = true;
        this.#bytesAtLimit = this.#peakBytes;
        this.stop();
        this.#options.onOverLimit({ bytes: this.#peakBytes, entries: 0, boundHit: false });
        return;
      }
    } else {
      this.#failedSamples = 0;
    }
    if (usage !== null) {
      this.#samples += 1;
      this.#peakBytes = Math.max(this.#peakBytes, usage.bytes);
      if (usage.boundHit || usage.bytes > this.#options.limitMb * BYTES_PER_MB) {
        this.#bytesAtLimit = usage.bytes;
        this.#boundHit = usage.boundHit;
        this.stop();
        this.#options.onOverLimit(usage);
        return;
      }
    }
    this.#schedule();
  }
}

/**
 * Checks a caller-supplied `tempDir`: an absolute path to a directory that exists now. The supervisor creates the
 * per-call directory inside it, so a relative path would resolve against whatever the working directory is later.
 */
export function requireTempDir(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`tempDir must be a non-empty string, got ${describe(value)}`);
  }
  if (value.includes("\0")) throw new TypeError("tempDir must not contain NUL");
  if (!isAbsolute(value)) throw new TypeError(`tempDir must be an absolute path, got ${describe(value)}`);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(value).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new RangeError(`tempDir must be an existing directory, got ${describe(value)} (${code})`, { cause: error });
  }
  if (!isDirectory) throw new RangeError(`tempDir must be an existing directory, got ${describe(value)} (not a directory)`);
  return value;
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * A new, empty directory (mode 0700) for one call, made synchronously: it is one mkdir, and the supervisor needs the
 * name before it can build the child's environment.
 */
export function createCallDir(tempDir: string): string {
  return mkdtempSync(join(tempDir, CALL_DIR_PREFIX));
}

/** Removes a call directory and everything in it. Rejects only when something could not be removed. */
export async function removeCallDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    // The child made a directory unreadable or unwritable (chmod 000): only the owner can undo it, and the owner is us.
    await makeRemovable(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 2 });
  }
}

/** chmod u+rwx on every directory under `dir` (links are not followed). Best effort: a failure here shows up in the retry. */
async function makeRemovable(dir: string): Promise<void> {
  const pending = [dir];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    try {
      await chmod(next, 0o700);
      for (const entry of await readdir(next, { withFileTypes: true })) {
        if (entry.isDirectory()) pending.push(join(next, entry.name));
      }
    } catch {
      // gone, or not ours to change; the retry reports what is left
    }
  }
}
