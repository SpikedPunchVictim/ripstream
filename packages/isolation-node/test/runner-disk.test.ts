import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { IsolationError, LimitExceededError } from "@spikedpunch/ripstream-core";
import { MemoryPool } from "../src/pool.ts";
import { ChildRunner, parentResultMb, type ChildRunnerOptions } from "../src/runner.ts";
import { DISK_CHILD } from "./fixtures/helpers.ts";

/** L6 through the runner: the budget and tempDir options, the default budget, and dispose with a call in flight. */

const root = mkdtempSync(join(tmpdir(), "ripstream-disk-runner-"));
after(() => rmSync(root, { recursive: true, force: true }));

const MIB = 1024 * 1024;
const CHILD_MB = 512;
const MAX_RESULT_BYTES = MIB;
const ONE_MB = CHILD_MB + parentResultMb(MAX_RESULT_BYTES, "text");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setup(args: readonly string[], overrides: Partial<ChildRunnerOptions> = {}) {
  const tempDir = mkdtempSync(join(root, "t-"));
  const pool = new MemoryPool({ poolMb: ONE_MB, overshootMb: 0, maxQueue: 2 });
  const runner = new ChildRunner({
    pool,
    childScript: DISK_CHILD,
    childArgs: args,
    perChildMb: CHILD_MB,
    heapMb: 128,
    cpuSecs: 30,
    maxTaskMillis: 20_000,
    maxInputBytes: MIB,
    maxResultBytes: MAX_RESULT_BYTES,
    rssLimitMb: CHILD_MB,
    tempDir,
    ...overrides,
  });
  return { tempDir, pool, runner };
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await sleep(10);
  }
}

test("a child over the disk budget is a LimitExceededError, its directory is gone and its lease is back", async () => {
  const { tempDir, pool, runner } = setup(["spool", "64", "hang"], { maxDiskMb: 5, diskPollMs: 20 });
  const error = await runner.run({ input: bytes("x") }).then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof LimitExceededError, String(error));
  assert.match(error.message, /temporary disk budget of 5 MiB exceeded/);
  await runner.dispose();
  assert.deepEqual(readdirSync(tempDir), []);
  assert.equal(pool.stats().freeMb, ONE_MB);
});

test("the default budget is 1024 MiB: the walk bound is still enforced under it, and the message says so", async () => {
  const { tempDir, runner } = setup(["many-files", "10001"], { diskPollMs: 20 });
  const error = await runner.run({ input: bytes("x") }).then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof LimitExceededError, String(error));
  assert.match(error.message, /temporary disk budget of 1024 MiB exceeded/);
  await runner.dispose();
  assert.deepEqual(readdirSync(tempDir), []);
});

test("dispose with a call in flight: the call is refused, the child is killed and its directory is gone when dispose returns", async () => {
  const { tempDir, pool, runner } = setup(["spool", "2", "hang"]);
  const running = runner.run({ input: bytes("x") }).then(() => undefined, (e: unknown) => e);
  // The child writes the nested file last, so by now everything it leaves behind is on disk.
  await until(() => {
    const [dir] = readdirSync(tempDir);
    return dir !== undefined && existsSync(join(tempDir, dir, "nested", "deep", "x.txt"));
  });
  await runner.dispose();
  assert.deepEqual(readdirSync(tempDir), [], "dispose waits for the child to be reaped AND its directory removed");
  const error = await running;
  assert.ok(error instanceof IsolationError && error.reason === "unavailable", String(error));
  assert.equal(pool.stats().freeMb, ONE_MB);
});

test("calls get separate directories under tempDir, so one call's files never reach another", async () => {
  const pool = new MemoryPool({ poolMb: ONE_MB * 2, overshootMb: 0, maxQueue: 2 });
  const { tempDir, runner } = setup(["tmpdir-report"], { pool });
  const reports = await Promise.all([runner.run({ input: bytes("a") }), runner.run({ input: bytes("b") })]);
  const dirs = reports.map((result) => (JSON.parse(result.kind === "text" ? result.text : "{}") as { tmpdir: string; files: string[] }));
  assert.notEqual(dirs[0]?.tmpdir, dirs[1]?.tmpdir);
  for (const seen of dirs) assert.deepEqual(seen.files, ["probe.txt"], "each directory started empty");
  assert.deepEqual(readdirSync(tempDir), []);
});

test("constructor: maxDiskMb must be a positive safe integer", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => setup(["spool"], { maxDiskMb: bad }), (error: unknown) => {
      return error instanceof RangeError && /maxDiskMb must be a positive safe integer/.test(error.message);
    }, String(bad));
  }
});

test("constructor: tempDir must be an absolute path to an existing directory", () => {
  assert.throws(() => setup(["spool"], { tempDir: "relative/dir" }), (error: unknown) => {
    return error instanceof TypeError && /tempDir must be an absolute path/.test(error.message);
  });
  assert.throws(() => setup(["spool"], { tempDir: "" }), (error: unknown) => error instanceof TypeError && /non-empty string/.test(error.message));
  assert.throws(() => setup(["spool"], { tempDir: 7 as unknown as string }), (error: unknown) => {
    return error instanceof TypeError && /tempDir must be a non-empty string/.test(error.message);
  });
  assert.throws(() => setup(["spool"], { tempDir: join(root, "missing") }), (error: unknown) => {
    return error instanceof RangeError && /tempDir must be an existing directory/.test(error.message);
  });
  const file = join(root, "a-file");
  writeFileSync(file, "x");
  assert.throws(() => setup(["spool"], { tempDir: file }), (error: unknown) => {
    return error instanceof RangeError && /not a directory/.test(error.message);
  });
});
