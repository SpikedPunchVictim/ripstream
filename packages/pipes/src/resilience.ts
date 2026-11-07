import { readFile, writeFile, mkdir } from "node:fs/promises";
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

  constructor(path: string) {
    this.#path = path;
  }

  static async open(path: string): Promise<CheckpointStore> {
    const store = new CheckpointStore(path);
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as string[];
      for (const id of value) store.#completed.add(id);
    } catch {
      // Fresh checkpoint.
    }
    return store;
  }

  has(id: string): boolean {
    return this.#completed.has(id);
  }

  async mark(id: string): Promise<void> {
    this.#completed.add(id);
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify([...this.#completed].sort(), null, 2)}\n`);
  }

  get size(): number {
    return this.#completed.size;
  }
}
