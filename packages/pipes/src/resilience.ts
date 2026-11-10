import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";

export interface RetryOptions {
  /** How many tries in all, the first included. Default 3. */
  readonly attempts?: number;
  /** The wait after the first failure; it doubles after each one. Default 50. */
  readonly baseDelayMs?: number;
  /** The longest wait. Default 2000. */
  readonly maxDelayMs?: number;
  /** Which failures are worth another try. Default: all of them. A failure it refuses is thrown at once. */
  readonly retryIf?: (error: unknown) => boolean;
  /** When it aborts, the wait ends and the failure so far is thrown, so a run that is stopping is not held up by a backoff. */
  readonly signal?: AbortSignal;
}

/**
 * Retries with exponential backoff and jitter, rethrowing the last error. Each wait is between half and all of the
 * backoff, so workers that failed together (a server that answered 503 to all of them) do not come back together.
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelay = options.baseDelayMs ?? 50;
  const maxDelay = options.maxDelayMs ?? 2_000;
  const aborted = (): boolean => options.signal?.aborted === true;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      last = error;
      if (attempt + 1 >= attempts) break;
      if (options.retryIf !== undefined && !options.retryIf(error)) break;
      if (aborted()) break;
      const backoff = Math.min(maxDelay, baseDelay * 2 ** attempt);
      await sleep(backoff * (0.5 + Math.random() / 2), options.signal);
      if (aborted()) break;
    }
  }
  throw last;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    if (signal?.aborted === true) return resolve();
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Errno and undici codes of a connection or a resource that may be there on the next try. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** HTTP statuses that say "not now" (timeout, too early, throttled) or that a server in front of the service failed. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Whether a failure of a fetch or an emit is one that may not happen again: a connection reset or refused, a timeout,
 * a name server that did not answer, a busy file, or an HTTP status above. Looks at the error and at its `cause`
 * (undici reports a reset as `TypeError: fetch failed` caused by the socket error). A missing file, a refusal by the
 * SSRF guard, a path that is not allowed and a file that already exists will be the same on the next try, so they are not.
 */
export function isTransientError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const { code, status } = current as { code?: unknown; status?: unknown };
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    if (typeof status === "number" && TRANSIENT_STATUSES.has(status)) return true;
    current = current.cause;
  }
  return false;
}

/** What the engine asks of a checkpoint: the ids that are done, and a way to add one. `CheckpointStore` is one. */
export interface Checkpoint {
  has(id: string): boolean;
  /** Resolves when the id is recorded. The engine does not go on past a mark that fails. */
  mark(id: string): Promise<void> | void;
}

/**
 * The ids of the inputs a run has finished, in a file that survives the process: a journal with one JSON string a
 * line, appended as each input finishes. An append costs the same at ten ids and at ten million (rewriting a whole
 * file for each id took 1.1 ms an id at 16 000 ids, and grew with them), a process that is killed leaves at worst a
 * cut last line, and appends are made one at a time in the order `mark` was called.
 *
 * A mark is in the operating system's hands when `mark` resolves, which is enough for a process that dies; a power
 * cut may lose the last few. An id that is lost is run again, never skipped.
 */
export class CheckpointStore implements Checkpoint {
  readonly #path: string;
  readonly #completed = new Set<string>();
  #appends: Promise<void> = Promise.resolve();
  #directoryMade = false;

  constructor(path: string) {
    this.#path = path;
  }

  /**
   * Reads the journal at `path`, which may not be there yet. A last line that was cut (the process died in the middle
   * of an append) is dropped and cut off the file, so the next append starts a line of its own. Anything else that is
   * not a JSON string, including the file this store wrote before the journal (one JSON array), is refused.
   */
  static async open(path: string): Promise<CheckpointStore> {
    const store = new CheckpointStore(path);
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch (error) {
      // Genuinely absent: fresh checkpoint. Any other read failure is real.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return store;
      throw error;
    }
    if (raw.toString("utf8", 0, 64).trimStart().startsWith("[")) {
      throw new Error(`Corrupt checkpoint file ${path}: it is a JSON array, which an earlier version wrote; this one keeps one JSON string a line`);
    }
    const end = raw.lastIndexOf(0x0a) + 1;
    const tail = raw.subarray(end);
    if (tail.length > 0 && tail.toString("utf8").trim() !== "") {
      if (tail[0] !== 0x22) throw new Error(`Corrupt checkpoint file ${path}: expected one JSON string a line`);
      await truncate(path, end);
    }
    const lines = raw.subarray(0, end).toString("utf8").split("\n");
    lines.pop();
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Corrupt checkpoint file ${path}: line ${index + 1} is not JSON: ${(error as Error).message}`, { cause: error });
      }
      if (typeof value !== "string") {
        throw new Error(`Corrupt checkpoint file ${path}: line ${index + 1} is not a JSON string`);
      }
      store.#completed.add(value);
    }
    return store;
  }

  has(id: string): boolean {
    return this.#completed.has(id);
  }

  /** Records `id` as done. Resolves once it is appended; rejects, and leaves `has(id)` false, when it cannot be. */
  mark(id: string): Promise<void> {
    if (this.#completed.has(id)) return this.#appends;
    const appended = this.#appends.then(async () => {
      if (!this.#directoryMade) {
        await mkdir(dirname(this.#path), { recursive: true });
        this.#directoryMade = true;
      }
      await appendFile(this.#path, `${JSON.stringify(id)}\n`);
      this.#completed.add(id);
    });
    // The next append goes on after this one whether it worked or not; the caller of this one hears of a failure.
    this.#appends = appended.catch(() => undefined);
    return appended;
  }

  get size(): number {
    return this.#completed.size;
  }
}
