import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import {
  LimitExceededError,
  MalformedDocumentError,
  MissingDependencyError,
  ParseTimeoutError,
} from "@spikedpunch/ripstream-core";
import type {
  PdfRequest,
  PdfResponse,
  PdfSession,
  PdfSessionInput,
} from "./pdf-session.ts";

const MIB = 1024 * 1024;
const WATCHDOG_INTERVAL_MS = 20;

/**
 * How the parse loop talks to pdf.js: post a request, await the next response.
 * Worker mode runs the session in a worker thread; inline mode runs it on the
 * calling thread. The loop in pdf.ts is identical for both.
 */
export interface PdfChannel {
  next(timeoutMs?: number): Promise<PdfResponse>;
  post(request: PdfRequest): void;
  /** Stops the work and releases what it holds; safe to call repeatedly. */
  stop(): Promise<void>;
}

/** Responses in arrival order, with an optional per-wait timeout. */
export class ResponseQueue {
  private readonly messages: PdfResponse[] = [];
  private waiter:
    | {
        resolve: (message: PdfResponse) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout> | undefined;
      }
    | null = null;
  private failure: Error | null = null;

  next(timeoutMs?: number): Promise<PdfResponse> {
    if (this.failure !== null) return Promise.reject(this.failure);
    const message = this.messages.shift();
    if (message !== undefined) return Promise.resolve(message);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value: PdfResponse): void => {
          clearTimeout(waiter.timer);
          resolve(value);
        },
        reject: (error: Error): void => {
          clearTimeout(waiter.timer);
          reject(error);
        },
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      this.waiter = waiter;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (this.waiter !== waiter) return;
          this.waiter = null;
          reject(
            new ParseTimeoutError(
              `PDF extraction exceeded ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs);
      }
    });
  }

  push(message: PdfResponse): void {
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(message);
    } else {
      this.messages.push(message);
    }
  }

  fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }
}

/** Runs the session in a worker thread bounded by a V8 heap cap and a memory watchdog. */
export class WorkerChannel implements PdfChannel {
  readonly #queue = new ResponseQueue();
  readonly #worker: Worker;
  readonly #watchdog: ReturnType<typeof setInterval>;

  constructor(input: PdfSessionInput, memoryMb: number) {
    this.#worker = new Worker(workerUrl(), {
      workerData: input,
      // Do not inherit the parent's flags: test instrumentation (for example
      // CBD's node:test preload) and node:test runner flags are invalid here,
      // and the short-lived worker has no test lifecycle.
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: memoryMb },
    });
    this.#worker.on("message", (message: PdfResponse) => {
      this.#queue.push(message);
    });
    this.#worker.on("error", (error: Error) => {
      this.#queue.fail(mapWorkerFailure(error));
    });
    this.#worker.on("exit", (code) => {
      if (code !== 0) {
        this.#queue.fail(new MalformedDocumentError(`PDF worker exited with code ${code}`));
      }
    });
    this.#watchdog = watchMemory(this.#worker, memoryMb * MIB, this.#queue);
  }

  next(timeoutMs?: number): Promise<PdfResponse> {
    return this.#queue.next(timeoutMs);
  }

  post(request: PdfRequest): void {
    this.#worker.postMessage(request);
  }

  async stop(): Promise<void> {
    clearInterval(this.#watchdog);
    await this.#worker.terminate();
  }
}

/**
 * Runs the session on the calling thread, for callers that already contain
 * the whole parse (a nested worker cannot start reliably under a process
 * address-space cap). A wait is bounded by the same timeout as in worker mode
 * but can only end an async stall: a synchronous loop inside pdf.js blocks
 * the timer too, and the enclosing process's wall-clock kill has to cover it.
 */
export class InlineChannel implements PdfChannel {
  readonly #queue = new ResponseQueue();
  readonly #session: Pick<PdfSession, "open" | "handle" | "dispose">;

  constructor(session: Pick<PdfSession, "open" | "handle" | "dispose">) {
    this.#session = session;
    this.#deliver(session.open());
  }

  next(timeoutMs?: number): Promise<PdfResponse> {
    return this.#queue.next(timeoutMs);
  }

  post(request: PdfRequest): void {
    // pdf.js on this thread is a chain of microtasks; yield first so timers,
    // abort signals and I/O callbacks get a turn between requests.
    this.#deliver(yieldToEventLoop().then(() => this.#session.handle(request)));
  }

  async stop(): Promise<void> {
    this.#queue.fail(new MalformedDocumentError("PDF parse was stopped"));
    await this.#session.dispose();
  }

  #deliver(response: Promise<PdfResponse>): void {
    response.then(
      (message) => {
        this.#queue.push(message);
      },
      (error: unknown) => {
        this.#queue.fail(new MalformedDocumentError("PDF session failed", { cause: error }));
      },
    );
  }
}

function workerUrl(): URL {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./pdf-worker${extension}`, import.meta.url);
}

/**
 * V8's heap limit ignores ArrayBuffer memory, so poll the worker's heap plus
 * external memory and fail the parse as soon as the budget is crossed.
 */
function watchMemory(
  worker: Worker,
  budgetBytes: number,
  queue: ResponseQueue,
): ReturnType<typeof setInterval> {
  let pending = false;
  const timer = setInterval(() => {
    if (pending) return;
    pending = true;
    worker.getHeapStatistics().then(
      (stats) => {
        pending = false;
        const used = stats.used_heap_size + stats.external_memory;
        if (used > budgetBytes) {
          queue.fail(
            new LimitExceededError(
              `PDF worker memory ${used} bytes exceeds ${budgetBytes} byte budget`,
            ),
          );
          void worker.terminate();
        }
      },
      () => {
        pending = false;
      },
    );
  }, WATCHDOG_INTERVAL_MS);
  timer.unref();
  return timer;
}

function mapWorkerFailure(error: Error): Error {
  if ((error as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY") {
    return new LimitExceededError("PDF worker exceeded its memory limit", {
      cause: error,
    });
  }
  if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
    return new MissingDependencyError("pdfjs-dist", "PDF parsing");
  }
  return new MalformedDocumentError("PDF worker failed", { cause: error });
}
