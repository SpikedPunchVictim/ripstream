import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type SafeFetchOptions, safeFetch } from "@spikedpunch/ripstream-core";
import type { FetchContext, FetchEmitTuple, Fetcher, PipesIterator } from "./tuple.ts";

/*
 * The fetchers and iterators ripstream has built in (Tika's file-system-fetcher, http-fetcher and
 * file-system-pipes-iterator). They are keyed and plain: a fetcher is asked for one key and returns its bytes, an
 * iterator lists tuples without reading any.
 */

/** Thrown when a client-supplied path escapes its configured root or crosses a symlink. */
export class PipesPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipesPathError";
  }
}

const escapes = (rel: string): boolean => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

export interface FileSystemFetcherOptions {
  /** Every key resolves under this directory and may not leave it. Needed unless `allowAbsolutePaths`. */
  readonly basePath?: string;
  /** Without a `basePath`, a key is a path to any file this process can read. Say so explicitly. */
  readonly allowAbsolutePaths?: boolean;
  /**
   * Refuse a file whose real path is outside `basePath`, which a symbolic link inside it can arrange. Tika always does.
   * Default true; false is for a trusted tree that links elsewhere on purpose.
   */
  readonly confineSymlinks?: boolean;
}

/** Tika's FileSystemFetcher: reads local files by path, under a base directory the keys cannot leave. */
export class FileSystemFetcher implements Fetcher {
  readonly #basePath: string | undefined;
  readonly #confineSymlinks: boolean;

  constructor(options: FileSystemFetcherOptions = {}) {
    const basePath = options.basePath === undefined || options.basePath.trim() === "" ? undefined : options.basePath;
    if (basePath === undefined) {
      if (options.allowAbsolutePaths !== true) {
        throw new RangeError(
          "FileSystemFetcher needs basePath, or allowAbsolutePaths true: without a basePath a key can name any file this process can read",
        );
      }
    } else {
      if (/^(?:https?|ftp|s3):\/\//i.test(basePath)) throw new RangeError(`FileSystemFetcher reads local directories only, not ${JSON.stringify(basePath)}`);
      if (basePath.includes("\u0000")) throw new RangeError("FileSystemFetcher basePath must not contain a NUL byte");
    }
    this.#basePath = basePath;
    this.#confineSymlinks = options.confineSymlinks ?? true;
  }

  async fetch(key: string, context: FetchContext): Promise<Uint8Array> {
    const path = await this.#pathFor(key);
    const bytes = await readFile(path, { signal: context.signal });
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** The validated local path of `key`: the same confinement as `fetch`, without reading the bytes. */
  async resolve(key: string): Promise<string> {
    return this.#pathFor(key);
  }

  async #pathFor(key: string): Promise<string> {
    if (key.includes("\u0000")) throw new PipesPathError("fetchKey must not contain a NUL byte");
    const base = this.#basePath;
    let path: string;
    if (base === undefined) {
      path = resolve(key);
    } else {
      const root = resolve(base);
      if (!(await stat(root).then((info) => info.isDirectory(), () => false))) throw new Error(`basePath is not a directory: ${root}`);
      path = resolve(root, key);
      // Lexical first, which needs no file to exist; then the real path, which a symlink can move.
      if (escapes(relative(root, path))) throw new PipesPathError(`fetchKey must resolve to a descendant of the basePath: ${key}`);
      if (this.#confineSymlinks) {
        const real = await realpath(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (real !== null && escapes(relative(await realpath(root), real))) {
          throw new PipesPathError(`fetchKey must resolve to a descendant of the basePath: ${key}`);
        }
      }
    }
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`not a regular file: ${key}`);
    return path;
  }
}

/** A URL that answered with a status that is not a success. `status` is what `isTransientError` reads to decide on a retry. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`Fetch failed: ${status} ${url}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

/** Tika's http-fetcher: reads a URL through the SSRF-safe fetch, so a URL that resolves to a private address is refused. */
export class HttpFetcher implements Fetcher {
  readonly #transport: Pick<SafeFetchOptions, "fetchImpl" | "lookupImpl">;

  /** `fetchImpl` and `lookupImpl` replace the network and the name lookup, as `safeFetch`'s do; every address is still checked. */
  constructor(transport: Pick<SafeFetchOptions, "fetchImpl" | "lookupImpl"> = {}) {
    this.#transport = transport;
  }

  async fetch(url: string, context: FetchContext): Promise<Uint8Array> {
    const response = await safeFetch(url, { signal: context.signal }, this.#transport);
    if (!response.ok) throw new HttpStatusError(response.status, url);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export interface FileSystemPipesIteratorOptions {
  readonly basePath: string;
  /** The `fetcher` of every tuple. */
  readonly fetcherId: string;
  /** The `emitter` of every tuple. Absent: the engine's default emitter. */
  readonly emitterId?: string;
  /**
   * What to do with a symbolic link. "fetch" (Tika's): give it a tuple and leave the fetcher to read it or refuse it.
   * "follow": walk through it as if it were what it points at. "skip": leave it out.
   */
  readonly symlinks?: "fetch" | "follow" | "skip";
}

/**
 * Tika's file-system-pipes-iterator: one tuple for every file under `basePath`, id and keys the path relative to it,
 * in name order. A root that cannot be listed throws. A directory or entry that cannot be read inside it gets a tuple
 * of its own, which the fetcher fails (Tika skips it without a word), so a gap in the walk is a result and not a silence.
 */
export class FileSystemPipesIterator implements PipesIterator {
  readonly #options: FileSystemPipesIteratorOptions;

  constructor(options: FileSystemPipesIteratorOptions) {
    this.#options = options;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<FetchEmitTuple> {
    const { basePath, fetcherId, emitterId } = this.#options;
    const symlinks = this.#options.symlinks ?? "fetch";
    const tuple = (path: string): FetchEmitTuple => {
      const key = relative(basePath, path).replace(/\\/g, "/");
      return { id: key, fetcher: fetcherId, fetchKey: key, ...(emitterId === undefined ? {} : { emitter: emitterId }) };
    };
    const walk = async function* (directory: string): AsyncGenerator<FetchEmitTuple> {
      let names: string[];
      try {
        names = (await readdir(directory)).sort();
      } catch (error) {
        if (directory === basePath) throw error;
        yield tuple(directory);
        return;
      }
      for (const name of names) {
        const path = join(directory, name);
        let info;
        try {
          info = await lstat(path);
          if (info.isSymbolicLink()) {
            if (symlinks === "skip") continue;
            if (symlinks === "follow") info = await stat(path);
          }
        } catch {
          yield tuple(path);
          continue;
        }
        if (info.isDirectory()) yield* walk(path);
        else yield tuple(path);
      }
    };
    yield* walk(basePath);
  }
}

/** One tuple for each URL, for an http-fetcher: the URL is the id and the key. */
export class UrlListPipesIterator implements PipesIterator {
  readonly #urls: readonly string[];
  readonly #fetcherId: string;

  constructor(urls: readonly string[], fetcherId: string) {
    this.#urls = urls;
    this.#fetcherId = fetcherId;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<FetchEmitTuple> {
    for (const url of this.#urls) yield { id: url, fetcher: this.#fetcherId, fetchKey: url };
  }
}
