import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { mock, test } from "node:test";
import { LimitExceededError, Ripstream, type ParseRecord } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import {
  PipesEngine,
  type EmittedDocument,
  type Emitter,
  type PipeDocument,
  type PipeMode,
} from "../src/index.ts";

const TIMEOUT = { timeout: 20_000 };
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

/** Minimal "stored" (uncompressed) zip writer; fflate is not a dependency of this package. */
function storedZip(files: Readonly<Record<string, string>>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

function zipDocument(id: string, entries = 3): PipeDocument {
  const files: Record<string, string> = {};
  for (let index = 0; index < entries; index++) files[`${id}-e${index}.txt`] = `entry ${index} of ${id}`;
  return { id, data: storedZip(files) };
}

/** Expected UNPACK ids for a source, in parseRecursive order. */
async function expectedUnpackIds(document: PipeDocument): Promise<string[]> {
  const records = await createRipstream().parseRecursive(document.data, { filename: document.id });
  return records.map((record) => `${document.id}${record.embeddedResourcePath}`);
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
      fetcher: textFetcher(ids),
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
      fetcher: textFetcher(ids),
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
      fetcher: documentFetcher(documents),
      emitter,
      mode: "UNPACK",
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
      fetcher: documentFetcher(documents),
      emitter,
      mode: "UNPACK",
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
    fetcher: textFetcher(ids),
    emitter,
    mode: "UNPACK",
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
    fetcher: textFetcher(["x", "y", "z"]),
    emitter,
    mode: "UNPACK",
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
      fetcher: textFetcher([]),
      emitter,
      mode,
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
      fetcher: textFetcher(ids),
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
    fetcher: documentFetcher(documents),
    emitter,
    mode: "UNPACK",
    concurrency: 3,
  }).run();
  assert.equal(result, 3);
  assert.deepEqual([...emitter.ids].sort(), [...expected].sort());
});

test("unordered still emits every document", TIMEOUT, async () => {
  const ids = idsOf(30);
  const emitter = new DelayedSpyEmitter(2);
  assert.equal(await new PipesEngine({ fetcher: textFetcher(ids), emitter, concurrency: 5 }).run(), 30);
  assert.deepEqual([...emitter.ids].sort(), [...ids].sort());
});

test("CONCATENATE keeps fetch order and a single final emit", TIMEOUT, async (t) => {
  t.after(() => mock.restoreAll());
  const ids = idsOf(8);
  hookParsing({ delay: (filename) => (8 - Number(filename.slice(1))) * 4 });
  const emitter = new DelayedSpyEmitter(1);
  await new PipesEngine({ fetcher: textFetcher(ids), emitter, mode: "CONCATENATE", concurrency: 4 }).run();
  assert.deepEqual(emitter.ids, ["concatenated"]);
  const text = emitter.documents[0]?.text ?? "";
  const positions = ids.map((id) => text.indexOf(`text of ${id}`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test("ordered: a failing document rejects with the original error, emits a strict prefix, closes once", TIMEOUT, async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `doc${index}.txt`);
  const fetcher = {
    async *fetch() {
      for (const [index, id] of ids.entries()) {
        yield { id, data: encoder.encode(index === 3 ? "x".repeat(5000) : `small ${index}`) };
      }
    },
  };
  const emitter = new DelayedSpyEmitter(5);
  const engine = new PipesEngine({
    fetcher,
    emitter,
    concurrency: 3,
    maxQueue: 1,
    ordered: true,
    limits: { maxOutputChars: 100 },
  });
  await assert.rejects(engine.run(), LimitExceededError);
  assert.equal(emitter.closes, 1);
  assert.equal(engine.stats.failed, 1);
  assert.equal(emitter.inFlight, 0, "no emit in flight when run() rejects");
  const emitsAtReject = emitter.ids.length;
  await sleep(100);
  assert.equal(emitter.ids.length, emitsAtReject, "no late emits");
  assert.equal(emitter.closes, 1);
  assert.deepEqual(emitter.ids, ids.slice(0, emitter.ids.length), "strict prefix of fetch order");
  assert.ok(!emitter.ids.includes("doc3.txt"));
  assert.ok(emitter.ids.length <= 3);
});

test("ordered: abort while workers are parked on the window gate does not hang", TIMEOUT, async (t) => {
  t.after(() => mock.restoreAll());
  const boom = new Error("boom");
  hookParsing({ fail: (filename) => (filename === "d1" ? boom : null) });
  const emitter = new DelayedSpyEmitter(60);
  const engine = new PipesEngine({
    fetcher: textFetcher(idsOf(20)),
    emitter,
    concurrency: 4,
    maxBuffered: 2,
    ordered: true,
  });
  await assert.rejects(engine.run(), (error) => error === boom);
  assert.equal(emitter.closes, 1);
  assert.equal(emitter.inFlight, 0);
  assert.equal(engine.stats.failed, 1);
  assert.deepEqual(emitter.ids, emitter.ids.slice().sort(), "prefix in order");
  assert.ok(emitter.ids.length <= 1, "only d0 can have been emitted");
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
    const run = new PipesEngine({ fetcher: textFetcher(ids), emitter, ordered: true, ...options }).run();
    await sleep(150);
    assert.equal(started, expectedWindow, `parses started while the head is blocked (${JSON.stringify(options)})`);
    release();
    assert.equal(await run, 30);
    assert.deepEqual(emitter.ids, ids);
  }
});
