import type { PipesSettings } from "@spikedpunch/ripstream-core";
import { PipesEngine, createEngineFromSettings, type ExtensionOf, type PipesRipstream, type PipesStats, type Reporter } from "./index.ts";
import type { FetchEmitTuple } from "./tuple.ts";

/*
 * Tika's AsyncProcessor (tika-pipes-core): tuples are offered to a bounded queue and processed in the background by one
 * long-lived run, whose results go to the configuration's reporters and whose documents go to its emitters. What the
 * caller hears is only whether the queue took them.
 */

/** A batch that is bigger than the queue could ever hold: waiting will not help, so it is not a throttle. */
export class OfferLargerThanQueueSize extends Error {
  readonly sizeOffered: number;
  readonly queueSize: number;

  constructor(sizeOffered: number, queueSize: number) {
    super(`Batch of ${sizeOffered} tuples exceeds the queue capacity (${queueSize}); split the batch`);
    this.name = "OfferLargerThanQueueSize";
    this.sizeOffered = sizeOffered;
    this.queueSize = queueSize;
  }
}

/** Tika's PipesConfig.DEFAULT_QUEUE_SIZE. */
export const DEFAULT_ASYNC_QUEUE_SIZE = 10_000;

export interface AsyncProcessorOptions {
  /** How many tuples may wait for a worker. Default: the settings' `pipes.queueSize`, else 10 000 (Tika's). */
  readonly queueSize?: number;
  /** Parses every tuple. A service that isolates parsing must pass its isolated ripstream. */
  readonly ripstream?: PipesRipstream;
  /** Hears each result as well as the settings' own reporters. */
  readonly reporter?: Reporter;
  /** The extension of a media type, for UNPACK with `suffixStrategy: DETECTED`. See `PipesEngineOptions.extensionOf`. */
  readonly extensionOf?: ExtensionOf;
}

/** A change a waiting offer or the drain is waiting for: tuples taken off the queue, put on it, or the processor closing or failing. */
interface Signal {
  wait(milliseconds?: number): Promise<void>;
  notify(): void;
}

function signal(): Signal {
  let waiters: Array<() => void> = [];
  return {
    wait: (milliseconds) =>
      new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const done = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          waiters = waiters.filter((waiter) => waiter !== done);
          resolve();
        };
        if (milliseconds !== undefined) timer = setTimeout(done, milliseconds);
        waiters.push(done);
      }),
    notify: () => {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    },
  };
}

export class AsyncProcessor {
  readonly #queueSize: number;
  readonly #queue: FetchEmitTuple[] = [];
  readonly #changed = signal();
  readonly #engine: PipesEngine;
  readonly #done: Promise<void>;
  #closed = false;
  #failure: { readonly error: unknown } | null = null;

  /**
   * Starts the run at once; it waits for tuples. The settings are Tika's pipes sections (`loadConfig(...).pipes`), and the
   * ones that build per-run things (reporters, emitters) are built here, once, so a reporter that appends to a file does
   * so across offers. A settings `pipes-iterator` is not used: the offers are the tuples.
   */
  constructor(settings: PipesSettings, options: AsyncProcessorOptions = {}) {
    const queueSize = options.queueSize ?? settings.maxQueue ?? DEFAULT_ASYNC_QUEUE_SIZE;
    if (!Number.isInteger(queueSize) || queueSize < 1) throw new RangeError(`queueSize must be a positive integer, got ${String(queueSize)}`);
    this.#queueSize = queueSize;
    this.#engine = createEngineFromSettings(settings, {
      iterator: this.#drain(),
      ...(options.ripstream === undefined ? {} : { ripstream: options.ripstream }),
      ...(options.reporter === undefined ? {} : { reporter: options.reporter }),
      ...(options.extensionOf === undefined ? {} : { extensionOf: options.extensionOf }),
    });
    // A run that cannot go on (a reporter that throws, an emitter that cannot close) ends here; offers hear why.
    this.#done = this.#engine.run().then(
      () => undefined,
      (error: unknown) => {
        this.#failure = { error };
        this.#changed.notify();
      },
    );
  }

  /** Tuples that can be offered now without waiting. Tika's `getCapacity`. */
  get capacity(): number {
    return this.#queueSize - this.#queue.length;
  }

  /** What the run has done so far is only known when it ends: the results are in the reporters. */
  get stats(): PipesStats {
    return this.#engine.stats;
  }

  /**
   * Puts the tuples on the queue, all of them or none, waiting up to `maxWaitMs` for room. True when they were taken, false
   * when the queue stayed too full for that long. Throws `OfferLargerThanQueueSize` for a batch that could never fit, and
   * the run's own error when it has ended.
   */
  async offer(tuples: readonly FetchEmitTuple[], maxWaitMs: number): Promise<boolean> {
    if (tuples.length > this.#queueSize) throw new OfferLargerThanQueueSize(tuples.length, this.#queueSize);
    const deadline = performance.now() + maxWaitMs;
    for (;;) {
      if (this.#failure !== null) throw this.#failure.error;
      if (this.#closed) throw new Error("the async processor is closed");
      if (this.capacity >= tuples.length) {
        this.#queue.push(...tuples);
        this.#changed.notify();
        return true;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await this.#changed.wait(remaining);
    }
  }

  /** Stops taking offers, lets what was taken finish, and ends the run (which closes the emitters). Rejects with the run's error. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#changed.notify();
    await this.#done;
    if (this.#failure !== null) throw this.#failure.error;
  }

  async *#drain(): AsyncGenerator<FetchEmitTuple> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        this.#changed.notify();
        yield next;
        continue;
      }
      if (this.#closed) return;
      await this.#changed.wait();
    }
  }
}
