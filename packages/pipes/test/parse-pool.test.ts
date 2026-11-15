import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MalformedDocumentError, MediaType, RipstreamConfig, RipstreamConfigError } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { WorkerParsePool, workerExecArgv, workerStackSizeMb, type WorkerParsePoolOptions } from "../src/parse-pool.ts";
import { MAX_WORKERS, autoWorkerCount, createParsePool } from "../src/workers.ts";

const SCRIPTED = new URL("./workers/scripted.ts", import.meta.url);
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const scratch = await mkdtemp(join(tmpdir(), "ripstream-pool-test-"));
after(() => rm(scratch, { recursive: true, force: true }));

async function withPool<T>(options: Partial<WorkerParsePoolOptions>, body: (pool: WorkerParsePool) => Promise<T>): Promise<T> {
  const pool = await WorkerParsePool.start({ spec: {}, size: 1, entry: SCRIPTED, tempRoot: scratch, ...options });
  try {
    return await body(pool);
  } finally {
    await pool.close();
  }
}

test("a pool parses on its workers as a ripstream in this thread does", async () => {
  const pool = await createParsePool({ workers: 2 });
  try {
    const local = createRipstream();
    const input = bytes("<html><head><title>T</title></head><body><p>hello</p></body></html>");
    const options = { filename: "page.html" };
    const [pooled, inProcess] = [await pool.parse(input, options), await local.parse(input, options)];
    assert.equal(pooled.text, inProcess.text);
    assert.deepEqual(pooled.metadata.names(), inProcess.metadata.names());
    const records = await pool.parseRecursive(input, options);
    const expected = await local.parseRecursive(input, options);
    assert.equal(records.length, expected.length);
    assert.equal(records[0]!.content, expected[0]!.content);
    assert.ok(records[0]!.mediaType.equals(expected[0]!.mediaType));
    assert.equal(String(await pool.detect(bytes("%PDF-1.4\n"))), String(await local.detect(bytes("%PDF-1.4\n"))));
  } finally {
    await pool.close();
  }
});

test("each worker parses one document at a time, taking them in the order they came", async () => {
  await withPool({ size: 2 }, async (pool) => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => pool.parse(bytes(String(index)), { filename: "wait:40" })));
    const byThread = new Map<string, { begun: number; ended: number }[]>();
    for (const result of results) {
      const runs = byThread.get(result.metadata.get("thread")!) ?? [];
      runs.push({ begun: Number(result.metadata.get("begun")), ended: Number(result.metadata.get("ended")) });
      byThread.set(result.metadata.get("thread")!, runs);
    }
    assert.equal(byThread.size, 2);
    for (const runs of byThread.values()) {
      for (let index = 1; index < runs.length; index += 1) assert.ok(runs[index]!.begun >= runs[index - 1]!.ended);
    }
    const begun = results.map((result) => Number(result.metadata.get("begun")));
    for (let index = 2; index < begun.length; index += 1) assert.ok(begun[index]! >= begun[index - 2]!);
  });
});

test("a parse that fails rejects with the error's class", async () => {
  await withPool({}, async (pool) => {
    await assert.rejects(pool.parse(bytes("x"), { filename: "malformed:broken" }), (error: unknown) => {
      assert.ok(error instanceof MalformedDocumentError);
      assert.equal(error.message, "scripted: broken");
      return true;
    });
    assert.equal((await pool.parse(bytes("x"), { filename: "echo:after" })).text, "after");
  });
});

test("parseRecursive records cross with their media types, exceptions and bytes", async () => {
  await withPool({}, async (pool) => {
    const records = await pool.parseRecursive(bytes("x"), { filename: "echo:root" });
    assert.equal(records[0]!.content, "root");
    assert.ok(records[1]!.mediaType.equals(new MediaType("text", "plain", { charset: 'x;y="z"' })));
    assert.ok(records[1]!.exception instanceof MalformedDocumentError);
    assert.deepEqual([...records[1]!.bytes!], [2, 3]);
  });
});

test("the caller's bytes are left as they were", async () => {
  await withPool({}, async (pool) => {
    const input = bytes("abcdef");
    const result = await pool.parse(input.subarray(1, 4), { filename: "echo:x" });
    assert.equal(result.metadata.get("bytes"), "3");
    assert.equal(new TextDecoder().decode(input), "abcdef");
  });
});

test("a result the worker cannot copy back fails that parse only", async () => {
  await withPool({}, async (pool) => {
    await assert.rejects(pool.parseRecursive(bytes("x"), { filename: "uncloneable" }), (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, "DataCloneError");
      return true;
    });
    assert.equal((await pool.parse(bytes("x"), { filename: "echo:still" })).text, "still");
  });
});

test("an input or a password the pool cannot send is refused before it reaches a worker", async () => {
  await withPool({}, async (pool) => {
    await assert.rejects(pool.parse(new Blob(["x"]) as never), TypeError);
    await assert.rejects(pool.parse(bytes("x"), { password: (() => "p") as never }), TypeError);
  });
});

test("a worker that cannot build its ripstream fails the start with why", async () => {
  const control = join(scratch, "init-control");
  await import("node:fs/promises").then((fs) => fs.writeFile(control, "init"));
  process.env["SCRIPTED_CONTROL"] = control;
  try {
    await assert.rejects(WorkerParsePool.start({ spec: {}, size: 2, entry: SCRIPTED, tempRoot: scratch }), RipstreamConfigError);
  } finally {
    delete process.env["SCRIPTED_CONTROL"];
  }
});

test("a configuration the workers cannot build from rejects as it would in-process", async () => {
  const config = new RipstreamConfig({ customMimeTypes: join(scratch, "no-such-custom-mimetypes.xml") });
  let expected: unknown;
  try {
    createRipstream({ config });
  } catch (error) {
    expected = error;
  }
  assert.ok(expected instanceof Error);
  await assert.rejects(createParsePool({ workers: 2, config }), (error: unknown) => {
    assert.equal((error as Error).constructor, (expected as Error).constructor);
    assert.equal((error as Error).message, (expected as Error).message);
    return true;
  });
});

test("the number of workers is a whole number from 1 to 64", async () => {
  for (const workers of [0, MAX_WORKERS + 1, 1.5, Number.NaN]) {
    await assert.rejects(createParsePool({ workers }), RangeError);
  }
});

test("auto sizing takes a worker per CPU, at most 8, within half the memory at 256 MB each, and no pool under 2", () => {
  const gib = 1024 ** 3;
  assert.equal(autoWorkerCount({ availableParallelism: 16, memoryBytes: 64 * gib }), 8);
  assert.equal(autoWorkerCount({ availableParallelism: 4, memoryBytes: 64 * gib }), 4);
  assert.equal(autoWorkerCount({ availableParallelism: 16, memoryBytes: 1.5 * gib }), 3);
  assert.equal(autoWorkerCount({ availableParallelism: 1, memoryBytes: 64 * gib }), 0);
  assert.equal(autoWorkerCount({ availableParallelism: 16, memoryBytes: 0.75 * gib }), 0);
  const here = autoWorkerCount();
  assert.ok(here === 0 || (here >= 2 && here <= 8));
});

test("a worker's stack is sized to recurse about as deep as this thread", () => {
  assert.equal(workerStackSizeMb([]), 1.17);
  assert.equal(workerStackSizeMb(["--stack-size=1968"]), 2.34);
  assert.equal(workerStackSizeMb(["--stack-size", "1968"]), 2.34);
  assert.equal(workerStackSizeMb(["--stack-size=nonsense"]), 1.17);
});

test("a worker keeps only the parent's module-resolution and warning flags", () => {
  assert.deepEqual(
    workerExecArgv([
      "--import",
      "some-preload",
      "--conditions=development",
      "-C",
      "custom",
      "--max-old-space-size=4096",
      "--no-warnings",
      "--require",
      "preload.cjs",
      "--stack-size=2000",
      "--inspect",
      "--disable-warning",
      "ExperimentalWarning",
    ]),
    ["--conditions=development", "-C", "custom", "--no-warnings", "--disable-warning", "ExperimentalWarning"],
  );
});

test("each worker runs under the derived stack size", async () => {
  await withPool({ size: 2 }, async (pool) => {
    assert.equal(pool.limits.length, 2);
    for (const limits of pool.limits) assert.ok(Math.abs((limits.stackSizeMb ?? 0) - workerStackSizeMb(process.execArgv)) < 0.01);
  });
});
