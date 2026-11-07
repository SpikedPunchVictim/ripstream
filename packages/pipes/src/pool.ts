import { runIsolatedTask, type IsolatedTaskOptions, WorkerTaskError } from "@spikedpunch/ripstream-core";

export interface WorkerPoolOptions {
  readonly moduleUrl: string | URL;
  readonly exportName?: string;
  readonly size?: number;
  readonly memoryLimitMb?: number;
  readonly timeoutMs?: number;
}

/** Bounded worker pool; crashed workers are discarded and replaced per task. */
export class WorkerPool {
  readonly #options: WorkerPoolOptions;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(options: WorkerPoolOptions) {
    this.#options = options;
  }

  get size(): number {
    return Math.max(1, this.#options.size ?? 2);
  }

  async run<T>(payload: unknown): Promise<T> {
    await this.#acquire();
    try {
      return await runIsolatedTask<T>({
        moduleUrl: this.#options.moduleUrl,
        exportName: this.#options.exportName ?? "default",
        payload,
        ...(this.#options.memoryLimitMb === undefined
          ? {}
          : { memoryLimitMb: this.#options.memoryLimitMb }),
        ...(this.#options.timeoutMs === undefined
          ? {}
          : { timeoutMs: this.#options.timeoutMs }),
      });
    } catch (error) {
      if (error instanceof WorkerTaskError) throw error;
      throw new WorkerTaskError("Worker task failed", { cause: error });
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.size) {
      this.#active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(() => {
        this.#active++;
        resolve();
      });
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) next();
    else this.#active--;
  }
}
