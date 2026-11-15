import { availableParallelism, totalmem } from "node:os";
import { extname } from "node:path";
import type {
  DigestSettings,
  InputSource,
  MediaTypeResult,
  ParseLimits,
  ParseOptions,
  ParseRecord,
  ParseResult,
  Ripstream,
  RipstreamConfig,
} from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import type { PipesRipstream } from "./index.ts";
import { WorkerParsePool } from "./parse-pool.ts";
import { specOf } from "./parse-worker-codec.ts";

/*
 * `@spikedpunch/ripstream-pipes/workers`: parses on worker threads, for a pipes run (pass the pool as the engine's
 * `ripstream`) or any caller with many documents. See docs/workers.md for when it helps and when it does not.
 */

/** The most workers a pool takes. */
export const MAX_WORKERS = 64;

export interface ParsePoolOptions {
  /** How many worker threads parse, each one document at a time: a whole number from 1 to MAX_WORKERS. */
  readonly workers: number;
  /** The configuration each worker builds its ripstream from, as `createRipstream({ config })` does. */
  readonly config?: RipstreamConfig;
  /** Limits every parse starts from, as `createRipstream({ limits })`. */
  readonly limits?: Partial<ParseLimits>;
  /** The digests every parse makes, as `createRipstream({ digest })`. */
  readonly digest?: DigestSettings;
}

/**
 * A ripstream whose parses run on worker threads. It takes bytes (a Uint8Array or an ArrayBuffer) or a `{ path }`, and
 * a password as a string; detection runs on the calling thread.
 */
export interface ParsePool extends PipesRipstream {
  readonly size: number;
  /** Rejects what is queued and running and stops the workers. Waits 5 s at most; calling it again is harmless. */
  close(): Promise<void>;
}

/** Starts the workers and resolves once each has built its ripstream; rejects with why one could not (a configuration error, say). */
export async function createParsePool(options: ParsePoolOptions): Promise<ParsePool> {
  const size = options.workers;
  if (!(Number.isInteger(size) && size >= 1 && size <= MAX_WORKERS)) {
    throw new RangeError(`workers must be a whole number from 1 to ${MAX_WORKERS}, got ${String(size)}`);
  }
  const entry = new URL(`./parse-worker${extname(new URL(import.meta.url).pathname)}`, import.meta.url);
  const pool = await WorkerParsePool.start({ spec: specOf(options), size, entry });
  return new PooledRipstream(pool, options);
}

class PooledRipstream implements ParsePool {
  readonly #pool: WorkerParsePool;
  readonly #options: ParsePoolOptions;
  #detector: Ripstream | undefined;

  constructor(pool: WorkerParsePool, options: ParsePoolOptions) {
    this.#pool = pool;
    this.#options = options;
  }

  get size(): number {
    return this.#pool.size;
  }

  parse(source: InputSource, options?: ParseOptions): Promise<ParseResult> {
    return this.#pool.parse(source, options);
  }

  parseRecursive(source: InputSource, options?: ParseOptions): Promise<readonly ParseRecord[]> {
    return this.#pool.parseRecursive(source, options);
  }

  /** Detection is cheap next to a parse, and a worker round trip would cost more than it saves. */
  detect(source: InputSource | null, options?: { filename?: string; signal?: AbortSignal }): Promise<MediaTypeResult> {
    this.#detector ??= createRipstream({
      ...(this.#options.config === undefined ? {} : { config: this.#options.config }),
      ...(this.#options.limits === undefined ? {} : { limits: this.#options.limits }),
      ...(this.#options.digest === undefined ? {} : { digest: this.#options.digest }),
    });
    return this.#detector.detect(source, options);
  }

  close(): Promise<void> {
    return this.#pool.close();
  }
}

/** What `autoWorkerCount` sizes from: the CPUs this process may use, and the memory it may use. */
export interface WorkerHost {
  readonly availableParallelism: number;
  readonly memoryBytes: number;
}

/** A worker's share of memory the auto size allows for: its idle cost (25-75 MB measured) and a document's working set. */
const AUTO_BYTES_PER_WORKER = 256 * 1024 * 1024;
/** Measured: throughput stops growing between 4 and 8 workers. */
const AUTO_MAX_WORKERS = 8;

/**
 * The pool size `--workers auto` picks: one worker per CPU, at most 8, and no more than half the memory allows at 256 MB
 * each. 0 means a pool would not pay for itself (fewer than 2 workers): parse in-process.
 */
export function autoWorkerCount(host: WorkerHost = currentHost()): number {
  const byMemory = Math.floor((0.5 * host.memoryBytes) / AUTO_BYTES_PER_WORKER);
  const count = Math.min(host.availableParallelism, AUTO_MAX_WORKERS, byMemory);
  return count >= 2 ? count : 0;
}

function currentHost(): WorkerHost {
  const total = totalmem();
  // 0 is no constraint; a constraint above the machine's memory (an unlimited cgroup) is none either.
  const constrained = process.constrainedMemory();
  return { availableParallelism: availableParallelism(), memoryBytes: constrained > 0 ? Math.min(constrained, total) : total };
}
