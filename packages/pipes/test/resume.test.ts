import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "@spikedpunch/ripstream-core";
import {
  CheckpointStore,
  FileSystemEmitter,
  HttpFetcher,
  MemoryEmitter,
  PipesEngine,
  createEngineFromSettings,
  type Checkpoint,
  type Emitter,
  type Fetcher,
  type PipeDocument,
  type PipeFetchFailure,
  type PipesResult,
} from "../src/index.ts";
import { fileSystem, storedZip } from "./helpers.ts";

/*
 * A run that can be started again (`checkpoint`) and a fetch or emit that is tried again (`retry`).
 */

async function scratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-resume-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `doc-${String(i).padStart(2, "0")}.txt`);

function writeInputs(directory: string, count: number): string[] {
  const input = join(directory, "in");
  mkdirSync(input, { recursive: true });
  for (const name of names(count)) writeFileSync(join(input, name), `content of ${name}`);
  return names(count);
}

/** A fetcher over a directory that says what it was asked for. */
function counting(fetchers: ReturnType<typeof fileSystem>["fetchers"]): { fetchers: NonNullable<typeof fetchers>; keys: string[] } {
  const keys: string[] = [];
  const real = fetchers!.fs!;
  return {
    keys,
    fetchers: {
      fs: {
        async fetch(key, context) {
          keys.push(key);
          return real.fetch(key, context);
        },
      } satisfies Fetcher,
    },
  };
}

const coded = (code: string): Error => Object.assign(new Error(`${code}: connection problem`), { code });

test("an input the checkpoint holds is not fetched, parsed or emitted, and is counted as resumed", () =>
  scratch(async (directory) => {
    const all = writeInputs(directory, 5);
    const checkpoint = await CheckpointStore.open(join(directory, "checkpoint.jsonl"));
    await checkpoint.mark(all[0]!);
    await checkpoint.mark(all[2]!);
    const emitter = new MemoryEmitter();
    const { fetchers, keys } = counting(fileSystem(join(directory, "in")).fetchers);
    const engine = new PipesEngine({ ...fileSystem(join(directory, "in")), fetchers, emitter, checkpoint });
    assert.equal(await engine.run(), 3);
    assert.deepEqual(keys.sort(), [all[1], all[3], all[4]]);
    assert.deepEqual(emitter.documents.map((d) => d.id).sort(), [all[1], all[3], all[4]]);
    assert.equal(engine.stats.resumed, 2);
    assert.equal(engine.stats.fetched, 3, "fetched is what this run went on with");
    assert.equal(checkpoint.size, 5, "what this run did is recorded too");
  }));

test("a second run of a finished run does nothing", () =>
  scratch(async (directory) => {
    writeInputs(directory, 4);
    const path = join(directory, "checkpoint.jsonl");
    const first = new PipesEngine({ ...fileSystem(join(directory, "in")), emitter: new MemoryEmitter(), checkpoint: await CheckpointStore.open(path) });
    assert.equal(await first.run(), 4);
    const emitter = new MemoryEmitter();
    const second = new PipesEngine({ ...fileSystem(join(directory, "in")), emitter, checkpoint: await CheckpointStore.open(path) });
    assert.equal(await second.run(), 0);
    assert.equal(emitter.documents.length, 0);
    assert.equal(second.stats.resumed, 4);
    assert.deepEqual(second.stats.byStatus, {});
  }));

test("only an input that succeeded is recorded: a failure is run again by the next run", () =>
  scratch(async (directory) => {
    const input = join(directory, "in");
    mkdirSync(input);
    writeFileSync(join(input, "good.txt"), "fine");
    writeFileSync(join(input, "broken.zip"), Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 1, 2, 3));
    const path = join(directory, "checkpoint.jsonl");
    const checkpoint = await CheckpointStore.open(path);
    const emitter: Emitter = {
      async emit(document) {
        if (document.id === "good.txt") throw new Error("disk full");
      },
    };
    // good.txt fails to emit; broken.zip is a parse exception skipped on purpose, which is a success.
    const first = new PipesEngine({ ...fileSystem(input), emitter, mode: "RMETA", onParseException: "SKIP", checkpoint });
    await first.run();
    assert.deepEqual(first.stats.byStatus, { EMIT_EXCEPTION: 1, PARSE_EXCEPTION_NO_EMIT: 1 });
    assert.equal(checkpoint.has("good.txt"), false);
    assert.equal(checkpoint.has("broken.zip"), true);
    const emitted = new MemoryEmitter();
    const second = new PipesEngine({ ...fileSystem(input), emitter: emitted, mode: "RMETA", onParseException: "SKIP", checkpoint: await CheckpointStore.open(path) });
    await second.run();
    assert.deepEqual(emitted.documents.map((d) => d.id), ["good.txt"]);
    assert.equal(second.stats.resumed, 1);
  }));

test("an input is recorded after it is reported: a reporter that fails leaves it to be done and reported again", () =>
  scratch(async (directory) => {
    const all = writeInputs(directory, 4);
    const path = join(directory, "checkpoint.jsonl");
    const checkpoint = await CheckpointStore.open(path);
    const seen: Array<[string, boolean]> = [];
    const first = new PipesEngine({
      ...fileSystem(join(directory, "in")),
      emitter: new MemoryEmitter(),
      concurrency: 1,
      checkpoint,
      reporter: {
        report(result: PipesResult) {
          seen.push([result.id, checkpoint.has(result.id)]);
          if (result.id === all[2]) throw new Error("audit log unavailable");
        },
      },
    });
    await assert.rejects(first.run(), /audit log unavailable/);
    assert.deepEqual(seen.map(([, marked]) => marked), [false, false, false], "not recorded while it is being reported");
    const resumed = await CheckpointStore.open(path);
    assert.equal(resumed.has(all[0]!), true);
    assert.equal(resumed.has(all[1]!), true);
    assert.equal(resumed.has(all[2]!), false, "its report never completed, so the next run reports it");
  }));

test("a checkpoint that cannot record ends the run with its error: resuming that was promised is not silently lost", () =>
  scratch(async (directory) => {
    writeInputs(directory, 3);
    const checkpoint: Checkpoint = {
      has: () => false,
      mark() {
        return Promise.reject(new Error("no space left on device"));
      },
    };
    const engine = new PipesEngine({ ...fileSystem(join(directory, "in")), emitter: new MemoryEmitter(), concurrency: 1, checkpoint });
    await assert.rejects(engine.run(), /no space left on device/);
  }));

test("ordered runs resume the same way, and record in fetch order", () =>
  scratch(async (directory) => {
    const all = writeInputs(directory, 6);
    const path = join(directory, "checkpoint.jsonl");
    const checkpoint = await CheckpointStore.open(path);
    await checkpoint.mark(all[1]!);
    const emitter = new MemoryEmitter();
    const engine = new PipesEngine({ ...fileSystem(join(directory, "in")), emitter, ordered: true, concurrency: 3, checkpoint });
    await engine.run();
    assert.deepEqual(emitter.documents.map((d) => d.id), [all[0], ...all.slice(2)]);
    assert.deepEqual(readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [all[1], all[0], ...all.slice(2)]);
  }));

test("documents that arrive with their bytes (`source`) resume too", async () => {
  const done = new Set(["b.txt"]);
  const emitter = new MemoryEmitter();
  const engine = new PipesEngine({
    source: {
      async *fetch() {
        for (const id of ["a.txt", "b.txt", "c.txt"]) yield { id, data: new TextEncoder().encode(id) } satisfies PipeDocument;
      },
    },
    emitter,
    checkpoint: { has: (id) => done.has(id), mark: (id) => void done.add(id) },
  });
  await engine.run();
  assert.deepEqual(emitter.documents.map((d) => d.id).sort(), ["a.txt", "c.txt"]);
  assert.equal(engine.stats.resumed, 1);
  assert.deepEqual([...done].sort(), ["a.txt", "b.txt", "c.txt"]);
});

test("a checkpoint or a retry that is not one is refused when the engine is made", () => {
  const options = { source: { async *fetch() {} }, emitter: new MemoryEmitter() };
  assert.throws(() => new PipesEngine({ ...options, checkpoint: {} as Checkpoint }), /checkpoint must have has\(id\) and mark\(id\)/);
  assert.throws(() => new PipesEngine({ ...options, retry: { attempts: 0 } }), /retry.attempts must be a positive integer/);
  assert.throws(() => new PipesEngine({ ...options, retry: { baseDelayMs: -1 } }), /retry.baseDelayMs/);
  assert.throws(() => new PipesEngine({ ...options, retry: { retryIf: "yes" as never } }), /retry.retryIf must be a function/);
});

// -- retry ----------------------------------------------------------------------------------------------------------

const FAST = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 } as const;

function flakyFetcher(failures: Error[], calls: { count: number }): Fetcher {
  return {
    async fetch() {
      calls.count++;
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      return new TextEncoder().encode("fetched");
    },
  };
}

function oneTuple(fetcher: Fetcher, emitter: Emitter, extra: Partial<ConstructorParameters<typeof PipesEngine>[0]> = {}): PipesEngine {
  return new PipesEngine({
    iterator: (async function* () {
      yield { id: "x.txt", fetcher: "f", fetchKey: "x.txt" };
    })(),
    fetchers: { f: fetcher },
    emitter,
    ...extra,
  });
}

test("retry: a fetch that failed in a way that passes is tried again, and the input is emitted once", async () => {
  const calls = { count: 0 };
  const emitter = new MemoryEmitter();
  const engine = oneTuple(flakyFetcher([coded("ECONNRESET"), coded("ETIMEDOUT")], calls), emitter, { retry: FAST });
  assert.equal(await engine.run(), 1);
  assert.equal(calls.count, 3);
  assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 1 });
  assert.equal(emitter.documents.length, 1);
});

test("retry: a fetch that keeps failing is FETCH_EXCEPTION with the last failure after the tries there were", async () => {
  const calls = { count: 0 };
  const failures = [coded("ECONNRESET"), coded("ECONNRESET"), coded("ECONNREFUSED"), coded("EPIPE")];
  const engine = oneTuple(flakyFetcher(failures, calls), new MemoryEmitter(), { retry: FAST });
  await engine.run();
  assert.equal(calls.count, 3);
  assert.deepEqual(engine.stats.byStatus, { FETCH_EXCEPTION: 1 });
});

test("retry: a failure that would be the same again is not tried again", async () => {
  const calls = { count: 0 };
  const engine = oneTuple(flakyFetcher([coded("ENOENT")], calls), new MemoryEmitter(), { retry: FAST });
  await engine.run();
  assert.equal(calls.count, 1);
  assert.deepEqual(engine.stats.byStatus, { FETCH_EXCEPTION: 1 });
});

test("retry: retryIf says which failures are tried again", async () => {
  const calls = { count: 0 };
  const odd = new Error("the catalogue is rebuilding");
  const engine = oneTuple(flakyFetcher([odd, odd], calls), new MemoryEmitter(), { retry: { ...FAST, retryIf: (error) => /rebuilding/.test(String(error)) } });
  await engine.run();
  assert.equal(calls.count, 3);
  assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 1 });
});

test("without `retry` a failed fetch is the input's result at once", async () => {
  const calls = { count: 0 };
  const engine = oneTuple(flakyFetcher([coded("ECONNRESET")], calls), new MemoryEmitter());
  await engine.run();
  assert.equal(calls.count, 1);
  assert.deepEqual(engine.stats.byStatus, { FETCH_EXCEPTION: 1 });
});

test("retry: an emit that failed in a way that passes is tried again", async () => {
  const documents: string[] = [];
  let attempts = 0;
  const emitter: Emitter = {
    async emit(document) {
      if (++attempts === 1) throw coded("EBUSY");
      documents.push(document.id);
    },
  };
  const engine = oneTuple(flakyFetcher([], { count: 0 }), emitter, { retry: FAST });
  await engine.run();
  assert.deepEqual(documents, ["x.txt"]);
  assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 1 });
});

test("retry: each document of an UNPACK input is tried on its own, so one that was emitted is not emitted again", async () => {
  const input = storedZip({ "one.txt": "first", "two.txt": "second" });
  const emitted: string[] = [];
  let failedOnce = false;
  const emitter: Emitter = {
    async emit(document) {
      if (document.id.endsWith("-embed/2") && !failedOnce) {
        failedOnce = true;
        throw coded("EBUSY");
      }
      emitted.push(document.id);
    },
  };
  const engine = new PipesEngine({
    iterator: (async function* () {
      yield { id: "outer.zip", fetcher: "f", fetchKey: "outer.zip" };
    })(),
    fetchers: { f: { fetch: async () => input } },
    emitter,
    mode: "UNPACK",
    unpack: { outputFormat: "REGULAR" },
    retry: FAST,
  });
  await engine.run();
  assert.deepEqual(emitted, ["outer.zip", "outer.zip-embed/1", "outer.zip-embed/2"]);
  assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 1 });
});

test("retry: an emit that would fail the same way again, a file that is there, is not tried again", async () => {
  await scratch(async (directory) => {
    const output = join(directory, "out");
    mkdirSync(output);
    writeFileSync(join(output, "x.txt.txt"), "already");
    let attempts = 0;
    const files = new FileSystemEmitter({ basePath: output, fileExtension: "txt" });
    const emitter: Emitter = {
      async emit(document) {
        attempts++;
        await files.emit(document);
      },
    };
    const engine = oneTuple(flakyFetcher([], { count: 0 }), emitter, { retry: FAST });
    await engine.run();
    assert.equal(attempts, 1);
    assert.deepEqual(engine.stats.byStatus, { EMIT_EXCEPTION: 1 });
  });
});

test("retry: a document that arrives with its bytes from a source is not fetched again, so its failure is its own", async () => {
  const failure: PipeFetchFailure = { id: "https://example.test/x", error: coded("ECONNRESET") };
  const results: PipesResult[] = [];
  const engine = new PipesEngine({
    source: { async *fetch() { yield failure; } },
    emitter: new MemoryEmitter(),
    retry: FAST,
    reporter: { report: (result) => void results.push(result) },
  });
  await engine.run();
  assert.equal(results[0]?.status, "FETCH_EXCEPTION");
  assert.match(results[0]?.message ?? "", /ECONNRESET: connection problem/, "not 'no longer held'");
});

test("retry: an abort during a backoff is not held up by it", async () => {
  const calls = { count: 0 };
  const failing: Emitter = { emit() { throw new Error("the emitter cannot go on"); } };
  const fetcher = flakyFetcher(Array.from({ length: 10 }, () => coded("ECONNRESET")), calls);
  const engine = new PipesEngine({
    iterator: (async function* () {
      yield { id: "slow", fetcher: "f", fetchKey: "slow" };
      yield { id: "ok", fetcher: "g", fetchKey: "ok" };
    })(),
    fetchers: { f: fetcher, g: { fetch: async () => new TextEncoder().encode("ok") } },
    emitters: { e: failing },
    emitter: failing,
    concurrency: 2,
    retry: { attempts: 5, baseDelayMs: 60_000, maxDelayMs: 60_000 },
    // A reporter that throws ends the run; the worker that is in a 30-60 s backoff must not hold the run up.
    reporter: { report() { throw new Error("audit log unavailable"); } },
  });
  const started = performance.now();
  await assert.rejects(engine.run(), /audit log unavailable/);
  assert.ok(performance.now() - started < 10_000, "the run ended without waiting out the backoff");
});

test("retry: the http-fetcher's 503 is tried again, its 404 is not", async () => {
  const lookupImpl = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;
  for (const [status, tries, outcome] of [[503, 3, { EMIT_SUCCESS: 1 }], [404, 1, { FETCH_EXCEPTION: 1 }]] as const) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls < 3 || status === 404 ? new Response("no", { status }) : new Response("page");
    }) as unknown as typeof fetch;
    const engine = new PipesEngine({
      iterator: (async function* () {
        yield { id: "page", fetcher: "http", fetchKey: "http://example.test/page" };
      })(),
      fetchers: { http: new HttpFetcher({ fetchImpl, lookupImpl }) },
      emitter: new MemoryEmitter(),
      retry: FAST,
    });
    await engine.run();
    assert.equal(calls, tries, String(status));
    assert.deepEqual(engine.stats.byStatus, outcome, String(status));
  }
});

// -- kill and resume ------------------------------------------------------------------------------------------------

const CHILD = join(import.meta.dirname, "resume-child.ts");

/** Starts the child run, waits until it says it is stuck, kills it with SIGKILL, and says how it ended. */
async function killAtHang(args: string[]): Promise<{ signal: NodeJS.Signals | null; stdout: string }> {
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("HANG")) resolve();
    });
    child.once("exit", () => reject(new Error(`the child ended without stopping where it was asked to:\n${stdout}`)));
  });
  child.kill("SIGKILL");
  return { signal: await exited, stdout };
}

async function resumeAfterKill(
  directory: string,
  where: "emit" | "report",
  onExists: "EXCEPTION" | "SKIP" | "REPLACE",
): Promise<{ engine: PipesEngine; fetched: string[]; all: string[]; checkpoint: string; output: string }> {
  const all = writeInputs(directory, 8);
  const input = join(directory, "in");
  const output = join(directory, "out");
  const checkpoint = join(directory, "checkpoint.jsonl");
  const hangAt = all[3]!;
  const killed = await killAtHang([input, output, checkpoint, hangAt, where, onExists]);
  assert.equal(killed.signal, "SIGKILL");
  assert.doesNotMatch(killed.stdout, /DONE/);
  // What the dead run left: four inputs done and recorded (0 to 2 and, for a stop at the emit, none of the fourth).
  assert.deepEqual(
    readFileSync(checkpoint, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    all.slice(0, 3),
  );
  const { fetchers, keys } = counting(fileSystem(input).fetchers);
  const engine = new PipesEngine({
    ...fileSystem(input),
    fetchers,
    emitter: new FileSystemEmitter({ basePath: output, fileExtension: "txt", onExists }),
    mode: "CONTENT_ONLY",
    checkpoint: await CheckpointStore.open(checkpoint),
  });
  await engine.run();
  return { engine, fetched: keys, all, checkpoint, output };
}

test("kill -9 in the middle of a run, then run again: the rest is done, what was done is not, nothing is written twice", () =>
  scratch(async (directory) => {
    const { engine, fetched, all, checkpoint, output } = await resumeAfterKill(directory, "emit", "EXCEPTION");
    assert.equal(engine.stats.resumed, 3);
    assert.deepEqual(fetched.sort(), all.slice(3), "the three that were done are not fetched again");
    assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 5 });
    assert.deepEqual(readdirSync(output).sort(), all.map((name) => `${name}.txt`));
    for (const name of all) assert.match(readFileSync(join(output, `${name}.txt`), "utf8"), new RegExp(`content of ${name}`));
    assert.equal((await CheckpointStore.open(checkpoint)).size, 8);
  }));

test("kill -9 after an input was emitted and before it was recorded: onExists REPLACE and SKIP do it again cleanly", async () => {
  for (const onExists of ["REPLACE", "SKIP"] as const) {
    await scratch(async (directory) => {
      const { engine, fetched, all, checkpoint, output } = await resumeAfterKill(directory, "report", onExists);
      assert.equal(engine.stats.resumed, 3, onExists);
      assert.deepEqual(fetched.sort(), all.slice(3), onExists);
      assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 5 }, onExists);
      assert.equal(readdirSync(output).length, 8, onExists);
      assert.equal((await CheckpointStore.open(checkpoint)).size, 8, onExists);
    });
  }
});

test("kill -9 after an input was emitted and before it was recorded: with onExists EXCEPTION that one input fails visibly and is left for the next run", () =>
  scratch(async (directory) => {
    const { engine, all, checkpoint, output } = await resumeAfterKill(directory, "report", "EXCEPTION");
    // The documented edge: Tika's default refuses a second write of the file, so the in-doubt input is a result, not a silent overwrite.
    assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 4, EMIT_EXCEPTION: 1 });
    assert.equal(readFileSync(join(output, `${all[3]}.txt`), "utf8").trim(), `content of ${all[3]}`, "its first, whole file is as it was");
    const store = await CheckpointStore.open(checkpoint);
    assert.equal(store.has(all[3]!), false);
    assert.equal(store.size, 7);
  }));

test("an engine built from a Tika configuration takes the checkpoint and the retry it is given", () =>
  scratch(async (directory) => {
    const input = join(directory, "in");
    mkdirSync(input);
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(input, name), `content of ${name}`);
    const settings = loadConfig({
      fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
      emitters: { fse: { "file-system-emitter": { basePath: join(directory, "out"), fileExtension: "json", onExists: "REPLACE" } } },
      "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
    }).pipes!;
    const checkpoint = await CheckpointStore.open(join(directory, "done.jsonl"));
    const first = createEngineFromSettings(settings, { checkpoint });
    await first.run();
    assert.equal(first.stats.emitted, 3);
    const second = createEngineFromSettings(settings, { checkpoint });
    await second.run();
    assert.equal(second.stats.resumed, 3, "the ids the first run recorded are left out");
    assert.equal(second.stats.fetched, 0);

    // The engine checks what it is given, so a retry that is refused there was passed on.
    assert.throws(() => createEngineFromSettings(settings, { retry: { attempts: 0 } }), /retry\.attempts must be a positive integer/);
    assert.doesNotThrow(() => createEngineFromSettings(settings, { retry: { attempts: 3 } }));
  }));
