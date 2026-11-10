import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadConfig } from "@spikedpunch/ripstream-core";
import {
  HttpFetcher,
  JsonlReporter,
  MemoryEmitter,
  ModuleFetcher,
  PipesEngine,
  UrlListPipesIterator,
  createEngineFromSettings,
  parseFetchEmitTuple,
  type FetchEmitTuple,
  type Fetcher,
  type PipesResult,
} from "../src/index.ts";

/*
 * The tuple model (tikajs-68os.6.2): the engine takes FetchEmitTuples, plain data, and reads each one's bytes inside the
 * worker that takes it, through fetchers and emitters registered by id. Evidence for the model:
 * tasks/parity/audits/pipes-model-spike.md.
 */

const encoder = new TextEncoder();
const context = { signal: new AbortController().signal };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function* tuples(...list: FetchEmitTuple[]): AsyncGenerator<FetchEmitTuple> {
  for (const tuple of list) yield tuple;
}

/** A fetcher over a map, so a test says what each key holds. */
const mapFetcher = (files: Readonly<Record<string, string>>): Fetcher => ({
  async fetch(key) {
    const text = files[key];
    if (text === undefined) throw new Error(`no such key ${key}`);
    return encoder.encode(text);
  },
});

async function run(
  options: ConstructorParameters<typeof PipesEngine>[0],
): Promise<{ results: Map<string, PipesResult>; tuplesSeen: FetchEmitTuple[]; engine: PipesEngine; count: number }> {
  const results = new Map<string, PipesResult>();
  const tuplesSeen: FetchEmitTuple[] = [];
  const engine = new PipesEngine({
    ...options,
    reporter: {
      report(result, tuple) {
        results.set(result.id, result);
        if (tuple !== undefined) tuplesSeen.push(tuple);
      },
    },
  });
  const count = await engine.run();
  return { results, tuplesSeen, engine, count };
}

test("a tuple is read by the fetcher it names and written by the emitter it names, under its emitKey", async () => {
  const text = new MemoryEmitter();
  const other = new MemoryEmitter();
  const { results, tuplesSeen, count } = await run({
    iterator: tuples(
      { id: "one", fetcher: "map", fetchKey: "a.txt", emitter: "text", emitKey: "out/a" },
      { id: "two", fetcher: "map", fetchKey: "b.txt", emitter: "other" },
    ),
    fetchers: { map: mapFetcher({ "a.txt": "alpha", "b.txt": "beta" }) },
    emitters: { text, other },
    mode: "CONTENT_ONLY",
  });
  assert.equal(count, 2);
  assert.deepEqual(text.documents.map((document) => [document.id, document.text?.trim()]), [["out/a", "alpha"]]);
  assert.deepEqual(other.documents.map((document) => [document.id, document.text?.trim()]), [["two", "beta"]]);
  assert.equal(results.get("one")?.status, "EMIT_SUCCESS", "reports name the tuple's id, not its emitKey");
  assert.equal(tuplesSeen.length, 2, "the reporter is given the tuple");
});

test("a tuple that names no emitter goes to the default one: the emitter option, or the only registered one", async () => {
  const only = new MemoryEmitter();
  await run({ iterator: tuples({ id: "a", fetcher: "map", fetchKey: "a" }), fetchers: { map: mapFetcher({ a: "x" }) }, emitters: { only } });
  assert.equal(only.documents.length, 1);
  const chosen = new MemoryEmitter();
  const unused = new MemoryEmitter();
  await run({
    iterator: tuples({ id: "a", fetcher: "map", fetchKey: "a" }),
    fetchers: { map: mapFetcher({ a: "x" }) },
    emitters: { unused, again: new MemoryEmitter() },
    emitter: chosen,
  });
  assert.equal(chosen.documents.length, 1);
  assert.equal(unused.documents.length, 0);
});

test("a tuple naming a fetcher or an emitter that is not there is that tuple's result, and the run goes on", async () => {
  const emitter = new MemoryEmitter();
  const { results, count, engine } = await run({
    iterator: tuples(
      { id: "ok", fetcher: "map", fetchKey: "a" },
      { id: "no-fetcher", fetcher: "ghost", fetchKey: "a" },
      { id: "no-emitter", fetcher: "map", fetchKey: "a", emitter: "ghost" },
      { id: "after", fetcher: "map", fetchKey: "a" },
    ),
    fetchers: { map: mapFetcher({ a: "x" }) },
    emitter,
  });
  assert.equal(count, 2);
  assert.equal(results.get("no-fetcher")?.status, "FETCHER_NOT_FOUND");
  assert.match(results.get("no-fetcher")?.message ?? "", /"ghost"/);
  assert.equal(results.get("no-emitter")?.status, "EMITTER_NOT_FOUND");
  assert.equal(engine.stats.failed, 2);
});

test("an id that is not an own property of the registries is not found: no prototype names", async () => {
  const { results } = await run({
    iterator: tuples({ id: "a", fetcher: "constructor", fetchKey: "a" }, { id: "b", fetcher: "map", fetchKey: "a", emitter: "toString" }),
    fetchers: { map: mapFetcher({ a: "x" }) },
    emitters: { real: new MemoryEmitter() },
  });
  assert.equal(results.get("a")?.status, "FETCHER_NOT_FOUND");
  assert.equal(results.get("b")?.status, "EMITTER_NOT_FOUND");
});

test("a fetch that throws is FETCH_EXCEPTION for that tuple; one that is refused by key does not stop the rest", async () => {
  const emitter = new MemoryEmitter();
  const { results, count } = await run({
    iterator: tuples({ id: "a", fetcher: "map", fetchKey: "a" }, { id: "gone", fetcher: "map", fetchKey: "gone" }, { id: "c", fetcher: "map", fetchKey: "c" }),
    fetchers: { map: mapFetcher({ a: "x", c: "z" }) },
    emitter,
  });
  assert.equal(count, 2);
  assert.equal(results.get("gone")?.status, "FETCH_EXCEPTION");
  assert.match(results.get("gone")?.message ?? "", /no such key gone/);
});

test("a tuple's onParseException overrides the run's", async () => {
  const emitter = new MemoryEmitter();
  const corrupt = "PK\u0003\u0004 not a real package";
  const { results } = await run({
    iterator: tuples(
      { id: "skip.docx", fetcher: "map", fetchKey: "bad", onParseException: "SKIP" },
      { id: "keep.docx", fetcher: "map", fetchKey: "bad" },
    ),
    fetchers: { map: mapFetcher({ bad: corrupt }) },
    emitter,
    mode: "RMETA",
  });
  assert.equal(results.get("skip.docx")?.status, "PARSE_EXCEPTION_NO_EMIT");
  assert.equal(results.get("keep.docx")?.status, "EMIT_SUCCESS_PARSE_EXCEPTION");
});

test("bytes are read inside the worker, at most `concurrency` at a time, however slow the fetch", async () => {
  let inFlight = 0;
  let peak = 0;
  let started = 0;
  const fetcher: Fetcher = {
    async fetch() {
      started++;
      peak = Math.max(peak, ++inFlight);
      await sleep(20);
      inFlight--;
      return encoder.encode("x");
    },
  };
  const all = Array.from({ length: 40 }, (_, index): FetchEmitTuple => ({ id: `t${index}`, fetcher: "slow", fetchKey: `k${index}` }));
  const emitter = new MemoryEmitter();
  const begun = performance.now();
  await run({ iterator: tuples(...all), fetchers: { slow: fetcher }, emitter, concurrency: 8, maxQueue: 64 });
  const elapsed = performance.now() - begun;
  assert.equal(started, 40);
  assert.equal(emitter.documents.length, 40);
  assert.ok(peak > 1 && peak <= 8, `peak in flight ${peak}`);
  // One at a time this is 40 x 20 ms; eight at a time it is about a fifth of that.
  assert.ok(elapsed < 600, `${elapsed.toFixed(0)} ms for 40 fetches of 20 ms at concurrency 8`);
});

test("the queue holds tuples, not bytes: a fetch has not started for a tuple no worker has taken", async () => {
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetcher: Fetcher = {
    async fetch() {
      started++;
      await gate;
      return encoder.encode("x");
    },
  };
  const all = Array.from({ length: 50 }, (_, index): FetchEmitTuple => ({ id: `t${index}`, fetcher: "gated", fetchKey: `k${index}` }));
  const running = new PipesEngine({ iterator: tuples(...all), fetchers: { gated: fetcher }, emitter: new MemoryEmitter(), concurrency: 3, maxQueue: 50 }).run();
  await sleep(50);
  assert.equal(started, 3, "only the tuples workers hold are being read");
  release();
  assert.equal(await running, 50);
});

test("each distinct emitter and fetcher is closed once when the run ends, all of them even when one fails to close", async () => {
  const closes: string[] = [];
  const closing = (name: string, fail = false): { close(): void } => ({
    close() {
      closes.push(name);
      if (fail) throw new Error(`${name} will not close`);
    },
  });
  const shared = Object.assign(new MemoryEmitter(), closing("shared"));
  const bad = Object.assign(new MemoryEmitter(), closing("bad", true));
  const fetcher = Object.assign(mapFetcher({ a: "x" }), closing("fetcher"));
  const engine = new PipesEngine({
    iterator: tuples({ id: "a", fetcher: "map", fetchKey: "a" }),
    fetchers: { map: fetcher },
    emitters: { one: shared, two: shared, bad },
    emitter: shared,
  });
  await assert.rejects(engine.run(), /bad will not close/);
  assert.deepEqual(closes.sort(), ["bad", "fetcher", "shared"]);
  assert.equal(engine.stats.fetched, 1, "stats are kept when a close fails");
});

test("a run takes an iterator or a source, not both and not neither, and its component ids follow Tika's rules", () => {
  const emitter = new MemoryEmitter();
  assert.throws(() => new PipesEngine({ emitter }), /exactly one of iterator/);
  assert.throws(() => new PipesEngine({ emitter, iterator: tuples(), source: { fetch: async function* () {} } }), /exactly one of iterator/);
  assert.throws(() => new PipesEngine({ emitter, iterator: tuples(), fetchers: { __inline: mapFetcher({}) } }), /starts with "__"/);
  assert.throws(() => new PipesEngine({ emitter, iterator: tuples(), emitters: { "bad id": emitter } }), /may only use letters/);
});

test("CONCATENATE writes each input's document to its emitter, the default one when the tuple names none", async () => {
  const emitter = new MemoryEmitter();
  await run({
    iterator: tuples({ id: "a", fetcher: "map", fetchKey: "a" }, { id: "b", fetcher: "map", fetchKey: "b" }),
    fetchers: { map: mapFetcher({ a: "one ", b: "two" }) },
    emitter,
    mode: "CONCATENATE",
    ordered: true,
  });
  assert.deepEqual(emitter.documents.map((document) => [document.id, document.text?.trim()]), [["a", "one"], ["b", "two"]]);
  const { results } = await run({
    iterator: tuples({ id: "a", fetcher: "map", fetchKey: "a" }),
    fetchers: { map: mapFetcher({ a: "one" }) },
    emitters: { x: new MemoryEmitter(), y: new MemoryEmitter() },
    mode: "CONCATENATE",
  });
  assert.equal(results.get("a")?.status, "EMITTER_NOT_FOUND");
  assert.equal(results.size, 1, "the tuple's result is the only one");
});

test("parseFetchEmitTuple reads a tuple from JSON: the id defaults to the fetchKey, and a field ripstream cannot act on is refused by name", () => {
  const parsed = parseFetchEmitTuple({ fetcher: "fs", fetchKey: "a/b.docx", emitter: "out", emitKey: "a/b", onParseException: "SKIP" });
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.tuple, { id: "a/b.docx", fetcher: "fs", fetchKey: "a/b.docx", emitter: "out", emitKey: "a/b", onParseException: "SKIP" });
  const refused = parseFetchEmitTuple({ fetcher: "fs", fetchKey: "a", fetchRangeStart: 0, metadata: {}, preset: "p", parseContext: {}, bogus: 1 });
  assert.equal(refused.tuple, undefined);
  const text = refused.issues.join("\n");
  for (const name of ["fetchRangeStart", "metadata", "preset", "parseContext", "bogus"]) assert.ok(text.includes(name), name);
  assert.match(parseFetchEmitTuple({ fetchKey: "a" }).issues.join(), /fetcher is required/);
  assert.match(parseFetchEmitTuple({ fetcher: "f", fetchKey: "a\u0000" }).issues.join(), /fetchKey must be a non-empty string/);
  assert.match(parseFetchEmitTuple({ fetcher: "f", fetchKey: "a", onParseException: "DROP" }).issues.join(), /EMIT or SKIP/);
  assert.match(parseFetchEmitTuple([]).issues.join(), /JSON object/);
});

test("the http fetcher reads through the SSRF-safe fetch: a loopback URL is refused, and the URL list names its tuples by URL", async () => {
  await assert.rejects(new HttpFetcher().fetch("http://127.0.0.1:9/", context));
  const urls: FetchEmitTuple[] = [];
  for await (const tuple of new UrlListPipesIterator(["http://a.example/x", "http://b.example/y"], "web")) urls.push(tuple);
  assert.deepEqual(urls, [
    { id: "http://a.example/x", fetcher: "web", fetchKey: "http://a.example/x" },
    { id: "http://b.example/y", fetcher: "web", fetchKey: "http://b.example/y" },
  ]);
});

test("ModuleFetcher makes the module's fetcher once, reuses it for every key, and closes it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-module-"));
  try {
    const file = join(directory, "fetcher.mjs");
    writeFileSync(
      file,
      `export function createFetcher() {
         globalThis.__moduleFetcherMade = (globalThis.__moduleFetcherMade ?? 0) + 1;
         return { fetch: async (key) => new TextEncoder().encode("from module: " + key), close() { globalThis.__moduleFetcherClosed = true; } };
       }`,
    );
    const fetcher = new ModuleFetcher(pathToFileURL(file).href);
    const [a, b] = await Promise.all([fetcher.fetch("a", context), fetcher.fetch("b", context)]);
    assert.equal(new TextDecoder().decode(a), "from module: a");
    assert.equal(new TextDecoder().decode(b), "from module: b");
    assert.equal((globalThis as Record<string, unknown>).__moduleFetcherMade, 1);
    await fetcher.close();
    assert.equal((globalThis as Record<string, unknown>).__moduleFetcherClosed, true);
    await assert.rejects(new ModuleFetcher(pathToFileURL(join(directory, "missing.mjs")).href).fetch("a", context));
    writeFileSync(join(directory, "empty.mjs"), "export const nothing = 1;");
    await assert.rejects(new ModuleFetcher(pathToFileURL(join(directory, "empty.mjs")).href).fetch("a", context), /Invalid fetcher module/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__moduleFetcherMade;
    delete (globalThis as Record<string, unknown>).__moduleFetcherClosed;
  }
});

test("JsonlReporter: onExists says what happens to a file that is there, and a long message is cut as Tika's is", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-jsonl-"));
  try {
    const path = join(directory, "nested", "report.jsonl");
    const result = (id: string, message?: string): PipesResult => ({ id, status: "FETCH_EXCEPTION", category: "TASK_EXCEPTION", elapsedMs: 1, ...(message === undefined ? {} : { message }) });
    const first = new JsonlReporter(path, {}, { onExists: "EXCEPTION" });
    await first.report(result("a"));
    assert.throws(() => new JsonlReporter(path, {}, { onExists: "EXCEPTION" }), /already exists/);
    const appended = new JsonlReporter(path, {}, { onExists: "APPEND" });
    await appended.report(result("b"));
    assert.deepEqual(readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line).id), ["a", "b"]);
    writeFileSync(path, '{"id":"half');
    new JsonlReporter(path, {}, { onExists: "APPEND" });
    assert.equal(readFileSync(path, "utf8"), '{"id":"half\n', "a partial last line is ended, not glued to the next");
    const replaced = new JsonlReporter(path, {}, { onExists: "REPLACE" });
    assert.equal(readFileSync(path, "utf8"), "");
    await replaced.report(result("c", "x".repeat(50)));
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    assert.equal(line.message, "x".repeat(50), "no limit: not cut");
    const cutting = new JsonlReporter(path, {}, { onExists: "REPLACE", maxMessageLength: 10 });
    await cutting.report(result("d", "x".repeat(50)));
    assert.equal(JSON.parse(readFileSync(path, "utf8").trim()).message, `${"x".repeat(10)}...[truncated 40 chars]`);
    await cutting.report(result("e", `${"y".repeat(9)}\u{1F600}rest`));
    const cutSurrogate = JSON.parse(readFileSync(path, "utf8").trim().split("\n")[1]!).message as string;
    assert.equal(cutSurrogate, `${"y".repeat(9)}...[truncated 6 chars]`, "a surrogate pair is not split");
    assert.throws(() => new JsonlReporter(directory), /is a directory/);
    assert.throws(() => new JsonlReporter(path, {}, { maxMessageLength: 0 }), /maxMessageLength/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A Tika pipes configuration whose paths are real directories. */
function tikaConfig(input: string, output: string, reportPath: string): Record<string, unknown> {
  return {
    fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
    emitters: { fse: { "file-system-emitter": { basePath: output } } },
    "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
    "pipes-reporters": { "file-system-jsonl-reporter": { path: reportPath, includes: ["EMIT_SUCCESS", "FETCH_EXCEPTION"] } },
    pipes: { parseMode: "CONTENT_ONLY", numClients: 2 },
  };
}

test("a Tika-shaped configuration runs end to end: iterator, fetcher, emitter and reporter built from the settings", async () => {
  const base = mkdtempSync(join(tmpdir(), "ripstream-settings-"));
  try {
    const input = join(base, "in");
    const output = join(base, "out");
    mkdirSync(join(input, "sub"), { recursive: true });
    writeFileSync(join(input, "a.txt"), "alpha text");
    writeFileSync(join(input, "sub", "b.txt"), "beta text");
    const reportPath = join(base, "report.jsonl");
    const settings = loadConfig(tikaConfig(input, output, reportPath)).pipes!;
    const engine = createEngineFromSettings(settings);
    assert.equal(await engine.run(), 2);
    assert.equal(engine.stats.byStatus.EMIT_SUCCESS, 2);
    // Tika's emitter mirrors the emit key, which is the path under the input: the output has the input's layout.
    assert.deepEqual(readdirSync(output).sort(), ["a.txt", "sub"]);
    assert.equal(readFileSync(join(output, "a.txt"), "utf8").trim(), "alpha text");
    assert.equal(readFileSync(join(output, "sub", "b.txt"), "utf8").trim(), "beta text");
    const lines = readFileSync(reportPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as PipesResult);
    assert.deepEqual(lines.map((line) => line.id).sort(), ["a.txt", "sub/b.txt"]);
    // Tika's default: a report file that is already there is an error, found when the engine is built.
    assert.throws(() => createEngineFromSettings(settings), /already exists/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("settings with no pipes-iterator need an iterator from the caller, which takes the place of the settings' own", async () => {
  const base = mkdtempSync(join(tmpdir(), "ripstream-settings-"));
  try {
    const input = join(base, "in");
    const output = join(base, "out");
    mkdirSync(input);
    writeFileSync(join(input, "a.txt"), "alpha text");
    writeFileSync(join(input, "b.txt"), "beta text");
    const config = tikaConfig(input, output, join(base, "report.jsonl"));
    delete config["pipes-iterator"];
    const settings = loadConfig(config).pipes!;
    assert.throws(() => createEngineFromSettings(settings), /no pipes-iterator/);
    const engine = createEngineFromSettings(settings, { iterator: tuples({ id: "only", fetcher: "fsf", fetchKey: "b.txt", emitter: "fse", emitKey: "renamed" }) });
    assert.equal(await engine.run(), 1);
    assert.deepEqual(readdirSync(output), ["renamed"]);
    assert.ok(existsSync(join(base, "report.jsonl")));
    const bypass = createEngineFromSettings(loadConfig(tikaConfig(input, join(base, "out2"), join(base, "r2.jsonl"))).pipes!, {
      iterator: tuples({ id: "escape", fetcher: "fsf", fetchKey: "../outside.txt", emitter: "fse" }),
    });
    await bypass.run();
    assert.equal(bypass.stats.byStatus.FETCH_EXCEPTION, 1, "the configured fetcher keeps a tuple key under its basePath");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("settings default to Tika's parseMode (RMETA) and onParseException (EMIT)", async () => {
  const base = mkdtempSync(join(tmpdir(), "ripstream-settings-"));
  try {
    const input = join(base, "in");
    mkdirSync(input);
    writeFileSync(join(input, "a.txt"), "alpha text");
    const config = tikaConfig(input, join(base, "out"), join(base, "report.jsonl"));
    const settings = loadConfig({ ...config, pipes: { numClients: 1 } }).pipes!;
    assert.equal(settings.parseMode, undefined);
    const engine = createEngineFromSettings(settings);
    await engine.run();
    const rmeta = JSON.parse(readFileSync(join(base, "out", readdirSync(join(base, "out"))[0]!), "utf8")) as unknown[];
    assert.ok(Array.isArray(rmeta), "RMETA writes the JSON list of records");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
