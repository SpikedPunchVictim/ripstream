// Q2/Q3: does the work-unit model (eager document / lazy closure / lazy tuple) change throughput or memory?
// Throwaway spike for tikajs-68os.6.2 (evidence: tasks/parity/audits/pipes-model-spike.md). Needs `pnpm run build`.
// Run: `node throughput-and-memory.mjs q2`, and for memory one process per engine: `node --expose-gc throughput-and-memory.mjs q3 E|J|T`.
// Three engines over the same parser:
//   E  today's PipesEngine, fetcher = AsyncIterable that reads the bytes inside iteration (as FileSystemFetcher/HttpFetcher do)
//   J  lazy closure items {id, open()}, opened inside the worker
//   T  lazy tuples {id, fetcher, fetchKey} (plain data), resolved through a registry inside the worker
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../../../../packages/", import.meta.url).pathname;
const { PipesEngine } = await import(`${REPO}pipes/dist/index.js`);
const { createRipstream } = await import(`${REPO}parsers/dist/index.js`);

const sleep = (ms) => (ms === 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
const ripstream = createRipstream();

async function runLazy({ items, resolve, concurrency, mode, emit }) {
  const it = items[Symbol.asyncIterator]();
  let pulling = Promise.resolve();
  const pull = () => (pulling = pulling.then(() => it.next()));
  let done = 0;
  const worker = async () => {
    for (;;) {
      const r = await pull();
      if (r.done) return;
      const bytes = await resolve(r.value);
      if (mode === "NO_PARSE") await emit({ id: r.value.id, bytes });
      else {
        const parsed = await ripstream.parse(bytes, { filename: r.value.id, onDocumentFailure: "record" });
        await emit({ id: r.value.id, text: parsed.text });
      }
      done++;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return done;
}

function makeCorpus(count, bytes) {
  const dir = mkdtempSync(join(tmpdir(), "spike-corpus-"));
  const body = Buffer.alloc(bytes, "lorem ipsum dolor sit amet\n");
  const names = [];
  for (let i = 0; i < count; i++) {
    const name = `f${String(i).padStart(5, "0")}.txt`;
    writeFileSync(join(dir, name), body);
    names.push(name);
  }
  return { dir, names };
}

function variants({ dir, names }, latency, concurrency, mode, emit) {
  const read = async (name) => {
    await sleep(latency);
    return readFile(join(dir, name));
  };
  return {
    E: () =>
      new PipesEngine({
        mode,
        concurrency,
        emitter: { emit },
        fetcher: {
          async *fetch() {
            for (const name of names) yield { id: name, data: await read(name) };
          },
        },
      }).run(),
    J: () =>
      runLazy({
        mode,
        concurrency,
        emit,
        resolve: (item) => item.open(),
        items: (async function* () {
          for (const name of names) yield { id: name, open: () => read(name) };
        })(),
      }),
    T: () => {
      const fetchers = new Map([["fs", { fetch: (key) => read(key) }]]);
      return runLazy({
        mode,
        concurrency,
        emit,
        resolve: (tuple) => fetchers.get(tuple.fetcher).fetch(tuple.fetchKey),
        items: (async function* () {
          for (const name of names) yield { id: name, fetcher: "fs", fetchKey: name };
        })(),
      });
    },
  };
}

const mb = (n) => (n / 1048576).toFixed(0);

const WHICH = process.argv[2] ?? "q2";
const ONLY = process.argv[3];

// ---- Q2: throughput under fetch latency
const N = 300;
if (WHICH === "q2") {
const corpus = makeCorpus(N, 2000);
console.log(`Q2 throughput: ${N} files x 2 KB, CONTENT_ONLY, fetch latency injected per file; files/s (median of 3)`);
console.log("latency  conc  " + ["E", "J", "T"].map((v) => v.padStart(8)).join(""));
for (const latency of [0, 20, 100]) {
  for (const concurrency of [4, 16]) {
    const row = {};
    for (const name of ["E", "J", "T"]) {
      const rates = [];
      for (let rep = 0; rep < 3; rep++) {
        let emitted = 0;
        const run = variants(corpus, latency, concurrency, "CONTENT_ONLY", () => void emitted++)[name];
        const began = performance.now();
        await run();
        if (emitted !== N) throw new Error(`${name} emitted ${emitted}`);
        rates.push((N / (performance.now() - began)) * 1000);
      }
      rates.sort((a, b) => a - b);
      row[name] = rates[1];
    }
    console.log(`${String(latency).padStart(5)} ms ${String(concurrency).padStart(4)}  ` + ["E", "J", "T"].map((v) => row[v].toFixed(0).padStart(8)).join(""));
  }
}
rmSync(corpus.dir, { recursive: true, force: true });
}

// ---- Q3: bytes held when the emitter is slower than the fetcher
const BIG = 60; // files
const SIZE = 20 * 1024 * 1024;
if (WHICH === "q3") {
const big = makeCorpus(BIG, SIZE);
console.log(`Q3 memory: ${BIG} files x ${mb(SIZE)} MB, NO_PARSE, emitter takes 100 ms per file, concurrency 4; peak live Buffer bytes and RSS`);
for (const name of [ONLY]) {
  global.gc?.();
  const base = process.memoryUsage().rss;
  let peak = base;
  let peakBuffers = 0;
  const sampler = setInterval(() => {
    const usage = process.memoryUsage();
    peak = Math.max(peak, usage.rss);
    peakBuffers = Math.max(peakBuffers, usage.arrayBuffers);
  }, 5);
  let emitted = 0;
  await variants(big, 0, 4, "NO_PARSE", async () => {
    await sleep(100);
    emitted++;
  })[name]();
  clearInterval(sampler);
  console.log(`${name}: peak Buffer bytes ${mb(peakBuffers)} MB, peak RSS ${mb(peak)} MB (baseline ${mb(base)} MB), emitted ${emitted}`);
  global.gc?.();
  await sleep(300);
}
rmSync(big.dir, { recursive: true, force: true });
}
