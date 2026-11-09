import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { IsolationError, LimitExceededError, type IsolatedParseResult } from "@spikedpunch/ripstream-core";
import type { InputHeader } from "../src/child-io.ts";
import { MemoryPool } from "../src/pool.ts";
import { ChildRunner, parentResultMb, type ChildRunnerOptions } from "../src/runner.ts";
import { CHILD } from "./fixtures/helpers.ts";

/** Per-run limits (RunLimits) replace the runner's defaults for one run and nothing else. */

const HEADER_CHILD = fileURLToPath(new URL("./fixtures/header-child.ts", import.meta.url));
const MIB = 1024 * 1024;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const roomyPool = (): MemoryPool => new MemoryPool({ poolMb: 16_384, overshootMb: 0, maxQueue: 4 });

function runner(script: string, mode: string, overrides: Partial<ChildRunnerOptions> = {}): ChildRunner {
  return new ChildRunner({
    pool: roomyPool(),
    childScript: script,
    childArgs: [mode],
    perChildMb: 512,
    heapMb: 128,
    cpuSecs: 30,
    maxTaskMillis: 10_000,
    maxInputBytes: MIB,
    maxResultBytes: MIB,
    rssLimitMb: 512,
    ...overrides,
  });
}

interface Report {
  readonly header: InputHeader;
  readonly execArgv: readonly string[];
  readonly bytes: number;
}

function report(result: IsolatedParseResult): Report {
  assert.equal(result.kind, "text");
  return JSON.parse((result as { text: string }).text) as Report;
}

test("without limits the runner's own heap is used and no parse timer is sent", async () => {
  const seen = report(await runner(HEADER_CHILD, "report").run({ input: bytes("x") }));
  assert.ok(seen.execArgv.includes("--max-old-space-size=128"), seen.execArgv.join(" "));
  assert.equal(seen.header.maxParseMillis, undefined);
});

test("limits.heapMb replaces the heap of this run only", async () => {
  const r = runner(HEADER_CHILD, "report");
  const first = report(await r.run({ input: bytes("x") }, { limits: { heapMb: 200 } }));
  assert.ok(first.execArgv.includes("--max-old-space-size=200"), first.execArgv.join(" "));
  const second = report(await r.run({ input: bytes("x") }));
  assert.ok(second.execArgv.includes("--max-old-space-size=128"), second.execArgv.join(" "));
});

test("limits.maxParseMillis reaches the child in the input header", async () => {
  const seen = report(await runner(HEADER_CHILD, "report").run({ input: bytes("x") }, { limits: { maxParseMillis: 1234 } }));
  assert.equal(seen.header.maxParseMillis, 1234);
});

test("limits.maxResultBytes is the cap of this run, up or down", async () => {
  const r = runner(CHILD, "result-cap"); // answers with about 200 KB
  assert.equal((await r.run({ input: bytes("x") })).kind, "text");
  await assert.rejects(r.run({ input: bytes("x") }, { limits: { maxResultBytes: 100_000 } }), LimitExceededError);
  const small = runner(CHILD, "result-cap", { maxResultBytes: 100_000 });
  await assert.rejects(small.run({ input: bytes("x") }), LimitExceededError);
  assert.equal((await small.run({ input: bytes("x") }, { limits: { maxResultBytes: MIB } })).kind, "text");
});

test("limits.maxFrameBytes is the frame cap of this run", async () => {
  const r = runner(CHILD, "giant-frame", { maxResultBytes: 4 * MIB }); // one text frame of 1 MiB + envelope
  await assert.rejects(r.run({ input: bytes("x") }), LimitExceededError);
  assert.equal((await r.run({ input: bytes("x") }, { limits: { maxFrameBytes: 2 * MIB } })).kind, "text");
});

test("limits.maxResultBytes sizes the parent's reservation of this run", async () => {
  // A pool that holds the child plus the default result memory exactly, and nothing more.
  const pool = new MemoryPool({ poolMb: 512 + parentResultMb(MIB, "text"), overshootMb: 0, maxQueue: 0 });
  const r = runner(CHILD, "echo", { pool });
  assert.equal((await r.run({ input: bytes("ok") })).kind, "text");
  await assert.rejects(
    r.run({ input: bytes("ok") }, { limits: { maxResultBytes: 64 * MIB } }),
    (error: unknown) => error instanceof IsolationError && error.reason === "unavailable",
  );
  assert.equal(pool.stats().running, 0);
});

test("limits are validated before anything is reserved or spawned", async () => {
  const pool = roomyPool();
  const r = runner(CHILD, "echo", { pool });
  for (const limits of [
    { heapMb: 512 }, // not below the RSS limit
    { heapMb: 600 },
    { heapMb: 0 },
    { heapMb: 1.5 },
    { maxResultBytes: 0 },
    { maxResultBytes: Number.NaN },
    { maxFrameBytes: -1 },
    { maxParseMillis: 0 },
  ]) {
    await assert.rejects(r.run({ input: bytes("x") }, { limits }), RangeError, JSON.stringify(limits));
  }
  assert.deepEqual([pool.stats().running, pool.stats().reservedMb], [0, 0]);
});
