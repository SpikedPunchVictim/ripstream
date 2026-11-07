import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UnsupportedRuntimeError,
  createTempDirectory,
  detectRuntime,
  nowMillis,
  requireCapability,
  sha256Digest,
} from "../src/index.ts";

test("detects the runtime and capabilities", () => {
  const runtime = detectRuntime();
  assert.equal(runtime.runtime, "node");
  assert.equal(runtime.fetch, true);
  assert.equal(runtime.crypto, true);
  assert.equal(runtime.tempFiles, true);
  assert.match(runtime.version, /^\d+\./);
});

test("computes SHA-256 digests", async () => {
  assert.equal(
    await sha256Digest(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("creates temp directories and reports unsupported capabilities", async () => {
  const directory = await createTempDirectory("ripstream-runtime-");
  assert.match(directory, /ripstream-runtime-/);
  requireCapability("fetch");
  assert.throws(() => {
    const original = globalThis.fetch;
    // @ts-expect-error simulating a runtime without fetch
    delete globalThis.fetch;
    try {
      requireCapability("fetch");
    } finally {
      globalThis.fetch = original;
    }
  }, UnsupportedRuntimeError);
  assert.ok(nowMillis() >= 0);
});
