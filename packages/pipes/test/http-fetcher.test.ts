import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError } from "@spikedpunch/ripstream-core";
import { HttpFetcher, HttpStatusError, isTransientError } from "../src/index.ts";

/*
 * What a URL can make a run spend: the bytes it sends, the time it takes to send them, and the connection it holds when
 * its answer is not one that is read.
 */

const lookupImpl = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;
const context = (signal = new AbortController().signal) => ({ signal });

/** A body of `chunks` chunks of `size` bytes, counting the chunks that were pulled and whether it was cancelled. */
function body(chunks: number, size: number): { stream: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) {
        controller.close();
        return;
      }
      pulled++;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

const serving = (response: () => Response): typeof fetch => (async () => response()) as typeof fetch;

test("a body within the cap is read whole", async () => {
  const fetcher = new HttpFetcher({ fetchImpl: serving(() => new Response("hello world")), lookupImpl, maxBytes: 11 });
  assert.equal(new TextDecoder().decode(await fetcher.fetch("http://a.example/", context())), "hello world");
});

test("a body over the cap is refused as it arrives, and the rest is not read", async () => {
  const served = body(1000, 1024);
  const fetcher = new HttpFetcher({ fetchImpl: serving(() => new Response(served.stream)), lookupImpl, maxBytes: 10 * 1024 });
  await assert.rejects(fetcher.fetch("http://a.example/", context()), LimitExceededError);
  assert.ok(served.pulled() < 20, `pulled ${served.pulled()} chunks`);
  assert.equal(served.cancelled(), true);
});

test("a declared length over the cap is refused before the body is read", async () => {
  const served = body(10, 1024);
  const fetcher = new HttpFetcher({
    fetchImpl: serving(() => new Response(served.stream, { headers: { "content-length": String(50 * 1024 * 1024) } })),
    lookupImpl,
    maxBytes: 1024,
  });
  await assert.rejects(fetcher.fetch("http://a.example/", context()), LimitExceededError);
  assert.ok(served.pulled() <= 1, "no more than the stream's own first fill");
  assert.equal(served.cancelled(), true);
});

test("without a cap of its own the fetcher still has one", async () => {
  const served = body(1, 8);
  const fetcher = new HttpFetcher({
    fetchImpl: serving(() => new Response(served.stream, { headers: { "content-length": String(2 ** 40) } })),
    lookupImpl,
  });
  await assert.rejects(fetcher.fetch("http://a.example/", context()), LimitExceededError);
});

test("a body that never finishes is ended at the timeout, and the timeout may be tried again", async () => {
  const stalled = new ReadableStream<Uint8Array>({ start: () => undefined });
  const fetcher = new HttpFetcher({ fetchImpl: serving(() => new Response(stalled)), lookupImpl, timeoutMs: 100 });
  const keepAlive = setInterval(() => undefined, 1000);
  try {
    const failure = await fetcher.fetch("http://a.example/", context()).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /timed out after 100 ms/);
    assert.equal(isTransientError(failure), true);
  } finally {
    clearInterval(keepAlive);
  }
});

test("a run that is stopped ends the fetch with its own reason, not as a timeout", async () => {
  const stalled = new ReadableStream<Uint8Array>({ start: () => undefined });
  const fetcher = new HttpFetcher({ fetchImpl: serving(() => new Response(stalled)), lookupImpl, timeoutMs: 60_000 });
  const run = new AbortController();
  setTimeout(() => run.abort(new Error("run ended")), 30);
  const keepAlive = setInterval(() => undefined, 1000);
  try {
    await assert.rejects(fetcher.fetch("http://a.example/", context(run.signal)), /run ended/);
  } finally {
    clearInterval(keepAlive);
  }
});

test("an answer that is not a success is released, not left holding its connection", async () => {
  const served = body(10, 16);
  const fetcher = new HttpFetcher({ fetchImpl: serving(() => new Response(served.stream, { status: 500 })), lookupImpl });
  await assert.rejects(fetcher.fetch("http://a.example/", context()), HttpStatusError);
  assert.equal(served.cancelled(), true);
});

test("a timeout of any source is a failure that may not happen again", () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(isTransientError(timeout), true);
  assert.equal(isTransientError(new Error("Azure Blob GET timed out after 5 ms", { cause: timeout })), true);
  assert.equal(isTransientError(new DOMException("aborted", "AbortError")), false);
});
