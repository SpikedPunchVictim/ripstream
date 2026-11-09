import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { MalformedDocumentError, ParseTimeoutError } from "@spikedpunch/ripstream-core";
import type { PdfRequest, PdfResponse, PdfSession } from "./pdf-session.ts";

/**
 * How the parse loop talks to pdf.js: post a request, await the next response.
 * The loop in pdf.ts depends only on this interface; InlineChannel is the one
 * implementation, running the session on the calling thread.
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

/**
 * Runs the session on the calling thread. A wait is bounded by the timeout
 * passed to `next`, but that can only end an async stall: a synchronous loop
 * inside pdf.js blocks the timer too, so containing a runaway parse is the
 * job of the process-isolation layer (docs/isolation.md), not of this class.
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
