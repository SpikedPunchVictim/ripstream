import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, PIPES_RESULT_STATUSES, type LanguageIdentifier } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import {
  AsyncProcessor,
  OfferLargerThanQueueSize,
  httpResponseFor,
  type FetchEmitTuple,
  type PipesResult,
  type PipesResultStatus,
  type PipesRipstream,
} from "../src/index.ts";

/*
 * Tika's AsyncProcessor: tuples offered to a bounded queue, processed in the background by one long-lived run.
 */

interface Scratch {
  readonly input: string;
  readonly output: string;
}

async function scratch(run: (directory: Scratch) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-async-"));
  const input = join(directory, "in");
  mkdirSync(input);
  try {
    await run({ input, output: join(directory, "out") });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function settingsFor({ input, output }: Scratch, pipes: Record<string, unknown> = {}) {
  return loadConfig({
    fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
    emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: "json", onExists: "REPLACE" } } },
    pipes: { parseMode: "RMETA", ...pipes },
  }).pipes!;
}

const tuple = (name: string): FetchEmitTuple => ({ id: name, fetcher: "fsf", fetchKey: name, emitter: "fse" });

async function until(condition: () => boolean, what: string, milliseconds = 5_000): Promise<void> {
  const deadline = performance.now() + milliseconds;
  while (!condition()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The real parse, held at a gate until the test opens it. */
function gated(): { ripstream: PipesRipstream; open: () => void; started: () => number } {
  const real = createRipstream();
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  let started = 0;
  return {
    open: release,
    started: () => started,
    ripstream: {
      detect: (...args) => real.detect(...args),
      parse: (...args) => real.parse(...args),
      parseRecursive: async (...args) => {
        started++;
        await opened;
        return real.parseRecursive(...args);
      },
    },
  };
}

test("a tuple offered to an idle processor is processed at once, and so is each one that trickles in after it", () =>
  scratch(async (paths) => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(paths.input, name), `content of ${name}`);
    const processor = new AsyncProcessor(settingsFor(paths));
    try {
      for (const name of ["a.txt", "b.txt", "c.txt"]) {
        assert.equal(await processor.offer([tuple(name)], 1_000), true);
        await until(() => existsSync(join(paths.output, `${name}.json`)), `${name} to be emitted`);
        assert.match(readFileSync(join(paths.output, `${name}.json`), "utf8"), new RegExp(`content of ${name}`));
      }
    } finally {
      await processor.close();
    }
  }));

test("a processor with a digester factory in its settings digests what it parses, as the engine does", () =>
  scratch(async (paths) => {
    const content = "content digested by an async processor";
    writeFileSync(join(paths.input, "d.txt"), content);
    const settings = loadConfig({
      fetchers: { fsf: { "file-system-fetcher": { basePath: paths.input } } },
      emitters: { fse: { "file-system-emitter": { basePath: paths.output, fileExtension: "json", onExists: "REPLACE" } } },
      pipes: { parseMode: "RMETA" },
      "parse-context": { "commons-digester-factory": { digests: [{ algorithm: "MD5" }] } },
    }).pipes!;
    const processor = new AsyncProcessor(settings);
    try {
      assert.equal(await processor.offer([tuple("d.txt")], 1_000), true);
      await until(() => existsSync(join(paths.output, "d.txt.json")), "d.txt to be emitted");
    } finally {
      await processor.close();
    }
    const [record] = JSON.parse(readFileSync(join(paths.output, "d.txt.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.equal(record?.["tk:digest:MD5"], createHash("md5").update(content).digest("hex"));
  }));

test("a batch is taken whole and every tuple in it is processed", () =>
  scratch(async (paths) => {
    const names = Array.from({ length: 25 }, (_, i) => `doc-${i}.txt`);
    for (const name of names) writeFileSync(join(paths.input, name), name);
    const results: PipesResult[] = [];
    const processor = new AsyncProcessor(settingsFor(paths), { reporter: { report: (result) => void results.push(result) } });
    assert.equal(await processor.offer(names.map(tuple), 1_000), true);
    await processor.close();
    assert.equal(results.length, 25);
    assert.ok(results.every((result) => result.status === "EMIT_SUCCESS"));
    for (const name of names) assert.equal(existsSync(join(paths.output, `${name}.json`)), true, name);
  }));

test("a tuple that names a fetcher that is not there is its own result, and the ones after it still run", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "ok.txt"), "fine");
    const results: PipesResult[] = [];
    const processor = new AsyncProcessor(settingsFor(paths), { reporter: { report: (result) => void results.push(result) } });
    await processor.offer([{ id: "bad", fetcher: "nope", fetchKey: "x", emitter: "fse" }, tuple("ok.txt")], 1_000);
    await processor.close();
    assert.deepEqual(results.map((result) => [result.id, result.status]).sort(), [["bad", "FETCHER_NOT_FOUND"], ["ok.txt", "EMIT_SUCCESS"]]);
  }));

test("a full queue takes nothing more: the offer waits as long as it was told to and answers false", () =>
  scratch(async (paths) => {
    for (let i = 0; i < 40; i++) writeFileSync(join(paths.input, `doc-${i}.txt`), "x");
    const gate = gated();
    // One at a time and a room for two: the worker, the engine's own queue (maxQueue 1) and the processor's queue (2) fill.
    const processor = new AsyncProcessor(settingsFor(paths, { numClients: 1, queueSize: 1 }), { queueSize: 2, ripstream: gate.ripstream });
    let accepted = 0;
    let refusedAfter = 0;
    for (let i = 0; i < 40; i++) {
      const before = performance.now();
      if (await processor.offer([tuple(`doc-${i}.txt`)], 150)) {
        accepted++;
        continue;
      }
      refusedAfter = performance.now() - before;
      break;
    }
    assert.ok(accepted >= 2 && accepted <= 5, `the queue took ${accepted} before it was full`);
    assert.ok(refusedAfter >= 140, `the offer waited ${refusedAfter.toFixed(0)} ms of the 150 it was given`);
    assert.equal(processor.capacity, 0);
    gate.open();
    await processor.close();
  }));

test("a refused batch leaves nothing of itself on the queue", () =>
  scratch(async (paths) => {
    for (const name of ["a", "b", "c", "d"]) writeFileSync(join(paths.input, `${name}.txt`), name);
    const gate = gated();
    const processor = new AsyncProcessor(settingsFor(paths, { numClients: 1 }), { queueSize: 3, ripstream: gate.ripstream });
    // The worker takes the first and holds it at the gate; the next two wait in the queue, which leaves room for one.
    while (processor.capacity > 1) {
      assert.equal(await processor.offer([tuple("a.txt")], 1_000), true);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(processor.capacity, 1);
    assert.equal(await processor.offer([tuple("b.txt"), tuple("c.txt")], 50), false, "two do not fit in one");
    assert.equal(processor.capacity, 1, "not one of the refused tuples was queued");
    assert.equal(await processor.offer([tuple("d.txt")], 50), true, "the room that was left is still there");
    gate.open();
    await processor.close();
    assert.equal(existsSync(join(paths.output, "d.txt.json")), true);
    for (const name of ["b", "c"]) assert.equal(existsSync(join(paths.output, `${name}.txt.json`)), false, `${name} was refused, so never processed`);
  }));

test("a batch bigger than the queue could ever hold is an error, not a throttle", () =>
  scratch(async (paths) => {
    const processor = new AsyncProcessor(settingsFor(paths), { queueSize: 3 });
    try {
      await assert.rejects(
        processor.offer(["a", "b", "c", "d"].map(tuple), 10_000),
        (error: unknown) => error instanceof OfferLargerThanQueueSize && error.sizeOffered === 4 && error.queueSize === 3,
      );
    } finally {
      await processor.close();
    }
  }));

test("an offer that was waiting for room is taken when room is made", () =>
  scratch(async (paths) => {
    for (let i = 0; i < 12; i++) writeFileSync(join(paths.input, `doc-${i}.txt`), "x");
    const gate = gated();
    const processor = new AsyncProcessor(settingsFor(paths, { numClients: 1, queueSize: 1 }), { queueSize: 2, ripstream: gate.ripstream });
    let offered = 0;
    while (processor.capacity > 0 || offered < 3) assert.equal(await processor.offer([tuple(`doc-${offered++}.txt`)], 1_000), true);
    const waiting = processor.offer([tuple("doc-11.txt")], 10_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.open();
    assert.equal(await waiting, true, "the gate opening drained the queue and let it in");
    await processor.close();
    assert.equal(existsSync(join(paths.output, "doc-11.txt.json")), true);
  }));

test("close lets what was taken finish, then an offer is refused", () =>
  scratch(async (paths) => {
    for (let i = 0; i < 6; i++) writeFileSync(join(paths.input, `doc-${i}.txt`), "x");
    const processor = new AsyncProcessor(settingsFor(paths, { numClients: 1 }));
    await processor.offer(Array.from({ length: 6 }, (_, i) => tuple(`doc-${i}.txt`)), 1_000);
    await processor.close();
    for (let i = 0; i < 6; i++) assert.equal(existsSync(join(paths.output, `doc-${i}.txt.json`)), true, `doc-${i}`);
    await assert.rejects(processor.offer([tuple("doc-0.txt")], 10), /closed/);
  }));

test("a run that cannot go on (a reporter that throws) is the error of every later offer and of close", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "a.txt"), "x");
    const processor = new AsyncProcessor(settingsFor(paths), {
      reporter: {
        report() {
          throw new Error("audit log unavailable");
        },
      },
    });
    await processor.offer([tuple("a.txt")], 1_000);
    await until(() => processor.capacity === 10_000 && existsSync(join(paths.output, "a.txt.json")), "the first tuple");
    await assert.rejects(async () => {
      for (let i = 0; i < 200; i++) {
        await processor.offer([tuple("a.txt")], 10);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }, /audit log unavailable/);
    await assert.rejects(processor.close(), /audit log unavailable/);
  }));

test("a queueSize that is not a positive integer is refused when the processor is made", () =>
  scratch(async (paths) => {
    assert.throws(() => new AsyncProcessor(settingsFor(paths), { queueSize: 0 }), /queueSize must be a positive integer/);
  }));

// -- the HTTP answer for a result -------------------------------------------------------------------------------------

test("every status answers over HTTP as Tika's PipesParsingHelper does", () => {
  const expected: Record<PipesResultStatus, number> = {
    PARSE_SUCCESS: 200,
    PARSE_SUCCESS_WITH_EXCEPTION: 200,
    EMPTY_OUTPUT: 200,
    EMIT_SUCCESS: 200,
    EMIT_SUCCESS_PARSE_EXCEPTION: 200,
    EMIT_SUCCESS_PASSBACK: 200,
    PARSE_EXCEPTION_NO_EMIT: 200,
    PARTIAL_TIMEOUT: 200,
    TIMEOUT: 503,
    OOM: 503,
    UNSPECIFIED_CRASH: 503,
    CLIENT_UNAVAILABLE_WITHIN_MS: 429,
    FETCHER_NOT_FOUND: 400,
    EMITTER_NOT_FOUND: 400,
    PRESET_NOT_FOUND: 400,
    PAYLOAD_LIMIT_EXCEEDED: 413,
    FETCH_EXCEPTION: 500,
    EMIT_EXCEPTION: 500,
    FETCHER_INITIALIZATION_EXCEPTION: 500,
    EMITTER_INITIALIZATION_EXCEPTION: 500,
    FAILED_TO_INITIALIZE: 500,
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(PIPES_RESULT_STATUSES).sort(), "every status is covered");
  for (const [status, code] of Object.entries(expected) as Array<[PipesResultStatus, number]>) {
    assert.equal(httpResponseFor(status).status, code, status);
  }
});

test("Retry-After comes with 503 (5 s) and 429 (the wait held for, at least 1 s) and with nothing else", () => {
  for (const status of ["TIMEOUT", "OOM", "UNSPECIFIED_CRASH"] as const) assert.equal(httpResponseFor(status, 30).retryAfterSeconds, 5, status);
  assert.equal(httpResponseFor("CLIENT_UNAVAILABLE_WITHIN_MS", 30).retryAfterSeconds, 30);
  assert.equal(httpResponseFor("CLIENT_UNAVAILABLE_WITHIN_MS", 0.2).retryAfterSeconds, 1);
  // Tika cuts the milliseconds to whole seconds (1500 ms is 1, 30 900 ms is 30); it does not round up.
  assert.equal(httpResponseFor("CLIENT_UNAVAILABLE_WITHIN_MS", 1.5).retryAfterSeconds, 1);
  assert.equal(httpResponseFor("CLIENT_UNAVAILABLE_WITHIN_MS", 30.9).retryAfterSeconds, 30);
  // A wait of nothing must not become `Retry-After: 0`, which tells a client to retry at once.
  assert.equal(httpResponseFor("CLIENT_UNAVAILABLE_WITHIN_MS", 0).retryAfterSeconds, 1);
  assert.equal(httpResponseFor("CLIENT_UNAVAILABLE_WITHIN_MS", -3).retryAfterSeconds, 1);
  assert.equal(httpResponseFor("CLIENT_UNAVAILABLE_WITHIN_MS").retryAfterSeconds, 1);
  for (const status of ["EMIT_SUCCESS", "FETCHER_NOT_FOUND", "PAYLOAD_LIMIT_EXCEEDED", "FETCH_EXCEPTION"] as const) {
    assert.equal(httpResponseFor(status, 30).retryAfterSeconds, undefined, status);
  }
});

test("a processor whose settings name the language filter needs the identifier it is given, and runs it on what it emits", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "a.txt"), "content of a");
    const settings = loadConfig({
      fetchers: { fsf: { "file-system-fetcher": { basePath: paths.input } } },
      emitters: { fse: { "file-system-emitter": { basePath: paths.output, fileExtension: "json", onExists: "REPLACE" } } },
      pipes: { parseMode: "RMETA" },
      "metadata-filters": [{ "charsoup-metadata-filter": {} }],
    }).pipes!;
    assert.throws(() => new AsyncProcessor(settings), /"charsoup-metadata-filter" needs a language identifier/);

    const languageIdentifier: LanguageIdentifier = { identify: () => ({ language: "xyz", confidence: "HIGH", rawScore: 1 }) };
    const processor = new AsyncProcessor(settings, { metadataFilterServices: { languageIdentifier } });
    try {
      assert.equal(await processor.offer([tuple("a.txt")], 1_000), true);
      await until(() => existsSync(join(paths.output, "a.txt.json")), "a.txt to be emitted");
      const [document] = JSON.parse(readFileSync(join(paths.output, "a.txt.json"), "utf8")) as Array<Record<string, string>>;
      assert.equal(document?.["tk:detected-language"], "xyz");
      assert.equal(document?.["tk:detected-language-confidence-raw"], "1.0");
    } finally {
      await processor.close();
    }
  }));
