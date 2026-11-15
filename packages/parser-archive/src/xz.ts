import { createRequire } from "node:module";
import { MissingDependencyError } from "@spikedpunch/ripstream-core";

export type XzConstructor = new (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;

interface XzModule {
  readonly default?: { readonly XzReadableStream?: XzConstructor };
  readonly XzReadableStream?: XzConstructor;
}

/**
 * An XzReadableStream class of its own for one document, or undefined when the library has none.
 *
 * xz-decompress (0.2.3) keeps its WASM instance and a mutex that serializes decodes as statics of the class, and the
 * mutex is not released when a failing decode cannot dispose its context (a trapped instance): every later decode in
 * the process, embedded ones included, then waits for it for good, on a trapped instance that is used again. The
 * statics belong to the module, so the module is taken out of the require cache and loaded again for each document: a
 * new module is a new class, instance and mutex, and what one document breaks stays with that document. The cost is
 * decoding the library's inline WASM again, a few milliseconds.
 */
export function loadXzReadableStream(require: NodeJS.Require = createRequire(import.meta.url)): XzConstructor | undefined {
  let entry: string;
  try {
    entry = require.resolve("xz-decompress");
  } catch {
    // A package that is not installed next to this code (a bundle without it) is not a corrupt file.
    throw new MissingDependencyError("xz-decompress", "XZ decompression");
  }
  delete require.cache[entry];
  try {
    const module = require("xz-decompress") as XzModule;
    return module.default?.XzReadableStream ?? module.XzReadableStream;
  } finally {
    // Not kept for the next document, and not kept alive by the cache either.
    delete require.cache[entry];
  }
}
