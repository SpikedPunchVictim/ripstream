import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  IsolationError,
  LimitExceededError,
  Metadata,
  ParseTimeoutError,
  type ParseRecord,
} from "@spikedpunch/ripstream-core";
import {
  CompositeReporter,
  JsonlReporter,
  LoggingReporter,
  MemoryEmitter,
  PIPES_RESULT_STATUSES,
  PipesClient,
  PipesEngine,
  type Emitter,
  type PipeDocument,
  type PipeFetchFailure,
  type PipeMode,
  type PipesResult,
  type PipesRipstream,
  type PipesResultStatus,
} from "../src/index.ts";
import { fileSystem } from "./helpers.ts";

/*
 * What a run says about each input (tikajs-68os.6.1): a result with Tika's status, for every input, and the run goes on
 * after an input that fails. Tika: tika-pipes-api PipesResult.java, EmitHandler.java, FetchHandler.java.
 */

const encoder = new TextEncoder();
const text = (value: string): Uint8Array => encoder.encode(value);
const documents = (...ids: string[]): { fetch(): AsyncIterable<PipeDocument> } => ({
  async *fetch() {
    for (const id of ids) yield { id, data: text(`text of ${id}`) };
  },
});

/** Runs and keeps every result the reporter heard. */
async function runWith(
  options: ConstructorParameters<typeof PipesEngine>[0],
): Promise<{ results: PipesResult[]; engine: PipesEngine; count: number }> {
  const results: PipesResult[] = [];
  const engine = new PipesEngine({ ...options, reporter: { report: (result) => void results.push(result) } });
  const count = await engine.run();
  return { results, engine, count };
}

const statuses = (results: readonly PipesResult[]): Record<string, string> =>
  Object.fromEntries(results.map((result) => [result.id, result.status]));

/** A ripstream whose parse of a named input throws what the test says. */
function throwing(failures: Readonly<Record<string, unknown>>): PipesRipstream {
  const check = (filename: string | undefined): void => {
    if (filename !== undefined && filename in failures) throw failures[filename];
  };
  const record = (): ParseRecord => ({
    metadata: new Metadata({ "Content-Type": "text/plain" }),
    content: "text",
    embeddedResourcePath: "",
    depth: 0,
    mediaType: undefined as never,
    exception: null,
  });
  return {
    parse: async (_source, options) => {
      check(options?.filename);
      return { metadata: new Metadata({ "Content-Type": "text/plain" }), text: "text" };
    },
    parseRecursive: async (_source, options) => {
      check(options?.filename);
      return [record()];
    },
  } as PipesRipstream;
}

// ---- the statuses ------------------------------------------------------------------------------------------------

test("the status table is Tika's: 21 statuses in five categories", () => {
  assert.equal(Object.keys(PIPES_RESULT_STATUSES).length, 21);
  const categories = new Set(Object.values(PIPES_RESULT_STATUSES));
  assert.deepEqual([...categories].sort(), ["FATAL", "INITIALIZATION_FAILURE", "PROCESS_CRASH", "SUCCESS", "TASK_EXCEPTION"]);
  assert.equal(PIPES_RESULT_STATUSES.PARSE_EXCEPTION_NO_EMIT, "SUCCESS");
  assert.equal(PIPES_RESULT_STATUSES.TIMEOUT, "PROCESS_CRASH");
  assert.equal(PIPES_RESULT_STATUSES.FETCH_EXCEPTION, "TASK_EXCEPTION");
});

test("every input gets one result: EMIT_SUCCESS, with how long it took", async () => {
  const { results, count, engine } = await runWith({ source: documents("a.txt", "b.txt"), emitter: new MemoryEmitter() });
  assert.equal(count, 2);
  assert.deepEqual(statuses(results), { "a.txt": "EMIT_SUCCESS", "b.txt": "EMIT_SUCCESS" });
  for (const result of results) {
    assert.equal(result.category, "SUCCESS");
    assert.ok(result.elapsedMs >= 0);
    assert.equal(result.message, undefined);
  }
  assert.equal(engine.stats.failed, 0);
  assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 2 });
});

// ---- a batch with a corrupt file: the acceptance ----------------------------------------------------------------

test("a corrupt document does not end the run: it is emitted with its failure, EMIT_SUCCESS_PARSE_EXCEPTION", async () => {
  const emitter = new MemoryEmitter();
  const { results, count, engine } = await runWith({
    source: {
      async *fetch() {
        yield { id: "good1.txt", data: text("fine") };
        yield { id: "corrupt.docx", data: text("PK\u0003\u0004 not really a zip file at all") };
        yield { id: "good2.txt", data: text("also fine") };
      },
    },
    emitter,
    concurrency: 1,
  });
  assert.equal(count, 3);
  const corrupt = results.find((result) => result.id === "corrupt.docx");
  assert.equal(corrupt?.status, "EMIT_SUCCESS_PARSE_EXCEPTION");
  assert.equal(corrupt?.category, "SUCCESS");
  assert.match(corrupt?.message ?? "", /MalformedDocumentError/);
  assert.deepEqual(statuses(results.filter((result) => result.id !== "corrupt.docx")), { "good1.txt": "EMIT_SUCCESS", "good2.txt": "EMIT_SUCCESS" });
  const emitted = emitter.documents.find((document) => document.id === "corrupt.docx");
  assert.match(String(emitted?.metadata?.["tk:exception:container-exception"]), /MalformedDocumentError/, "the failure travels with the document");
  assert.equal(engine.stats.failed, 0, "Tika counts a recorded parse exception as a success");
});

test("onParseException SKIP: the document that failed to parse is not emitted, PARSE_EXCEPTION_NO_EMIT", async () => {
  for (const mode of ["CONTENT_ONLY", "RMETA", "UNPACK"] as const satisfies readonly PipeMode[]) {
    const emitter = new MemoryEmitter();
    const { results, count } = await runWith({
      source: {
        async *fetch() {
          yield { id: "corrupt.docx", data: text("PK\u0003\u0004 not really a zip file at all") };
          yield { id: "good.txt", data: text("fine") };
        },
      },
      emitter,
      mode,
      onParseException: "SKIP",
    });
    assert.equal(count, 1, mode);
    const skipped = results.find((result) => result.id === "corrupt.docx");
    assert.equal(skipped?.status, "PARSE_EXCEPTION_NO_EMIT", mode);
    assert.match(skipped?.message ?? "", /MalformedDocumentError/, mode);
    assert.ok(!emitter.documents.some((document) => document.id.startsWith("corrupt.docx")), mode);
  }
});

test("RMETA and UNPACK record a failed container too, and emit what they have", async () => {
  for (const mode of ["RMETA", "UNPACK"] as const) {
    const emitter = new MemoryEmitter();
    const { results } = await runWith({
      source: { async *fetch() { yield { id: "corrupt.docx", data: text("PK\u0003\u0004 nope nope nope") }; } },
      emitter,
      mode,
    });
    assert.equal(results[0]?.status, "EMIT_SUCCESS_PARSE_EXCEPTION", mode);
    assert.equal(emitter.documents.length, 1, mode);
  }
});

// ---- the other statuses -----------------------------------------------------------------------------------------

test("an input the fetcher could not read is FETCH_EXCEPTION, and the walk goes on", async () => {
  const root = mkdtempSync(join(tmpdir(), "ripstream-pipes-fetch-"));
  try {
    writeFileSync(join(root, "a.txt"), "first");
    symlinkSync(join(root, "no-such-target"), join(root, "b-dangling.txt"));
    writeFileSync(join(root, "c.txt"), "third");
    const emitter = new MemoryEmitter();
    const { results, count, engine } = await runWith({ ...fileSystem(root), emitter, concurrency: 1 });
    assert.equal(count, 2);
    assert.deepEqual(statuses(results), { "a.txt": "EMIT_SUCCESS", "b-dangling.txt": "FETCH_EXCEPTION", "c.txt": "EMIT_SUCCESS" });
    const failed = results.find((result) => result.id === "b-dangling.txt");
    assert.equal(failed?.category, "TASK_EXCEPTION");
    assert.match(failed?.message ?? "", /ENOENT/);
    assert.equal(engine.stats.fetched, 3, "a failed input was still an input");
    assert.equal(engine.stats.failed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a root that cannot be listed has no inputs: the run rejects", async () => {
  const engine = new PipesEngine({ ...fileSystem(join(tmpdir(), "ripstream-pipes-no-such-root")), emitter: new MemoryEmitter() });
  await assert.rejects(engine.run(), /ENOENT/);
});

test("a failure item from any fetcher is FETCH_EXCEPTION with its message", async () => {
  const failure: PipeFetchFailure = { id: "https://example.test/x", error: new Error("Fetch failed: 500") };
  const { results, count } = await runWith({
    source: {
      async *fetch() {
        yield failure;
        yield { id: "ok.txt", data: text("fine") };
      },
    },
    emitter: new MemoryEmitter(),
  });
  assert.equal(count, 1);
  assert.equal(results.find((r) => r.id === failure.id)?.message, "Error: Fetch failed: 500");
});

test("an emitter that fails on one input is EMIT_EXCEPTION for it, and the others are emitted", async () => {
  const emitter = new MemoryEmitter();
  const emit = emitter.emit.bind(emitter);
  emitter.emit = async (document) => {
    if (document.id === "b.txt") throw new Error("disk full");
    await emit(document);
  };
  const { results, count } = await runWith({ source: documents("a.txt", "b.txt", "c.txt"), emitter, concurrency: 1 });
  assert.equal(count, 2);
  assert.deepEqual(statuses(results), { "a.txt": "EMIT_SUCCESS", "b.txt": "EMIT_EXCEPTION", "c.txt": "EMIT_SUCCESS" });
  assert.equal(results.find((r) => r.id === "b.txt")?.message, "Error: disk full");
  assert.equal(results.find((r) => r.id === "b.txt")?.category, "TASK_EXCEPTION");
});

test("what a parse throws becomes the status of its input: timeout, crash, queue, limit, bug", async () => {
  const ripstream = throwing({
    "timeout.txt": new ParseTimeoutError("Parse timed out"),
    "crash.txt": new IsolationError("crash", "child crashed"),
    "queue.txt": new IsolationError("queue_full", "queue full"),
    "gone.txt": new IsolationError("unavailable", "no isolation"),
    "limit.txt": new LimitExceededError("too many entries"),
    "bug.txt": new TypeError("x is not a function"),
  });
  const ids = ["ok.txt", "timeout.txt", "crash.txt", "queue.txt", "gone.txt", "limit.txt", "bug.txt"];
  for (const mode of ["CONTENT_ONLY", "RMETA"] as const) {
    const { results, engine } = await runWith({ source: documents(...ids), emitter: new MemoryEmitter(), ripstream, mode, concurrency: 3 });
    assert.deepEqual(statuses(results), {
      "ok.txt": "EMIT_SUCCESS",
      "timeout.txt": "TIMEOUT",
      "crash.txt": "UNSPECIFIED_CRASH",
      "queue.txt": "CLIENT_UNAVAILABLE_WITHIN_MS",
      "gone.txt": "CLIENT_UNAVAILABLE_WITHIN_MS",
      "limit.txt": "PAYLOAD_LIMIT_EXCEEDED",
      "bug.txt": "UNSPECIFIED_CRASH",
    }, mode);
    assert.equal(results.find((r) => r.id === "timeout.txt")?.category, "PROCESS_CRASH");
    assert.equal(results.find((r) => r.id === "queue.txt")?.category, "INITIALIZATION_FAILURE");
    assert.equal(results.find((r) => r.id === "limit.txt")?.message, "LimitExceededError: too many entries");
    assert.equal(engine.stats.failed, 6, mode);
    assert.equal(engine.stats.emitted, 1, mode);
  }
});

test("UNPACK of a document with no records is EMPTY_OUTPUT", async () => {
  const ripstream = { parseRecursive: async () => [] } as unknown as PipesRipstream;
  const { results, count } = await runWith({ source: documents("a.txt"), emitter: new MemoryEmitter(), ripstream, mode: "UNPACK" });
  assert.equal(results[0]?.status, "EMPTY_OUTPUT");
  assert.equal(count, 1);
});

test("CONCATENATE emits each input's own document, leaves out one that failed, and reports each by its id", async () => {
  const emitter = new MemoryEmitter();
  const { results, count } = await runWith({
    source: documents("a.txt", "limit.txt", "c.txt"),
    emitter,
    mode: "CONCATENATE",
    ripstream: throwing({ "limit.txt": new LimitExceededError("over") }),
    concurrency: 1,
  });
  assert.equal(count, 2);
  assert.deepEqual(emitter.documents.map((document) => [document.id, document.text]), [["a.txt", "text"], ["c.txt", "text"]]);
  assert.deepEqual(statuses(results), { "a.txt": "EMIT_SUCCESS", "limit.txt": "PAYLOAD_LIMIT_EXCEEDED", "c.txt": "EMIT_SUCCESS" });

  const failing: Emitter = { emit: () => { throw new Error("cannot write"); } };
  const second = await runWith({ source: documents("a.txt"), emitter: failing, mode: "CONCATENATE" });
  assert.equal(second.results.find((r) => r.id === "a.txt")?.status, "EMIT_EXCEPTION");
  assert.equal(second.results.length, 1, "no result of the run's own: every result is an input's");
});

// ---- the reporter ------------------------------------------------------------------------------------------------

test("the reporter hears every result once, one at a time, however many workers there are", async () => {
  let inside = 0;
  let overlapped = false;
  const heard: string[] = [];
  const engine = new PipesEngine({
    source: documents(...Array.from({ length: 30 }, (_, index) => `d${index}.txt`)),
    emitter: new MemoryEmitter(),
    concurrency: 6,
    reporter: {
      report: async (result) => {
        inside++;
        if (inside > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 1));
        heard.push(result.id);
        inside--;
      },
    },
  });
  await engine.run();
  assert.equal(overlapped, false);
  assert.equal(new Set(heard).size, 30);
  assert.equal(heard.length, 30);
});

test("a reporter that throws ends the run with its error, and the emitter is closed once", async () => {
  const boom = new Error("audit log is gone");
  let closes = 0;
  const emitter: Emitter = { emit: () => undefined, close: () => void closes++ };
  const engine = new PipesEngine({
    source: documents("a.txt", "b.txt", "c.txt", "d.txt"),
    emitter,
    concurrency: 2,
    reporter: { report: () => { throw boom; } },
  });
  await assert.rejects(engine.run(), (error) => error === boom);
  assert.equal(closes, 1);
});

test("PipesClient takes the reporter and the parse-exception choice, and resolves with the stats", async () => {
  const root = mkdtempSync(join(tmpdir(), "ripstream-pipes-client-"));
  try {
    writeFileSync(join(root, "a.txt"), "first");
    writeFileSync(join(root, "bad.docx"), "PK\u0003\u0004 not really a zip file at all");
    const heard: PipesResult[] = [];
    const { count, stats } = await new PipesClient(
      { source: { type: "filesystem", path: root }, concurrency: 1 },
      { reporter: { report: (result) => void heard.push(result) }, onParseException: "SKIP" },
    ).run();
    assert.equal(count, 1);
    assert.deepEqual(stats.byStatus, { EMIT_SUCCESS: 1, PARSE_EXCEPTION_NO_EMIT: 1 });
    assert.equal(heard.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the reporters ---------------------------------------------------------------------------------------------

const sample = (id: string, status: PipesResultStatus): PipesResult => ({
  id,
  status,
  category: PIPES_RESULT_STATUSES[status],
  elapsedMs: 1,
});

test("JsonlReporter writes a line per result: an audit log of the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ripstream-pipes-jsonl-"));
  try {
    const file = join(dir, "audit.jsonl");
    const { results } = await runWith({
      source: documents("a.txt", "limit.txt"),
      emitter: new MemoryEmitter(),
      ripstream: throwing({ "limit.txt": new LimitExceededError("over") }),
      concurrency: 1,
    });
    const reporter = new JsonlReporter(file);
    for (const result of results) await reporter.report(result);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as PipesResult);
    assert.deepEqual(lines.map((line) => [line.id, line.status]), [["a.txt", "EMIT_SUCCESS"], ["limit.txt", "PAYLOAD_LIMIT_EXCEEDED"]]);
    assert.equal(lines[1]?.message, "LimitExceededError: over");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reporter's includes / excludes keep the results it writes; naming both, or a status that is not one, is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ripstream-pipes-filter-"));
  try {
    const only = join(dir, "only.jsonl");
    const not = join(dir, "not.jsonl");
    const include = new JsonlReporter(only, { includes: ["TIMEOUT"] });
    const exclude = new JsonlReporter(not, { excludes: ["EMIT_SUCCESS"] });
    for (const result of [sample("a", "EMIT_SUCCESS"), sample("b", "TIMEOUT"), sample("c", "FETCH_EXCEPTION")]) {
      await include.report(result);
      await exclude.report(result);
    }
    const ids = (file: string): string[] => readFileSync(file, "utf8").trimEnd().split("\n").map((line) => (JSON.parse(line) as PipesResult).id);
    assert.deepEqual(ids(only), ["b"]);
    assert.deepEqual(ids(not), ["b", "c"]);
    assert.throws(() => new JsonlReporter(only, { includes: ["TIMEOUT"], excludes: ["OOM"] }), /only one of includes and excludes/);
    assert.throws(() => new LoggingReporter({ includes: ["NOT_A_STATUS" as PipesResultStatus] }), /names no result status/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CompositeReporter passes each result to every reporter", async () => {
  const one: PipesResult[] = [];
  const two: PipesResult[] = [];
  const composite = new CompositeReporter([{ report: (r) => void one.push(r) }, { report: (r) => void two.push(r) }]);
  await composite.report(sample("a", "EMIT_SUCCESS"));
  assert.equal(one.length, 1);
  assert.equal(two.length, 1);
});

test("an iterator that fails after it gave a tuple ends the run with its error, and does not end it quietly", async () => {
  const emitter = new MemoryEmitter();
  const engine = new PipesEngine({
    iterator: (async function* () {
      yield { id: "a", fetcher: "f", fetchKey: "a" };
      throw new Error("the listing broke");
    })(),
    fetchers: { f: { fetch: async () => new TextEncoder().encode("x") } },
    emitter,
  });
  await assert.rejects(engine.run(), /the listing broke/);
});

test("an iterator that fails while the only worker is busy with an earlier tuple still ends the run with its error", async () => {
  // The worker took "a" through the arrival, so no worker is waiting on the fill when the listing breaks. A failure that
  // only reached whoever was waiting would be lost here, and the next fill would find a finished iterator and end the run clean.
  let fetching!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    fetching = resolve;
  });
  const emitter = new MemoryEmitter();
  const engine = new PipesEngine({
    iterator: (async function* () {
      yield { id: "a", fetcher: "f", fetchKey: "a" };
      await fetchStarted;
      throw new Error("the listing broke");
    })(),
    fetchers: {
      f: {
        fetch: async () => {
          fetching();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return new TextEncoder().encode("x");
        },
      },
    },
    emitter,
    concurrency: 1,
  });
  await assert.rejects(engine.run(), /the listing broke/);
});
