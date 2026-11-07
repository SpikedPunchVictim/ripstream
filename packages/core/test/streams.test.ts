import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { LimitExceededError, UnsupportedRuntimeError } from "../src/errors.ts";
import { collect, toAsyncIterable, toReadableStream } from "../src/streams.ts";

async function* chunks(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1, 2]);
  yield new Uint8Array([3]);
}

test("collects async iterables", async () => {
  assert.deepEqual(await collect(chunks()), new Uint8Array([1, 2, 3]));
});

test("accepts Uint8Array and ArrayBuffer", async () => {
  assert.deepEqual(await collect(new Uint8Array([4, 5])), new Uint8Array([4, 5]));
  assert.deepEqual(
    await collect(new Uint8Array([6, 7]).buffer),
    new Uint8Array([6, 7]),
  );
});

test("accepts Node Readable", async () => {
  const stream = Readable.from([Buffer.from("ab"), Buffer.from("cd")]);
  assert.deepEqual(Buffer.from(await collect(stream)), Buffer.from("abcd"));
});

test("accepts Web ReadableStream", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([8]));
      controller.enqueue(new Uint8Array([9]));
      controller.close();
    },
  });
  assert.deepEqual(await collect(stream), new Uint8Array([8, 9]));
});

test("accepts Blob", async () => {
  assert.deepEqual(Buffer.from(await collect(new Blob(["hello"]))), Buffer.from("hello"));
});

test("collect enforces a byte limit", async () => {
  await assert.rejects(collect(chunks(), { limit: 2 }), LimitExceededError);
});

test("URL inputs are opt-in", async () => {
  await assert.rejects(
    collect({ url: "https://example.com" }),
    UnsupportedRuntimeError,
  );
});

test("toReadableStream preserves chunk order", async () => {
  const reader = toReadableStream(chunks()).getReader();
  const received: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received.push(...value);
  }
  assert.deepEqual(received, [1, 2, 3]);
});

test("abort signal is honored between chunks", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(
    collect(toAsyncIterable(chunks(), { signal: controller.signal })),
    /stop/,
  );
});

test("aborting a pending web stream read rejects instead of ending cleanly", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1]));
    },
  });
  const pending = collect(stream, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("stop")), 10);
  await assert.rejects(pending, /stop/);
});
