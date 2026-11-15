import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  AbortError,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  ParseTimeoutError,
  RipstreamConfig,
  RipstreamConfigError,
} from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { MemoryEmitter, PipesEngine, PipesFatalError, statusForParseError } from "../src/index.ts";
import { WorkerParsePool, crashErrorFor, workerExecArgv, workerStackSizeMb, type WorkerParsePoolOptions } from "../src/parse-pool.ts";
import { MAX_WORKERS, autoWorkerCount, createParsePool } from "../src/workers.ts";
import { fileSystem } from "./helpers.ts";

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
  await writeFile(control, "init");
  process.env["SCRIPTED_CONTROL"] = control;
  try {
    await assert.rejects(WorkerParsePool.start({ spec: {}, size: 2, entry: SCRIPTED, tempRoot: scratch }), RipstreamConfigError);
    assert.deepEqual((await readdir(scratch)).filter((name) => name.startsWith("ripstream-workers-")), []);
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

// ---- lifecycle ---------------------------------------------------------------------------------------------------

const FAST = { graceMs: 150, spawnBackoffMs: 10 } as const;
const thread = (result: { metadata: { get(name: string): string | null } }): string => result.metadata.get("thread")!;

/** Every path under a directory. */
async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true }).catch(() => [] as string[]);
  return entries.map((entry) => join(directory, entry));
}

async function until(condition: () => Promise<boolean>, what: string, millis = 10_000): Promise<void> {
  const deadline = Date.now() + millis;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a parse stuck in synchronous code is stopped by the watchdog as a timeout, and its worker replaced", async () => {
  await withPool(FAST, async (pool) => {
    const before = thread(await pool.parse(bytes("x"), { filename: "echo:x" }));
    const begun = Date.now();
    await assert.rejects(pool.parse(bytes("x"), { filename: "spin", limits: { maxParseMillis: 100 } }), ParseTimeoutError);
    assert.ok(Date.now() - begun < 5_000);
    const after = thread(await pool.parse(bytes("x"), { filename: "echo:x" }));
    assert.notEqual(after, before);
  });
});

test("a maxParseMillis near the largest timer delay does not fire the watchdog at once", async () => {
  await withPool(FAST, async (pool) => {
    const result = await pool.parse(bytes("x"), { filename: "wait:300", limits: { maxParseMillis: 2 ** 31 - 2 } });
    assert.equal(result.metadata.get("bytes"), "1");
  });
});

test("maxParseMillis 0 sets no watchdog", async () => {
  await withPool(FAST, async (pool) => {
    const result = await pool.parse(bytes("x"), { filename: "wait:400", limits: { maxParseMillis: 0 } });
    assert.equal(result.metadata.get("bytes"), "1");
  });
});

test("a stuck parse's spooled input is removed with its worker, and close removes the rest", async () => {
  const root = await mkdtemp(join(scratch, "spill-"));
  const pool = await WorkerParsePool.start({ spec: {}, size: 1, entry: SCRIPTED, tempRoot: root, ...FAST });
  const spooled = async (): Promise<boolean> => (await walk(root)).some((path) => /[/\\]ripstream-(?!workers-)[^/\\]+$/.test(path));
  try {
    const input = new Uint8Array(2 * 1024 * 1024).fill(65);
    const stuck = pool.parse(input, { filename: "spill", limits: { maxParseMillis: 300 } });
    await until(spooled, "the input to be spooled");
    await assert.rejects(stuck, ParseTimeoutError);
    await pool.parse(bytes("x"), { filename: "echo:x" });
    assert.equal(await spooled(), false);
  } finally {
    await pool.close();
  }
  assert.deepEqual(await walk(root), []);
});

test("an abort answers the caller at once with the error an in-process parse gives, and the worker goes back to the pool", async () => {
  await withPool(FAST, async (pool) => {
    const before = thread(await pool.parse(bytes("x"), { filename: "echo:x" }));
    const controller = new AbortController();
    const running = pool.parse(bytes("x"), { filename: "hang", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(running, AbortError);
    assert.equal(thread(await pool.parse(bytes("x"), { filename: "echo:x" })), before);
  });
});

test("an abort's reason is mapped as ParseContext maps it", async () => {
  await withPool(FAST, async (pool) => {
    const timeout = new AbortController();
    const timed = pool.parse(bytes("x"), { filename: "hang", signal: timeout.signal });
    timeout.abort(new DOMException("slow", "TimeoutError"));
    await assert.rejects(timed, ParseTimeoutError);
    const reason = new RangeError("the caller's own reason");
    const custom = new AbortController();
    const parse = pool.parse(bytes("x"), { filename: "hang", signal: custom.signal });
    custom.abort(reason);
    await assert.rejects(parse, (error: unknown) => error === reason);
    await assert.rejects(pool.parse(bytes("x"), { signal: AbortSignal.abort() }), AbortError);
  });
});

test("a worker that does not act on an abort is terminated after the grace and replaced", async () => {
  await withPool(FAST, async (pool) => {
    const before = thread(await pool.parse(bytes("x"), { filename: "echo:x" }));
    const controller = new AbortController();
    const stuck = pool.parse(bytes("x"), { filename: "spin", limits: { maxParseMillis: 0 }, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(stuck, AbortError);
    assert.notEqual(thread(await pool.parse(bytes("x"), { filename: "echo:x" })), before);
  });
});

test("a queued parse that is aborted never runs", async () => {
  await withPool(FAST, async (pool) => {
    const first = pool.parse(bytes("x"), { filename: "wait:200" });
    const controller = new AbortController();
    const queued = pool.parse(bytes("x"), { filename: "exit:7", signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, AbortError);
    const firstThread = thread(await first);
    assert.equal(thread(await pool.parse(bytes("x"), { filename: "echo:x" })), firstThread);
  });
});

test("a worker that crashes fails its parse as a crash, and the next parse runs on a new worker", async () => {
  await withPool(FAST, async (pool) => {
    for (const filename of ["exit:3", "uncaught"]) {
      await assert.rejects(pool.parse(bytes("x"), { filename }), (error: unknown) => {
        assert.ok(error instanceof IsolationError, String(error));
        assert.equal(error.reason, "crash");
        assert.equal(statusForParseError(error), "UNSPECIFIED_CRASH");
        return true;
      });
      assert.equal((await pool.parse(bytes("x"), { filename: "echo:next" })).text, "next");
    }
  });
});

test("a stray rejection after a parse answered takes its worker down, and the pool replaces it", async () => {
  await withPool(FAST, async (pool) => {
    const stray = await pool.parse(bytes("x"), { filename: "stray:20" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const next = await pool.parse(bytes("x"), { filename: "echo:x" });
    assert.notEqual(thread(next), thread(stray));
  });
});

test("a worker that runs out of memory fails its parse as a limit, best effort", () => {
  const death = Object.assign(new Error("Worker terminated due to reaching memory limit: JS heap out of memory"), {
    code: "ERR_WORKER_OUT_OF_MEMORY",
  });
  const error = crashErrorFor(death, { maxOldGenerationSizeMb: 512 });
  assert.ok(error instanceof LimitExceededError);
  assert.equal(statusForParseError(error), "PAYLOAD_LIMIT_EXCEEDED");
  assert.match(error.message, /512 MB/);
});

test("a worker that breaks the protocol fails that parse as a crash and is replaced", async () => {
  await withPool({ ...FAST, entry: new URL("./workers/rogue.ts", import.meta.url) }, async (pool) => {
    for (const run of [
      () => pool.parse(bytes("x"), { filename: "wrong-id" }),
      () => pool.parse(bytes("x"), { filename: "garbage" }),
      () => pool.parseRecursive(bytes("x"), { filename: "bad-media" }),
    ]) {
      const before = thread(await pool.parse(bytes("x"), { filename: "fine" }));
      await assert.rejects(run(), (error: unknown) => error instanceof IsolationError && error.reason === "crash");
      assert.notEqual(thread(await pool.parse(bytes("x"), { filename: "fine" })), before);
    }
  });
});

test("a worker that fails to start is tried again, and the pool goes on once one starts", async () => {
  const control = join(scratch, "retry-control");
  await writeFile(control, "throw:0");
  process.env["SCRIPTED_CONTROL"] = control;
  try {
    await withPool(FAST, async (pool) => {
      await writeFile(control, "throw:2");
      await assert.rejects(pool.parse(bytes("x"), { filename: "exit:1" }), IsolationError);
      assert.equal((await pool.parse(bytes("x"), { filename: "echo:back" })).text, "back");
      assert.equal(await readFile(control, "utf8"), "throw:0");
    });
  } finally {
    delete process.env["SCRIPTED_CONTROL"];
  }
});

test("a pool that cannot replace a worker fails, and every parse after rejects with a PipesFatalError", async () => {
  const control = join(scratch, "fatal-control");
  await writeFile(control, "throw:0");
  process.env["SCRIPTED_CONTROL"] = control;
  try {
    await withPool(FAST, async (pool) => {
      await writeFile(control, "throw:99");
      const crashed = pool.parse(bytes("x"), { filename: "exit:1" });
      const queued = pool.parse(bytes("x"), { filename: "echo:x" });
      await assert.rejects(crashed, IsolationError);
      await assert.rejects(queued, PipesFatalError);
      await assert.rejects(pool.parse(bytes("x"), { filename: "echo:x" }), PipesFatalError);
    });
  } finally {
    delete process.env["SCRIPTED_CONTROL"];
  }
});

test("a replacement that cannot build its ripstream fails the pool at once", async () => {
  const control = join(scratch, "init-respawn-control");
  await writeFile(control, "throw:0");
  process.env["SCRIPTED_CONTROL"] = control;
  try {
    await withPool({ graceMs: 150, spawnBackoffMs: 60_000 }, async (pool) => {
      await writeFile(control, "init");
      await assert.rejects(pool.parse(bytes("x"), { filename: "exit:1" }), IsolationError);
      // A backoff of a minute: only a failure that is not retried can answer within the test's time.
      await assert.rejects(pool.parse(bytes("x"), { filename: "echo:x" }), (error: unknown) => {
        assert.ok(error instanceof PipesFatalError);
        assert.ok((error.cause as Error).cause instanceof RipstreamConfigError);
        return true;
      });
    });
  } finally {
    delete process.env["SCRIPTED_CONTROL"];
  }
});

test("a run whose pool fails ends with the PipesFatalError, not a result per input", async () => {
  const directory = await mkdtemp(join(scratch, "engine-"));
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(directory, name), name);
  const fatal = new PipesFatalError("the parse pool could not replace a worker");
  const results: string[] = [];
  const engine = new PipesEngine({
    ...fileSystem(directory),
    emitter: new MemoryEmitter(),
    mode: "CONTENT_ONLY",
    ripstream: {
      parse: async () => {
        throw fatal;
      },
      parseRecursive: async () => {
        throw fatal;
      },
      detect: async () => MediaType.OCTET_STREAM,
    },
    reporter: { report: (result) => void results.push(result.status) },
  });
  await assert.rejects(engine.run(), (error: unknown) => error === fatal);
  assert.deepEqual(results, []);
});

test("close rejects what is queued and running, stops stuck workers within its bound, and refuses later parses", async () => {
  const pool = await WorkerParsePool.start({ spec: {}, size: 1, entry: SCRIPTED, tempRoot: scratch, ...FAST });
  const running = assert.rejects(pool.parse(bytes("x"), { filename: "spin", limits: { maxParseMillis: 0 } }), /closed/);
  const queued = assert.rejects(pool.parse(bytes("x"), { filename: "echo:x" }), /closed/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const begun = Date.now();
  const closing = pool.close();
  assert.equal(pool.close(), closing);
  await closing;
  assert.ok(Date.now() - begun < 5_500);
  await running;
  await queued;
  await assert.rejects(pool.parse(bytes("x")), /closed/);
});

// ---- descriptors -------------------------------------------------------------------------------------------------

/**
 * The descriptors this process has open. Worker threads share the process's table, so a worker that is terminated
 * holding a file open leaks it here. /dev/fd lists them on Linux (a link to /proc/self/fd) and on macOS; the one the
 * listing itself opens is in every count.
 */
const openDescriptors = (): number => readdirSync("/dev/fd").length;

/** The handles and requests keeping the process alive, by type (timers are unref'd, so only what a leak would add shows). */
function activeResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of process.getActiveResourcesInfo()) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

/** The count settles a moment after a worker exits (its loop closes its handles), so it is read until it is not above the limit. */
async function settledDescriptors(limit: number): Promise<number> {
  let count = openDescriptors();
  for (let attempt = 0; attempt < 50 && count > limit; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    count = openDescriptors();
  }
  return count;
}

const CYCLES = 6;
const DESCRIPTOR_SLACK = 2;

test("workers terminated by the watchdog or by an abort leave no descriptor, listener or handle behind", async () => {
  const data = join(scratch, "big.bin");
  await writeFile(data, new Uint8Array(3 * 1024 * 1024).fill(66));
  const big = new Uint8Array(2 * 1024 * 1024).fill(65);
  const root = await mkdtemp(join(scratch, "fd-"));

  /** One way to end a worker; each runs a parse that has a file open, and ends with the worker terminated. */
  const ways: readonly (readonly [string, (pool: WorkerParsePool) => Promise<unknown>])[] = [
    ["the watchdog, with spooled input open", (pool) => assert.rejects(pool.parse(big, { filename: "spill", limits: { maxParseMillis: 100 } }), ParseTimeoutError)],
    ["the watchdog, with a path open", (pool) => assert.rejects(pool.parse({ path: data }, { filename: "holdspin", limits: { maxParseMillis: 100 } }), ParseTimeoutError)],
    [
      "an abort the worker ignores, with a path open",
      async (pool) => {
        const controller = new AbortController();
        const stuck = pool.parse({ path: data }, { filename: "holdspin", limits: { maxParseMillis: 0 }, signal: controller.signal });
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(stuck, AbortError);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      },
    ],
    [
      "an abort the worker acts on, with a path open",
      async (pool) => {
        const controller = new AbortController();
        const running = pool.parse({ path: data }, { filename: "hold", limits: { maxParseMillis: 0 }, signal: controller.signal });
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(running, AbortError);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      },
    ],
    ["a worker that exits under its parse", (pool) => assert.rejects(pool.parse(big, { filename: "exit:3" }), IsolationError)],
  ];

  const cycle = async (): Promise<void> => {
    const pool = await WorkerParsePool.start({ spec: {}, size: 2, entry: SCRIPTED, tempRoot: root, ...FAST });
    try {
      for (const [, way] of ways) await way(pool);
      // Every way above retires a worker (the cooperative abort excepted); the pool must be whole again.
      await pool.parse(bytes("x"), { filename: "echo:x" });
    } finally {
      await pool.close();
    }
  };

  // One cycle first, so what the runtime opens once (a kqueue, a signal pipe) is in the baseline.
  await cycle();
  const baseline = openDescriptors();
  const resources = activeResources();
  for (let index = 0; index < CYCLES; index += 1) await cycle();
  const after = await settledDescriptors(baseline + DESCRIPTOR_SLACK);
  assert.ok(after <= baseline + DESCRIPTOR_SLACK, `${CYCLES * ways.length} terminated workers left ${after - baseline} descriptors open (${baseline} before, ${after} after)`);
  assert.deepEqual(activeResources(), resources);
  assert.deepEqual(await walk(root), []);
});

test("an idle pool that is never closed does not keep the process alive", async () => {
  const script = `
    import { createParsePool } from ${JSON.stringify(new URL("../src/workers.ts", import.meta.url).href)};
    const pool = await createParsePool({ workers: 2 });
    await pool.parse(new TextEncoder().encode("hello"), { filename: "a.txt" });
    console.log("parsed");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /parsed/);
});
