import { LimitExceededError, UnsupportedRuntimeError } from "./errors.ts";
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
    try {
      for (;;) {
        checkAborted(options.signal);
        const { done, value } = await reader.read();
        if (done) {
          // reader.cancel() on abort also surfaces as done:true; that is not EOF.
          checkAborted(options.signal);
          return;
        }
        if (value !== undefined) yield value;
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  }

  if (isAsyncIterable(source)) {
    for await (const chunk of source) {
      checkAborted(options.signal);
      yield chunk;
    }
    return;
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
      throw new LimitExceededError(
        `Input exceeds ${options.limit} bytes`,
      );
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
