import { Worker } from "node:worker_threads";
import { AbortError } from "./errors.ts";

export interface IsolatedTaskOptions {
  readonly moduleUrl: string | URL;
  readonly exportName?: string;
  readonly payload?: unknown;
  readonly timeoutMs?: number;
  readonly memoryLimitMb?: number;
  readonly signal?: AbortSignal;
  readonly env?: Record<string, string>;
}

export class WorkerTaskError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "WorkerTaskError";
  }
}

export class WorkerTimeoutError extends WorkerTaskError {
  constructor(timeoutMs: number) {
    super(`Worker task exceeded ${timeoutMs} ms`);
    this.name = "WorkerTimeoutError";
  }
}

/**
 * Runs an exported function in a worker with memory, time and env isolation.
 *
 * NOTE: superseded by the ParseIsolator port; scheduled for removal in P5.
 */
export function runIsolatedTask<T = unknown>(
  options: IsolatedTaskOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const workerUrl = entryUrl();
  const env = options.env ?? {};
  const worker = new Worker(workerUrl, {
    workerData: {
      moduleUrl:
        options.moduleUrl instanceof URL
          ? options.moduleUrl.href
          : String(options.moduleUrl),
      exportName: options.exportName ?? "default",
      payload: options.payload,
    },
    execArgv: [],
    env,
    resourceLimits:
      options.memoryLimitMb === undefined
        ? undefined
        : { maxOldGenerationSizeMb: options.memoryLimitMb },
  });

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      action();
    };
    const onAbort = (): void =>
      finish(() => reject(new AbortError("Worker task aborted")));
    const timer = setTimeout(
      () => finish(() => reject(new WorkerTimeoutError(timeoutMs))),
      timeoutMs,
    );
    if (options.signal?.aborted === true) {
      finish(() => reject(new AbortError("Worker task aborted")));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (message: {
      ok: boolean;
      result?: T;
      error?: { name: string; message: string };
    }) => {
      if (message.ok) {
        finish(() => resolve(message.result as T));
      } else {
        finish(() =>
          reject(
            new WorkerTaskError(
              `${message.error?.name ?? "Error"}: ${message.error?.message ?? "worker failed"}`,
            ),
          ),
        );
      }
    });
    worker.on("error", (error) => {
      finish(() =>
        reject(new WorkerTaskError(`Worker crashed: ${error.message}`, { cause: error })),
      );
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        finish(() => reject(new WorkerTaskError(`Worker exited with code ${code}`)));
      }
    });
  });
}

function entryUrl(): URL {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./worker-entry${extension}`, import.meta.url);
}
