#!/usr/bin/env node
// Reused ("warm") isolation children against one-shot children and in-process parsing (bead tikajs-dasw). Not a
// workspace package, not matched by `pnpm test`.
//
// Throughput: the repository's own fixtures (packages/*/test/fixtures, hazard and chaos fixtures left out), as
// the 20 largest files and 200 small ones (64 KiB or less among the rest, cycled when there are fewer). Each mode x pool size x set
// is run --reps times (default 7) with as many concurrent requests as the pool size; every rep builds a new isolation,
// so the warm rows include starting their children. Every type goes to the child (`inProcessTypes: []`), so the
// one-shot and warm rows measure the child path alone; the in-process row is the same parse with no child at all.
// Reported: the median rep's wall time, files/s from it, and the per-file latency p50/p95 over all reps.
//
// Leak check (--leak): 500 requests on ONE reused child at a time over the small files that parse cleanly (a file
// that makes a child retire, by an exception or anything else, is left out first), without recycling
// (maxRequests 1000) and with the default (100). The RSS of the child that answered is sampled after requests 49, 99,
// ..., 499: with recycling, the 100th request is a child's last and it is gone right after.
//
// usage: node packages/isolation-node/test/bench/warm.mjs [--reps N] [--pools 1,2,4] [--modes in-process,one-shot,warm]
//          [--sets small,large] [--leak] [--leak-only] [--out FILE.json]
//
// Needs `pnpm build` (the standard child and its parsers load from dist). The fixtures are the repository's test
// inputs; they are only read.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryPool } from "../../src/pool.ts";
import { createStandardIsolation } from "../../../bundle-standard/src/isolation.ts";

const ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const SMALL_MAX_BYTES = 64 * 1024;
const SMALL_COUNT = 200;
const LARGE_COUNT = 20;
const LEAK_REQUESTS = 500;
const LEAK_SAMPLE_EVERY = 50;
const SKIP_DIRS = new Set(["node_modules", "dist", "hazard", "chaos"]);
const SKIP_EXT = new Set([".ts", ".mjs", ".js", ".json", ".jsonl", ".md"]);

function parseArgs(argv) {
  const options = {
    reps: 7,
    pools: [1, 2, 4],
    modes: ["in-process", "one-shot", "warm"],
    sets: ["small", "large"],
    leak: false,
    throughput: true,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    switch (flag) {
      case "--reps": options.reps = Number(value()); break;
      case "--pools": options.pools = value().split(",").map(Number); break;
      case "--modes": options.modes = value().split(","); break;
      case "--sets": options.sets = value().split(","); break;
      case "--leak": options.leak = true; break;
      case "--leak-only": options.leak = true; options.throughput = false; break;
      case "--out": options.out = resolve(value()); break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!Number.isSafeInteger(options.reps) || options.reps < 1) throw new Error("--reps must be a positive integer");
  for (const pool of options.pools) if (!Number.isSafeInteger(pool) || pool < 1) throw new Error(`bad pool size ${pool}`);
  for (const mode of options.modes) if (!["in-process", "one-shot", "warm"].includes(mode)) throw new Error(`bad mode ${mode}`);
  for (const set of options.sets) if (!["small", "large"].includes(set)) throw new Error(`bad set ${set}`);
  return options;
}

function fixtureFiles() {
  const files = [];
  const visit = (directory, inFixtures) => {
    for (const entry of readdirSync(directory).sort()) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path, inFixtures || entry === "fixtures");
      else if (inFixtures && stats.isFile() && stats.size > 0 && !SKIP_EXT.has(entry.slice(entry.lastIndexOf(".")).toLowerCase())) {
        files.push({ path, size: stats.size });
      }
    }
  };
  for (const pkg of readdirSync(join(ROOT, "packages")).sort()) {
    const test = join(ROOT, "packages", pkg, "test");
    try {
      if (statSync(test).isDirectory()) visit(test, false);
    } catch {
      // no test directory
    }
  }
  return files;
}

function corpus() {
  const bySize = fixtureFiles().sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const large = bySize.slice(0, LARGE_COUNT);
  const small = bySize.slice(LARGE_COUNT).filter((f) => f.size <= SMALL_MAX_BYTES).sort((a, b) => a.path.localeCompare(b.path));
  if (small.length === 0 || large.length === 0) throw new Error("the repository has no fixtures to measure");
  const load = (f) => ({ name: relative(ROOT, f.path), filename: basename(f.path), bytes: readFileSync(f.path) });
  const smallLoaded = small.map(load);
  return {
    small: Array.from({ length: SMALL_COUNT }, (_, i) => smallLoaded[i % smallLoaded.length]),
    large: large.map(load),
    distinctSmall: small.length,
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

/** A pool for `size` children: the standard reservation of a text request is what the isolator says it needs. */
function makePool(size) {
  return new MemoryPool({ poolMb: size * 4096, maxQueue: 1024 });
}

async function isolationFor(mode, size, extra = {}) {
  const pool = makePool(size);
  const reuse = mode === "warm" ? { reuse: { enabled: true, trustDomain: "bench", maxIdleChildren: Math.max(4, size), ...extra.reuse } } : {};
  const standard = await createStandardIsolation({
    config: { mode: mode === "in-process" ? "off" : "strict" },
    pool,
    inProcessTypes: [],
    ...reuse,
    ...(extra.runner === undefined ? {} : { runner: extra.runner }),
  });
  return {
    standard,
    async dispose() {
      await standard.isolator.dispose();
      pool.dispose();
    },
  };
}

/** Runs `documents` with `concurrency` requests in flight; returns the wall time, latencies and failures. */
async function runSet(standard, documents, concurrency) {
  let next = 0;
  const latencies = [];
  const failed = new Map();
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= documents.length) return;
      const document = documents[index];
      const started = performance.now();
      try {
        await standard.ripstream.parse(document.bytes, { filename: document.filename });
      } catch (error) {
        // A document that fails is still a request answered; which ones fail is reported.
        failed.set(document.name, `${error?.name}: ${String(error?.message).slice(0, 120)}`);
      }
      latencies.push(performance.now() - started);
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { wallMs: performance.now() - started, latencies, failed };
}

async function throughput(options, sets) {
  const rows = [];
  for (const setName of options.sets) {
    const documents = sets[setName];
    for (const mode of options.modes) {
      for (const size of options.pools) {
        const walls = [];
        const latencies = [];
        let failed = new Map();
        let reuse = null;
        for (let rep = 0; rep < options.reps; rep++) {
          const { standard, dispose } = await isolationFor(mode, size);
          try {
            const result = await runSet(standard, documents, size);
            walls.push(result.wallMs);
            latencies.push(...result.latencies);
            failed = result.failed;
            reuse = standard.isolator.status().reuse ?? null;
          } finally {
            await dispose();
          }
        }
        const wallMs = median(walls);
        const row = {
          set: setName,
          mode,
          pool: size,
          files: documents.length,
          medianWallMs: Math.round(wallMs),
          filesPerSec: Number(((documents.length * 1000) / wallMs).toFixed(1)),
          p50Ms: Number(percentile(latencies, 50).toFixed(1)),
          p95Ms: Number(percentile(latencies, 95).toFixed(1)),
          failed: Object.fromEntries(failed),
          ...(reuse === null ? {} : { lastRepReuse: reuse }),
        };
        rows.push(row);
        console.error(JSON.stringify(row));
      }
    }
  }
  return rows;
}

function rssMbOf(pid) {
  try {
    return Math.round(Number(execFileSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024);
  } catch {
    return null; // gone
  }
}

/** The small files that a reused child answers without being retired. */
async function cleanFiles(documents) {
  const distinct = [...new Map(documents.map((d) => [d.name, d])).values()];
  const { standard, dispose } = await isolationFor("warm", 1, { reuse: { maxRequests: 1000 } });
  const clean = [];
  try {
    for (const document of distinct) {
      const before = Object.values(standard.isolator.status().reuse.retired).reduce((a, b) => a + b, 0);
      try {
        await standard.ripstream.parse(document.bytes, { filename: document.filename });
      } catch {
        continue;
      }
      const after = Object.values(standard.isolator.status().reuse.retired).reduce((a, b) => a + b, 0);
      if (after === before) clean.push(document);
    }
  } finally {
    await dispose();
  }
  return { clean, distinct: distinct.length };
}

async function leak(sets) {
  const { clean, distinct } = await cleanFiles(sets.small);
  if (clean.length === 0) throw new Error("no small file parses cleanly on a reused child");
  const runs = [];
  for (const maxRequests of [1000, 100]) {
    let lastPid;
    const { standard, dispose } = await isolationFor("warm", 1, {
      reuse: { maxRequests, rssSampleEvery: 1000 },
      runner: { onRunSettled: (d) => (lastPid = d.pid) },
    });
    const samples = [];
    const started = performance.now();
    try {
      for (let i = 1; i <= LEAK_REQUESTS; i++) {
        const document = clean[(i - 1) % clean.length];
        await standard.ripstream.parse(document.bytes, { filename: document.filename });
        if (i % LEAK_SAMPLE_EVERY === LEAK_SAMPLE_EVERY - 1) samples.push({ request: i, pid: lastPid, rssMb: rssMbOf(lastPid) });
      }
      const status = standard.isolator.status().reuse;
      runs.push({ maxRequests, wallMs: Math.round(performance.now() - started), spawned: status.spawned, retired: status.retired, samples });
    } finally {
      await dispose();
    }
    console.error(JSON.stringify(runs.at(-1)));
  }
  return { cleanFiles: clean.length, distinctSmallFiles: distinct, requests: LEAK_REQUESTS, runs };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sets = corpus();
  const report = {
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    cpus: (await import("node:os")).cpus().length,
    corpus: { small: sets.small.length, distinctSmall: sets.distinctSmall, large: sets.large.length, largeBytes: sets.large.reduce((a, d) => a + d.bytes.length, 0) },
    reps: options.reps,
  };
  if (options.throughput) report.throughput = await throughput(options, sets);
  if (options.leak) report.leak = await leak(sets);
  const text = JSON.stringify(report, null, 2);
  if (options.out !== null) writeFileSync(options.out, `${text}\n`);
  console.log(text);
}

await main();
