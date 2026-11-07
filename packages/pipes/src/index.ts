import { lstat, readFile, readdir, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  serializeRmeta,
  safeFetch,
  type Metadata,
  type ParseLimits,
  type ParseRecord,
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
  readonly limits?: Partial<ParseLimits>;
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
    const ripstream = createRipstream();
    const limits = this.#options.limits;
    const queue: Array<{ document: PipeDocument; index: number }> = [];
    const iterator = this.#options.fetcher.fetch()[Symbol.asyncIterator]();
    let fetchedDone = false;
    let filling: Promise<void> | null = null;
    let emitted = 0;
    const concatenated: string[] = [];

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

    const next = async (): Promise<{ document: PipeDocument; index: number } | null> => {
      if (queue.length > 0) return queue.shift()!;
      if (fetchedDone) return null;
      filling ??= fill().finally(() => {
        filling = null;
      });
      await filling;
      return queue.shift() ?? null;
    };

    let nextIndex = 0;
    const buffered = new Map<number, EmittedDocument>();
    const deliver = async (
      index: number,
      document: EmittedDocument,
    ): Promise<void> => {
      if (!ordered) {
        await this.#options.emitter.emit(document);
        return;
      }
      buffered.set(index, document);
      while (buffered.has(nextIndex)) {
        await this.#options.emitter.emit(buffered.get(nextIndex)!);
        buffered.delete(nextIndex);
        nextIndex++;
      }
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        const item = await next();
        if (item === null) return;
        const document = item.document;
        const index = item.index;
        if (mode === "NO_PARSE") {
          await deliver(index, { id: document.id, bytes: document.data });
        } else if (mode === "RMETA" || mode === "UNPACK") {
          const records = await ripstream.parseRecursive(document.data, {
            filename: document.id,
            ...(limits === undefined ? {} : { limits }),
          });
          if (mode === "UNPACK") {
            for (const record of records) {
              await deliver(index, {
                id: `${document.id}${record.embeddedResourcePath}`,
                text: record.content,
                records: [record],
              });
            }
          } else {
            await deliver(index, {
              id: document.id,
              text: serializeRmeta(records),
              records,
            });
          }
        } else {
          const result = await ripstream.parse(document.data, {
            filename: document.id,
            ...(limits === undefined ? {} : { limits }),
          });
          const metadata = metadataObject(result.metadata);
          if (mode === "CONCATENATE") concatenated[index] = result.text;
          else {
            await deliver(index, {
              id: document.id,
              text: result.text,
              metadata,
            });
          }
        }
        emitted++;
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } catch (error) {
      failed++;
      throw error;
    } finally {
      this.#stats = {
        fetched,
        emitted,
        failed,
        durationMs: performance.now() - started,
      };
    }
    if (mode === "CONCATENATE") {
      await this.#options.emitter.emit({
        id: "concatenated",
        text: concatenated.filter((value) => value !== undefined).join(""),
      });
    }
    await this.#options.emitter.close?.();
    return emitted;
  }
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
    const name = `${document.id.replace(/[^A-Za-z0-9._-]+/g, "_") || "document"}`;
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

export function createEngine(config: PipesConfig): PipesEngine {
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
  });
}

/** Embedded API wrapper around the pipe engine. */
export class PipesClient {
  readonly #config: PipesConfig;

  constructor(config: PipesConfig) {
    this.#config = config;
  }

  async run(): Promise<{ count: number; stats: PipesStats }> {
    const engine = createEngine(this.#config);
    const count = await engine.run();
    return { count, stats: engine.stats };
  }
}

function metadataObject(metadata: Metadata): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = {};
  for (const name of metadata.names()) result[name] = metadata.getAll(name);
  return result;
}
export { WorkerPool } from "./pool.ts";
export { CheckpointStore, withRetry } from "./resilience.ts";
export { CompositeEmitter, CompositeReporter, CsvFetcher, HttpEmitter, JsonFetcher, JsonlEmitter, JsonlReporter, LoggingReporter, ModuleEmitter, ModuleFetcher, StdoutEmitter, type Reporter } from "./adapters.ts";
