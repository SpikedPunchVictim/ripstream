import assert from "node:assert/strict";
import { test } from "node:test";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import {
  OutputBudget,
  inflateBounded,
  limitOutput,
} from "../src/bounded-inflate.ts";
import { LimitExceededError } from "../src/errors.ts";

const bomb = Buffer.alloc(20 * 1024 * 1024);

test("inflates within limits for every format", () => {
  const data = Buffer.from("hello hello hello");
  const limits = { maxOutputBytes: 1024 };
  assert.deepEqual(Buffer.from(inflateBounded(gzipSync(data), "gzip", limits)), data);
  assert.deepEqual(Buffer.from(inflateBounded(deflateSync(data), "deflate", limits)), data);
  assert.deepEqual(Buffer.from(inflateBounded(deflateRawSync(data), "deflate-raw", limits)), data);
  assert.deepEqual(Buffer.from(inflateBounded(brotliCompressSync(data), "brotli", limits)), data);
});

test("rejects output over maxOutputBytes", () => {
  assert.throws(
    () => inflateBounded(gzipSync(bomb), "gzip", { maxOutputBytes: 1024 * 1024, maxRatio: 1e9 }),
    LimitExceededError,
  );
});

test("rejects output over the ratio limit", () => {
  assert.throws(
    () => inflateBounded(gzipSync(bomb), "gzip", { maxOutputBytes: 1 << 30, maxRatio: 100 }),
    LimitExceededError,
  );
});

test("rejects brotli bombs", () => {
  assert.throws(
    () => inflateBounded(brotliCompressSync(bomb), "brotli", { maxOutputBytes: 1 << 20 }),
    LimitExceededError,
  );
});

test("OutputBudget throws once the cap is crossed", () => {
  const budget = new OutputBudget(10, { maxOutputBytes: 100 });
  budget.add(100);
  assert.throws(() => budget.add(1), LimitExceededError);
});

test("limitOutput aborts a stream early", async () => {
  async function* source(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < 1000; i++) yield new Uint8Array(1024);
  }
  const budget = new OutputBudget(10, { maxOutputBytes: 4096 });
  await assert.rejects(async () => {
    for await (const _ of limitOutput(source(), budget)) void _;
  }, LimitExceededError);
  assert.ok(budget.produced < 10 * 1024);
});
