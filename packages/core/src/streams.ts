import { limitError, UnsupportedRuntimeError } from "./errors.ts";
import { safeFetch } from "./url-security.ts";
import type { ByteStream, InputSource } from "./content-handler.ts";

export interface StreamOptions {
  readonly signal?: AbortSignal;
  readonly allowUrl?: boolean;
}

export interface CollectOptions extends StreamOptions {
  readonly limit?: number;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReadableStream<Uint8Array>).getReader === "function"
  );
}

function isAsyncIterable(value: unknown): value is ByteStream {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  );
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  }
}

/**
 * Normalizes every supported input into the canonical chunk stream.
 * Node `Readable`, Blob, Web streams, and async iterables all converge here.
 */
export async function* toAsyncIterable(
  source: InputSource,
  options: StreamOptions = {},
): AsyncGenerator<Uint8Array> {
  checkAborted(options.signal);

  if (source instanceof Uint8Array) {
    yield source;
    return;
  }

  if (source instanceof ArrayBuffer) {
    yield new Uint8Array(source);
    return;
  }

  if (typeof Blob !== "undefined" && source instanceof Blob) {
    yield* toAsyncIterable(source.stream(), options);
    return;
  }

  if (isReadableStream(source)) {
    const reader = source.getReader();
    const onAbort = (): void => {
      void reader.cancel(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let finished = false;
    try {
      for (;;) {
        checkAborted(options.signal);
        const { done, value } = await reader.read();
        if (done) {
          // reader.cancel() on abort also surfaces as done:true; that is not EOF.
          checkAborted(options.signal);
          finished = true;
          return;
        }
        if (value !== undefined) yield value;
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      // A stream left unfinished (the consumer stopped, or the parse failed) is cancelled: unlocking alone leaves the
      // source open, and a `fetch` body keeps its connection.
      if (!finished) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  if (isAsyncIterable(source)) {
    // A source that never yields again would hold the parse past its timer: an abort must end the wait itself.
    const iterator = source[Symbol.asyncIterator]();
    let onAbort = (): void => undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = (): void => {
        try {
          checkAborted(options.signal);
        } catch (error) {
          reject(error);
        }
        // A Node stream is stopped with the wait: its read would otherwise stay open.
        if (typeof (source as { destroy?: unknown }).destroy === "function") {
          (source as unknown as { destroy(error?: Error): void }).destroy();
        }
      };
    });
    aborted.catch(() => undefined);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let finished = false;
    try {
      for (;;) {
        checkAborted(options.signal);
        const step = await Promise.race([iterator.next(), aborted]);
        if (step.done === true) {
          finished = true;
          return;
        }
        yield step.value;
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      // Not awaited: a generator stuck in its own await would hold this return as well.
      if (!finished) void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }

  if (typeof source === "object" && source !== null && "path" in source) {
    const { createReadStream } = await import("node:fs");
    const stream = createReadStream(
      source.path,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    yield* toAsyncIterable(stream, options);
    return;
  }

  if (typeof source === "object" && source !== null && "url" in source) {
    if (options.allowUrl !== true) {
      throw new UnsupportedRuntimeError(
        "URL inputs are disabled. Pass allowUrl: true or use the pipes HTTP fetcher.",
      );
    }
    const init: RequestInit =
      options.signal === undefined ? {} : { signal: options.signal };
    if (source.headers !== undefined) init.headers = source.headers;
    const response = await safeFetch(source.url, init);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${source.url}: ${response.status} ${response.statusText}`,
      );
    }
    if (response.body === null) return;
    yield* toAsyncIterable(response.body, options);
    return;
  }

  throw new TypeError("Unsupported input source");
}

/**
 * The size of `source` when it is known without reading it: bytes, an ArrayBuffer, a Blob, or a `{ path }` (stat'ed; an
 * unreadable path is `null`, so reading it reports the real error). `null` for streams and URLs.
 */
export async function declaredSize(source: InputSource): Promise<number | null> {
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) return source.byteLength;
  if (typeof Blob !== "undefined" && source instanceof Blob) return source.size;
  if (isReadableStream(source) || isAsyncIterable(source)) return null;
  if (typeof source === "object" && source !== null && "path" in source) {
    const { stat } = await import("node:fs/promises");
    try {
      return (await stat(source.path)).size;
    } catch {
      return null;
    }
  }
  return null;
}

export function toReadableStream(
  source: InputSource,
  options: StreamOptions = {},
): ReadableStream<Uint8Array> {
  const iterator = toAsyncIterable(source, options)[Symbol.asyncIterator]();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}

export async function toNodeReadable(
  source: InputSource,
  options: StreamOptions = {},
): Promise<import("node:stream").Readable> {
  const { Readable } = await import("node:stream");
  return Readable.from(toAsyncIterable(source, options));
}

export async function collect(
  source: InputSource,
  options: CollectOptions = {},
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of toAsyncIterable(source, options)) {
    total += chunk.byteLength;
    if (options.limit !== undefined && total > options.limit) {
      throw limitError(`Input exceeds ${options.limit} bytes`, "inputBytes", total, options.limit);
    }
    chunks.push(chunk);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
