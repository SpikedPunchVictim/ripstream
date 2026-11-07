import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

/** Retries with exponential backoff, rethrowing the last error. */
export async function withRetry<T>(
  task: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelay = options.baseDelayMs ?? 50;
  const maxDelay = options.maxDelayMs ?? 2_000;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      last = error;
      if (attempt + 1 >= attempts) break;
      const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw last;
}

/** JSON-file checkpoint store for idempotent pipe reruns. */
export class CheckpointStore {
  readonly #path: string;
  readonly #completed = new Set<string>();
  static #tmpCounter = 0;

  constructor(path: string) {
    this.#path = path;
  }

  static async open(path: string): Promise<CheckpointStore> {
    const store = new CheckpointStore(path);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      // Genuinely absent: fresh checkpoint. Any other read failure is real.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return store;
      throw error;
    }
    // An empty file carries no checkpoint (nothing to lose), so it is fresh.
    if (raw.trim() === "") return store;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Corrupt checkpoint file ${path}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    if (!Array.isArray(value)) {
      throw new Error(`Corrupt checkpoint file ${path}: expected a JSON array of ids`);
    }
    for (const id of value) store.#completed.add(String(id));
    return store;
  }

  has(id: string): boolean {
    return this.#completed.has(id);
  }

  async mark(id: string): Promise<void> {
    this.#completed.add(id);
    await mkdir(dirname(this.#path), { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a torn checkpoint.
    const tmp = `${this.#path}.${process.pid}.${++CheckpointStore.#tmpCounter}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify([...this.#completed].sort(), null, 2)}\n`);
      await rename(tmp, this.#path);
    } catch (error) {
      // Don't leave a partial temp behind to accumulate under repeated failures.
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  get size(): number {
    return this.#completed.size;
  }
}
