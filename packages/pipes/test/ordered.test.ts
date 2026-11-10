import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { LimitExceededError, Ripstream, TIKA_KEYS, type ParseRecord } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import {
  PipesEngine,
  type EmittedDocument,
  type Emitter,
  type PipeDocument,
  type PipeMode,
} from "../src/index.ts";
import { storedZip } from "./helpers.ts";

const TIMEOUT = { timeout: 20_000 };
/** These tests are about order, not layout: each embedded document is its own emit, as REGULAR gives. */
const REGULAR = { outputFormat: "REGULAR" } as const;
const encoder = new TextEncoder();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Async emitter that tracks call order, in-flight count and max in-flight. */
class DelayedSpyEmitter implements Emitter {
  readonly ids: string[] = [];
  readonly completed: string[] = [];
  readonly documents: EmittedDocument[] = [];
  inFlight = 0;
  maxInFlight = 0;
  closes = 0;
  readonly #delayMs: number;
  /** Optional gate: emits park here until released (for backpressure tests). */
  gate: Promise<void> | null = null;

  constructor(delayMs = 20) {
    this.#delayMs = delayMs;
  }

  async emit(document: EmittedDocument): Promise<void> {
    this.ids.push(document.id);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate !== null) await this.gate;
      await sleep(this.#delayMs);
      this.completed.push(document.id);
      this.documents.push(document);
    } finally {
      this.inFlight--;
    }
  }

  close(): void {
    this.closes++;
  }
}

function textFetcher(ids: readonly string[]): { fetch(): AsyncIterable<PipeDocument> } {
  return {
    async *fetch() {
      for (const id of ids) yield { id, data: encoder.encode(`text of ${id}`) };
    },
  };
}

function documentFetcher(documents: readonly PipeDocument[]): { fetch(): AsyncIterable<PipeDocument> } {
  return {
    async *fetch() {
      yield* documents;
    },
  };
}

function zipDocument(id: string, entries = 3): PipeDocument {
  const files: Record<string, string> = {};
  for (let index = 0; index < entries; index++) files[`${id}-e${index}.txt`] = `entry ${index} of ${id}`;
  return { id, data: storedZip(files) };
}

/** Expected UNPACK ids for a source: the document's own metadata, then the bytes of each embedded document by embedded id. */
async function expectedUnpackIds(document: PipeDocument): Promise<string[]> {
  const records = await createRipstream().parseRecursive(document.data, { filename: document.id, unpackBytes: 1 << 20 });
  const embedded = records.filter((record) => record.bytes !== undefined).map((record) => `${document.id}-embed/${record.metadata.get(TIKA_KEYS.EMBEDDED_ID)}`);
  return [document.id, ...embedded];
}

interface ParseHooks {
  /** Delay in ms before the real parse/parseRecursive runs, keyed by filename. */
  readonly delay?: (filename: string) => number;
  /** Return true to make parseRecursive yield zero records for this filename. */
  readonly empty?: (filename: string) => boolean;
  /** Throw this for the filename instead of parsing. */
  readonly fail?: (filename: string) => Error | null;
  /** Called when a parse starts. */
  readonly onStart?: (filename: string) => void;
}

/** Wraps Ripstream.parse / parseRecursive to control per-document timing deterministically. */
function hookParsing(hooks: ParseHooks): void {
  const proto = Ripstream.prototype;
  const originalParse = proto.parse;
  const originalRecursive = proto.parseRecursive;
  const before = async (filename: string): Promise<void> => {
    hooks.onStart?.(filename);
    const failure = hooks.fail?.(filename) ?? null;
    const wait = hooks.delay?.(filename) ?? 0;
    if (wait > 0) await sleep(wait);
    if (failure !== null) throw failure;
  };
  mock.method(proto, "parse", async function (this: Ripstream, ...args: Parameters<Ripstream["parse"]>) {
    await before(args[1]?.filename ?? "");
    return originalParse.apply(this, args);
  });
  mock.method(proto, "parseRecursive", async function (
    this: Ripstream,
    ...args: Parameters<Ripstream["parseRecursive"]>
  ): Promise<readonly ParseRecord[]> {
    const filename = args[1]?.filename ?? "";
    await before(filename);
    if (hooks.empty?.(filename) === true) return [];
    return originalRecursive.apply(this, args);
  });
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const idsOf = (count: number): string[] => Array.from({ length: count }, (_, index) => `d${index}`);

test("ordered: async emitter never re-enters and emits each doc once in fetch order (#26)", TIMEOUT, async () => {
  for (const [count, concurrency] of [[6, 6], [40, 4], [40, 6]] as const) {
    const ids = idsOf(count);
    const emitter = new DelayedSpyEmitter(20);
    const result = await new PipesEngine({
      source: textFetcher(ids),
      emitter,
      concurrency,
      ordered: true,
    }).run();
    const label = `${count} docs @ ${concurrency}`;
    assert.equal(result, count, label);
    assert.equal(emitter.ids.length, count, `${label}: emit count`);
    assert.equal(new Set(emitter.ids).size, count, `${label}: unique ids`);
    assert.deepEqual(emitter.ids, ids, `${label}: fetch order`);
    assert.equal(emitter.maxInFlight, 1, `${label}: serialized emits`);
    assert.equal(emitter.closes, 1, label);
  }
});

test("ordered: shuffled parse completion order still emits in fetch order (#26)", TIMEOUT, async (t) => {
  t.after(() => mock.restoreAll());
  const count = 24;
  const ids = idsOf(count);
  const scenarios: Array<[string, (filename: string) => number]> = [
    ["head finishes last", (filename) => (filename === "d0" ? 80 : 1)],
    ["head finishes first", (filename) => (filename === "d0" ? 1 : 15 + (Number(filename.slice(1)) % 3) * 10)],
    ["reverse completion", (filename) => (count - Number(filename.slice(1))) * 3],
    ...[1, 2, 3, 4, 5].map((seed): [string, (filename: string) => number] => {
      const random = seeded(seed);
      const delays = new Map(ids.map((id) => [id, Math.floor(random() * 30)]));
      return [`random seed ${seed}`, (filename) => delays.get(filename) ?? 0];
    }),
  ];
  for (const [label, delay] of scenarios) {
    mock.restoreAll();
    hookParsing({ delay });
    const emitter = new DelayedSpyEmitter(2);
    const result = await new PipesEngine({
      source: textFetcher(ids),
      emitter,
      concurrency: 5,
      ordered: true,
    }).run();
    assert.equal(result, count, label);
    assert.deepEqual(emitter.ids, ids, label);
    assert.equal(emitter.maxInFlight, 1, label);
  }
});

test("ordered UNPACK: every record of every zip is emitted, contiguous per source in fetch order (#27)", TIMEOUT, async (t) => {
  t.after(() => mock.restoreAll());
  for (const [zipCount, concurrency] of [[2, 2], [3, 3], [3, 2]] as const) {
    mock.restoreAll();
    const documents = Array.from({ length: zipCount }, (_, index) => zipDocument(`zip${index}.zip`));
    const expected = (await Promise.all(documents.map(expectedUnpackIds))).flat();
    assert.equal(expected.length, zipCount * 4, "root + 3 entries per zip");
    hookParsing({ delay: (filename) => (filename === "zip0.zip" ? 60 : 1) });
    const emitter = new DelayedSpyEmitter(5);
    const result = await new PipesEngine({
      source: documentFetcher(documents),
      emitter,
      mode: "UNPACK",
      unpack: REGULAR,
      concurrency,
      ordered: true,
    }).run();
    const label = `${zipCount} zips @ ${concurrency}`;
    assert.equal(result, zipCount, label);
    assert.deepEqual(emitter.ids, expected, label);
    assert.equal(emitter.maxInFlight, 1, label);
  }
});

test("ordered UNPACK: early-arriving later zips and slow middle zip keep per-source grouping (#27)", TIMEOUT, async (t) => {
  t.after(() => mock.restoreAll());
  const delays: Array<[string, (filename: string) => number]> = [
    ["head first, rest late", (filename) => (filename === "zip0.zip" ? 1 : 40)],
    ["slow middle", (filename) => (filename === "zip2.zip" ? 70 : 1)],
    ["reverse", (filename) => (4 - Number(filename.slice(3, 4))) * 20],
  ];
  for (const [label, delay] of delays) {
    mock.restoreAll();
    const documents = Array.from({ length: 5 }, (_, index) => zipDocument(`zip${index}.zip`, 2));
    const expected = (await Promise.all(documents.map(expectedUnpackIds))).flat();
    hookParsing({ delay });
    const emitter = new DelayedSpyEmitter(3);
    const result = await new PipesEngine({
      source: documentFetcher(documents),
      emitter,
      mode: "UNPACK",
      unpack: REGULAR,
      concurrency: 3,
      ordered: true,
    }).run();
    assert.equal(result, 5, label);
    assert.deepEqual(emitter.ids, expected, label);
    assert.equal(emitter.maxInFlight, 1, label);
  }
});

test("ordered UNPACK: zero-record inputs at head, middle and tail do not stall or reorder", TIMEOUT, async (t) => {
  t.after(() => mock.restoreAll());
  const ids = ["empty-head", "a.txt", "empty-mid", "b.txt", "empty-tail"];
  hookParsing({
    empty: (filename) => filename.startsWith("empty"),
    delay: (filename) => (filename === "empty-head" ? 30 : 1),
  });
  const emitter = new DelayedSpyEmitter(3);
  const engine = new PipesEngine({
    source: textFetcher(ids),
    emitter,
    mode: "UNPACK",
    unpack: REGULAR,
    concurrency: 3,
    ordered: true,
  });
  const result = await engine.run();
  assert.equal(result, 5, "run() counts every source drained, empty ones included");
  assert.equal(engine.stats.emitted, 5);
  assert.deepEqual(emitter.ids.map((id) => id.replace(/\/.*$/, "")), ["a.txt", "b.txt"]);
  assert.equal(emitter.closes, 1);
});

test("ordered UNPACK: only zero-record inputs terminates cleanly", TIMEOUT, async (t) => {
  t.after(() => mock.restoreAll());
  hookParsing({ empty: () => true });
  const emitter = new DelayedSpyEmitter(1);
  const result = await new PipesEngine({
    source: textFetcher(["x", "y", "z"]),
    emitter,
    mode: "UNPACK",
    unpack: REGULAR,
    concurrency: 2,
    ordered: true,
  }).run();
  assert.equal(result, 3);
  assert.deepEqual(emitter.ids, []);
});

test("ordered: an empty input stream terminates cleanly and closes once", TIMEOUT, async () => {
  for (const mode of ["CONTENT_ONLY", "UNPACK", "NO_PARSE"] as const satisfies readonly PipeMode[]) {
    const emitter = new DelayedSpyEmitter(1);
    const engine = new PipesEngine({
      source: textFetcher([]),
      emitter,
      mode,
      unpack: REGULAR,
      concurrency: 3,
      ordered: true,
    });
    assert.equal(await engine.run(), 0, mode);
    assert.equal(emitter.closes, 1, mode);
    assert.equal(engine.stats.fetched, 0, mode);
  }
});

test("ordered: NO_PARSE and RMETA also emit once each in fetch order", TIMEOUT, async () => {
  for (const mode of ["NO_PARSE", "RMETA"] as const) {
    const ids = idsOf(15);
    const emitter = new DelayedSpyEmitter(4);
    const result = await new PipesEngine({
      source: textFetcher(ids),
      emitter,
      mode,
      concurrency: 4,
      ordered: true,
    }).run();
    assert.equal(result, 15, mode);
    assert.deepEqual(emitter.ids, ids, mode);
    assert.equal(emitter.maxInFlight, 1, mode);
  }
});

test("unordered UNPACK still emits every record of every zip", TIMEOUT, async () => {
  const documents = Array.from({ length: 3 }, (_, index) => zipDocument(`zip${index}.zip`));
  const expected = (await Promise.all(documents.map(expectedUnpackIds))).flat();
  const emitter = new DelayedSpyEmitter(3);
  const result = await new PipesEngine({
    source: documentFetcher(documents),
    emitter,
    mode: "UNPACK",
    unpack: REGULAR,
    concurrency: 3,
  }).run();
  assert.equal(result, 3);
  assert.deepEqual([...emitter.ids].sort(), [...expected].sort());
});

test("unordered still emits every document", TIMEOUT, async () => {
  const ids = idsOf(30);
  const emitter = new DelayedSpyEmitter(2);
  assert.equal(await new PipesEngine({ source: textFetcher(ids), emitter, concurrency: 5 }).run(), 30);
  assert.deepEqual([...emitter.ids].sort(), [...ids].sort());
});

test("CONCATENATE emits one document per input, in fetch order when ordered", TIMEOUT, async (t) => {
  t.after(() => mock.restoreAll());
  const ids = idsOf(8);
  hookParsing({ delay: (filename) => (8 - Number(filename.slice(1))) * 4 });
  const emitter = new DelayedSpyEmitter(1);
  const result = await new PipesEngine({ source: textFetcher(ids), emitter, mode: "CONCATENATE", concurrency: 4, ordered: true }).run();
  assert.equal(result, 8);
  assert.deepEqual(emitter.ids, ids);
  assert.deepEqual(
    emitter.documents.map((document) => document.text?.trim()),
    ids.map((id) => `text of ${id}`),
    "each input's own content, not one text for the run",
  );
});

test("ordered: a document over a limit is a result in its place, and the rest are emitted in fetch order", TIMEOUT, async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `doc${index}.txt`);
  const fetcher = {
    async *fetch() {
      for (const [index, id] of ids.entries()) {
        yield { id, data: encoder.encode(index === 3 ? "x".repeat(5000) : `small ${index}`) };
      }
    },
  };
  const emitter = new DelayedSpyEmitter(5);
  const heard: string[] = [];
  const engine = new PipesEngine({
    source: fetcher,
    emitter,
    concurrency: 3,
    maxQueue: 1,
    ordered: true,
    limits: { maxOutputChars: 100 },
    reporter: { report: (result) => void heard.push(`${result.id}:${result.status}`) },
  });
  assert.equal(await engine.run(), 11);
  assert.equal(emitter.closes, 1);
  assert.equal(emitter.inFlight, 0);
  assert.deepEqual(emitter.ids, ids.filter((id) => id !== "doc3.txt"), "every other input, in fetch order");
  assert.deepEqual(
    heard,
    ids.map((id) => `${id}:${id === "doc3.txt" ? "PAYLOAD_LIMIT_EXCEEDED" : "EMIT_SUCCESS"}`),
    "the reporter hears the failure in its place",
  );
  assert.equal(engine.stats.failed, 1);
});

test("ordered: a reporter that throws ends the run with its error, closes once and parks nothing", TIMEOUT, async () => {
  const boom = new Error("boom");
  const emitter = new DelayedSpyEmitter(60);
  const engine = new PipesEngine({
    source: textFetcher(idsOf(20)),
    emitter,
    concurrency: 4,
    maxBuffered: 2,
    ordered: true,
    reporter: {
      report: (result) => {
        if (result.id === "d1") throw boom;
      },
    },
  });
  await assert.rejects(engine.run(), (error) => error === boom);
  assert.equal(emitter.closes, 1);
  assert.equal(emitter.inFlight, 0);
  assert.deepEqual(emitter.ids, emitter.ids.slice().sort(), "prefix in order");
  assert.ok(emitter.ids.length <= 2, `d0 and d1 only: ${emitter.ids.join(",")}`);
});

test("ordered: maxBuffered bounds how many inputs are in flight ahead of the head", TIMEOUT, async (t) => {
  t.after(() => mock.restoreAll());
  for (const [options, expectedWindow] of [
    [{ concurrency: 4, maxBuffered: 2 }, 2],
    [{ concurrency: 2 }, 8], // default window = concurrency * 4
    [{ concurrency: 3, maxBuffered: 5 }, 5],
  ] as const) {
    mock.restoreAll();
    let started = 0;
    hookParsing({ onStart: () => void started++ });
    const emitter = new DelayedSpyEmitter(1);
    let release!: () => void;
    emitter.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ids = idsOf(30);
    const run = new PipesEngine({ source: textFetcher(ids), emitter, ordered: true, ...options }).run();
    await sleep(150);
    assert.equal(started, expectedWindow, `parses started while the head is blocked (${JSON.stringify(options)})`);
    release();
    assert.equal(await run, 30);
    assert.deepEqual(emitter.ids, ids);
  }
});
