import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  serializeRmeta,
  safeFetch,
  type Metadata,
  type ParseLimits,
  type ParseRecord,
  type Ripstream,
} from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";

export interface PipeDocument {
  readonly id: string;
  readonly data: Uint8Array;
  readonly metadata?: Readonly<Record<string, readonly string[]>>;
}

export interface Fetcher {
  fetch(): AsyncIterable<PipeDocument>;
}

export interface EmittedDocument {
  readonly id: string;
  readonly text?: string;
  readonly bytes?: Uint8Array;
  readonly metadata?: Readonly<Record<string, readonly string[]>>;
  readonly records?: readonly ParseRecord[];
}

export interface Emitter {
  emit(document: EmittedDocument): Promise<void> | void;
  close?(): Promise<void> | void;
}

/** What the engine calls to parse. A core Ripstream satisfies it, and so does an isolated one. */
export type PipesRipstream = Pick<Ripstream, "parse" | "parseRecursive">;

export type PipeMode =
  | "CONTENT_ONLY"
  | "CONCATENATE"
  | "RMETA"
  | "NO_PARSE"
  | "UNPACK";

export interface PipesEngineOptions {
  readonly fetcher: Fetcher;
  readonly emitter: Emitter;
  readonly mode?: PipeMode;
  readonly concurrency?: number;
  readonly maxQueue?: number;
  readonly ordered?: boolean;
  /**
   * Ordered mode only: maximum inputs in flight ahead of delivery (parsing or
   * parsed-but-undelivered). Defaults to `concurrency * 4`.
   */
  readonly maxBuffered?: number;
  readonly limits?: Partial<ParseLimits>;
  /**
   * Parses every document. Default: the standard in-process pipeline. A service that isolates parsing must pass
   * its isolated ripstream here, or the pipe bypasses the isolation boundary.
   */
  readonly ripstream?: PipesRipstream;
}

/** Bounded-concurrency pipe runner over a fetcher/emitter pair. */
export interface PipesStats {
  readonly fetched: number;
  readonly emitted: number;
  readonly failed: number;
  readonly durationMs: number;
}

export class PipesEngine {
  readonly #options: PipesEngineOptions;
  #stats: PipesStats = { fetched: 0, emitted: 0, failed: 0, durationMs: 0 };

  constructor(options: PipesEngineOptions) {
    this.#options = options;
  }

  get stats(): PipesStats {
    return this.#stats;
  }

  async run(): Promise<number> {
    const started = performance.now();
    let fetched = 0;
    let failed = 0;
    const mode = this.#options.mode ?? "CONTENT_ONLY";
    const concurrency = Math.max(1, this.#options.concurrency ?? 4);
    const maxQueue = Math.max(1, this.#options.maxQueue ?? 64);
    const ordered = this.#options.ordered ?? false;
    // Ordered delivery of CONCATENATE is inherent (indexed buffer, one final emit).
    const useSlots = ordered && mode !== "CONCATENATE";
    const windowSize = Math.max(1, this.#options.maxBuffered ?? concurrency * 4);
    const emitter = this.#options.emitter;
    const ripstream = this.#options.ripstream ?? createRipstream();
    const limits = this.#options.limits;
    const queue: Array<{ document: PipeDocument; index: number }> = [];
    const iterator = this.#options.fetcher.fetch()[Symbol.asyncIterator]();
    let fetchedDone = false;
    let filling: Promise<void> | null = null;
    let emitted = 0;
    const concatenated: string[] = [];

    const controller = new AbortController();
    const signal = controller.signal;

    // Ordered delivery: one slot per input, pushed in fetch order at dequeue time.
    // Workers fill their slot (parse in parallel); a single drainer emits the head
    // slot's documents, then pops it, so emit is serialized and strictly ordered.
    const slots: Slot[] = [];
    const wake = createNotifier(); // slot filled/pushed, producers done, or abort
    const windowGate = createNotifier(); // a slot was popped, or abort
    let producersDone = false;

    const fill = async (): Promise<void> => {
      while (!fetchedDone && queue.length < maxQueue) {
        const item = await iterator.next();
        if (item.done === true) {
          fetchedDone = true;
          break;
        }
        queue.push({ document: item.value, index: fetched++ });
      }
    };

    const next = async (): Promise<WorkItem | null> => {
      // No await between the final window/queue checks and the shift+push below,
      // so the slot window cannot be overshot by racing workers.
      for (;;) {
        if (signal.aborted) return null;
        if (useSlots && slots.length >= windowSize) {
          await windowGate.wait();
          continue;
        }
        if (queue.length > 0) break;
        if (fetchedDone) return null;
        await (filling ??= fill().finally(() => {
          filling = null;
        }));
      }
      const entry = queue.shift()!;
      if (!useSlots) return { ...entry, slot: null };
      const slot: Slot = { index: entry.index, docs: null };
      slots.push(slot);
      wake.notify();
      return { ...entry, slot };
    };

    // Turns one input into the documents to emit (zero for an empty UNPACK).
    const produce = async (document: PipeDocument): Promise<EmittedDocument[]> => {
      if (mode === "NO_PARSE") return [{ id: document.id, bytes: document.data }];
      if (mode === "RMETA" || mode === "UNPACK") {
        const records = await ripstream.parseRecursive(document.data, {
          filename: document.id,
          signal,
          ...(limits === undefined ? {} : { limits }),
        });
        if (mode === "UNPACK") {
          return records.map((record) => ({
            id: `${document.id}${record.embeddedResourcePath}`,
            text: record.content,
            records: [record],
          }));
        }
        return [{ id: document.id, text: serializeRmeta(records), records }];
      }
      const result = await ripstream.parse(document.data, {
        filename: document.id,
        signal,
        ...(limits === undefined ? {} : { limits }),
      });
      return [{ id: document.id, text: result.text, metadata: metadataObject(result.metadata) }];
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return;
        const item = await next();
        if (item === null) return;
        const docs = await produce(item.document);
        if (item.slot !== null) {
          item.slot.docs = docs;
          wake.notify();
        } else if (mode === "CONCATENATE") {
          concatenated[item.index] = docs[0]?.text ?? "";
          emitted++;
        } else {
          for (const doc of docs) await emitter.emit(doc);
          emitted++;
        }
      }
    };

    const drain = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return;
        const head = slots[0];
        if (head?.docs == null) {
          // Nothing to emit yet: wait for a fill/push, unless no producer is left.
          if (producersDone) return;
          await wake.wait();
          continue;
        }
        for (const doc of head.docs) {
          if (signal.aborted) return;
          await emitter.emit(doc);
        }
        if (slots.shift() !== head) throw new Error("ordered buffer corrupted");
        emitted++;
        windowGate.notify();
      }
    };

    // On the first failure, abort so siblings stop pulling new work and
    // in-flight parses cancel; wait for every worker and the drainer to settle,
    // then close the emitter (always) and rethrow the original error.
    let failure: { readonly error: unknown } | null = null;
    const guarded = async (task: () => Promise<void>): Promise<void> => {
      try {
        await task();
      } catch (error) {
        // Keep the chronologically first error; later ones are usually abort echoes.
        failure ??= { error };
        controller.abort(error);
        wake.notify();
        windowGate.notify();
      }
    };

    try {
      const workers = Promise.all(
        Array.from({ length: concurrency }, () => guarded(worker)),
      ).finally(() => {
        producersDone = true;
        wake.notify();
      });
      await Promise.all([workers, ...(useSlots ? [guarded(drain)] : [])]);
      if (failure !== null) {
        failed++;
        throw (failure as { readonly error: unknown }).error;
      }
      if (slots.length !== 0) throw new Error("ordered buffer not drained");
      if (mode === "CONCATENATE") {
        await emitter.emit({
          id: "concatenated",
          text: concatenated.filter((value) => value !== undefined).join(""),
        });
      }
    } finally {
      try {
        await emitter.close?.();
      } finally {
        this.#stats = {
          fetched,
          emitted,
          failed,
          durationMs: performance.now() - started,
        };
      }
    }
    return emitted;
  }
}

/** One input's place in the ordered-delivery FIFO; `docs` is null until parsed. */
interface Slot {
  readonly index: number;
  docs: EmittedDocument[] | null;
}

interface WorkItem {
  readonly document: PipeDocument;
  readonly index: number;
  readonly slot: Slot | null;
}

interface Notifier {
  wait(): Promise<void>;
  notify(): void;
}

/** Broadcast wake-up: notify() resolves every promise handed out by wait() so far. */
function createNotifier(): Notifier {
  let resolvers: Array<() => void> = [];
  return {
    wait: () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }),
    notify: () => {
      const pending = resolvers;
      resolvers = [];
      for (const resolve of pending) resolve();
    },
  };
}

export interface FileSystemFetcherOptions {
  /** Follow symbolic links while walking (default true). Set false for untrusted configs. */
  readonly followSymlinks?: boolean;
}

/** Recursive filesystem fetcher. */
export class FileSystemFetcher implements Fetcher {
  readonly #root: string;
  readonly #followSymlinks: boolean;

  constructor(root: string, options: FileSystemFetcherOptions = {}) {
    this.#root = root;
    this.#followSymlinks = options.followSymlinks ?? true;
  }

  async *fetch(): AsyncIterable<PipeDocument> {
    const root = this.#root;
    const followSymlinks = this.#followSymlinks;
    const walk = async function* (directory: string): AsyncIterable<PipeDocument> {
      for (const entry of (await readdir(directory)).sort()) {
        const path = join(directory, entry);
        const info = await (followSymlinks ? stat(path) : lstat(path));
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) yield* walk(path);
        else if (info.isFile()) {
          yield {
            id: relative(root, path).replace(/\\/g, "/"),
            data: new Uint8Array(await readFile(path)),
          };
        }
      }
    };
    yield* walk(root);
  }
}

/** Thrown when a client-supplied path escapes its configured root or crosses a symlink. */
export class PipesPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipesPathError";
  }
}

/**
 * Resolves a client-supplied relative path under a trusted root. Rejects absolute paths,
 * `..` escapes and any existing symlink along the path. The path itself need not exist.
 */
export async function resolveWithinRoot(root: string, requested: string): Promise<string> {
  if (requested.includes("\0")) throw new PipesPathError("Path contains a NUL byte");
  if (isAbsolute(requested) || /^[A-Za-z]:/.test(requested)) {
    throw new PipesPathError(`Absolute paths are not allowed: ${requested}`);
  }
  const realRoot = await realpath(root);
  const target = resolve(realRoot, requested);
  const rel = relative(realRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PipesPathError(`Path escapes the configured root: ${requested}`);
  }
  let current = realRoot;
  for (const part of rel === "" ? [] : rel.split(sep)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new PipesPathError(`Symbolic links are not allowed: ${requested}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

/** HTTP fetcher using SSRF-safe fetch. */
export class HttpFetcher implements Fetcher {
  readonly #urls: readonly string[];

  constructor(urls: string | readonly string[]) {
    this.#urls = typeof urls === "string" ? [urls] : urls;
  }

  async *fetch(): AsyncIterable<PipeDocument> {
    for (const url of this.#urls) {
      const response = await safeFetch(url);
      if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${url}`);
      yield { id: url, data: new Uint8Array(await response.arrayBuffer()) };
    }
  }
}

/** Collects emitted documents in memory (tests and embedded use). */
export class MemoryEmitter implements Emitter {
  readonly documents: EmittedDocument[] = [];
  async emit(document: EmittedDocument): Promise<void> {
    this.documents.push(document);
  }
}

/** Writes text or JSON metadata files under a directory. */
export class FileSystemEmitter implements Emitter {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async emit(document: EmittedDocument): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    // Ids that need sanitizing get a short stable hash of the RAW id appended so
    // distinct ids ("a/b", "a_b") can never collide on one file. Filesystem-safe
    // ids keep their exact name. Deliberate output-contract change for unsafe ids.
    const safe = document.id.replace(/[^A-Za-z0-9._-]+/g, "_");
    const name =
      safe === document.id
        ? safe || "document"
        : `${safe || "document"}-${createHash("sha1").update(document.id).digest("hex").slice(0, 8)}`;
    if (document.bytes !== undefined) {
      await writeFile(join(this.#directory, `${name}.bin`), document.bytes);
    } else if (document.text !== undefined) {
      await writeFile(join(this.#directory, `${name}.txt`), document.text);
    }
  }
}

/** JSON configuration for filesystem → filesystem pipes. */
export interface PipesConfig {
  readonly mode?: PipeMode;
  readonly concurrency?: number;
  readonly maxQueue?: number;
  readonly ordered?: boolean;
  readonly source: { readonly type: "filesystem" | "http"; readonly path?: string; readonly urls?: readonly string[] };
  readonly sink?: { readonly type: "filesystem"; readonly path: string };
  /** Follow symlinks when reading a filesystem source (default true). */
  readonly followSymlinks?: boolean;
}

export function createEngine(config: PipesConfig, options: { readonly ripstream?: PipesRipstream } = {}): PipesEngine {
  const fetcher =
    config.source.type === "http"
      ? new HttpFetcher(config.source.urls ?? [])
      : new FileSystemFetcher(config.source.path ?? ".", {
          followSymlinks: config.followSymlinks ?? true,
        });
  const emitter =
    config.sink === undefined
      ? new MemoryEmitter()
      : new FileSystemEmitter(config.sink.path);
  return new PipesEngine({
    fetcher,
    emitter,
    mode: config.mode ?? "CONTENT_ONLY",
    concurrency: config.concurrency ?? 4,
    maxQueue: config.maxQueue ?? 64,
    ordered: config.ordered ?? false,
    ...(options.ripstream === undefined ? {} : { ripstream: options.ripstream }),
  });
}

/** Embedded API wrapper around the pipe engine. */
export class PipesClient {
  readonly #config: PipesConfig;
  readonly #ripstream: PipesRipstream | undefined;

  constructor(config: PipesConfig, options: { readonly ripstream?: PipesRipstream } = {}) {
    this.#config = config;
    this.#ripstream = options.ripstream;
  }

  async run(): Promise<{ count: number; stats: PipesStats }> {
    const engine = createEngine(this.#config, this.#ripstream === undefined ? {} : { ripstream: this.#ripstream });
    const count = await engine.run();
    return { count, stats: engine.stats };
  }
}

function metadataObject(metadata: Metadata): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = {};
  for (const name of metadata.names()) result[name] = metadata.getAll(name);
  return result;
}
export { CheckpointStore, withRetry } from "./resilience.ts";
export { CompositeEmitter, CompositeReporter, CsvFetcher, HttpEmitter, JsonFetcher, JsonlEmitter, JsonlReporter, LoggingReporter, ModuleEmitter, ModuleFetcher, StdoutEmitter, type Reporter } from "./adapters.ts";
