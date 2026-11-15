#!/usr/bin/env node
/**
 * Runs xberg's benchmark methodology (tools/benchmark-harness, single-file mode) over
 * ripstream, Apache Tika and xberg, and writes results.json plus summary.md.
 *
 * Meant to run inside the image built from scripts/bench/docker/Dockerfile, where Java,
 * Tika 4.2.0, the xberg CLI, GNU time and a built ripstream all live at the default paths.
 * See scripts/bench/docker/run.sh for the whole sequence.
 *
 * Usage:
 *   node scripts/bench/run.ts --fixtures <harness fixtures dir> --corpus <dir> [--corpus <dir>]... [options]
 *
 * Fixture selection (the common cohort: Tika-listed format, no OCR, document and ground truth present):
 *   --cohort <file.json>     restrict to a harness cohort (repeatable); batches use its batch_size
 *   --types <list>           restrict to file types, e.g. eml,csv,json
 *   --limit-per-type <n>     at most n fixtures per file type (0 = all)
 *
 * Methodology (harness defaults):
 *   -i, --iterations <n>     measured runs per fixture (default 3)
 *   -w, --warmup <n>         discarded runs per fixture (default 1)
 *   -t, --timeout <s>        per-extraction timeout (default 1800; Tika is capped at 180)
 *   --frameworks <list>      default ripstream-cli,ripstream-inproc,tika,tika-warm,xberg
 *   --batch <list>           default xberg-batch,ripstream-batch,tika-batch ("" to skip)
 *   --batch-size <n>         batch size outside a cohort (default 8)
 *
 * Tools and output:
 *   --ripstream-root <dir>   built ripstream checkout (default /opt/ripstream)
 *   --ripstream-config <f>   ripstream config for the CLI and the worker (default ripstream-config.json beside
 *                            this script: writeLimit -1, matching TikaExtract; "" keeps ripstream's defaults)
 *   --ripstream-email-headers  parse emails with ParseOptions.emailHeaders (the Subject/From/To/CC/BCC/Date block ahead
 *                            of the body) in the worker lanes (ripstream-inproc, ripstream-batch); off by default
 *   --tika-classpath <cp>    (default /opt/bench/tika-classes:/opt/tika-server/lib/*)
 *   --xberg <path>           (default /opt/xberg/xberg)
 *   --java <path>            (default java)
 *   --time <path>            GNU time for peak RSS (default /usr/bin/time; "" disables RSS)
 *   --out <dir>              (default artifacts/bench-xberg)
 *   --label <text>           free text recorded in the results
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapters, type Adapter, type BatchAdapter, type ErrorKind, type Extraction } from "./adapters.ts";
import { exclusionReason, loadCohort, loadFixtures, type Cohort, type Fixture, type Skipped } from "./fixtures.ts";
import { computeQuality, type QualityMetrics } from "./quality.ts";
import { writeReport } from "./report.ts";

export interface Iteration {
  readonly wallMs: number;
  readonly rssBytes: number | null;
  readonly reportedMs?: number;
}

export interface TaskResult {
  readonly framework: string;
  readonly regime: Adapter["regime"];
  readonly fixture: string;
  readonly fileType: string;
  readonly group: string;
  readonly fileSize: number;
  readonly success: boolean;
  readonly errorKind: ErrorKind;
  readonly error?: string;
  readonly iterations: readonly Iteration[];
  readonly quality: QualityMetrics | null;
  readonly coldStartMs?: number;
}

export interface BatchResult {
  readonly framework: string;
  readonly batch: string;
  readonly fixtures: readonly string[];
  readonly totalBytes: number;
  readonly iterations: readonly { wallMs: number; rssBytes: number | null; succeeded: number; error?: string }[];
}

export interface RunMeta {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly label: string;
  readonly options: Record<string, unknown>;
  readonly environment: Record<string, unknown>;
  readonly coldStartMs: Record<string, number>;
  /** Absent in results written before it was recorded. */
  readonly warmProcessStartupMs?: Record<string, number>;
  readonly warmProcessPeakRssBytes: Record<string, number | null>;
}

const benchDir = dirname(fileURLToPath(import.meta.url));
const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
mkdirSync(options.out, { recursive: true });
const scratchDir = join(options.out, ".scratch");
mkdirSync(scratchDir, { recursive: true });
const partialFile = join(options.out, "results.partial.jsonl");
writeFileSync(partialFile, "");

const { fixtures: allFixtures, invalid } = loadFixtures(options.fixtures, options.corpus);
const { selected, skipped, cohorts } = selectFixtures(allFixtures);
skipped.push(...invalid);
log(`fixtures: ${allFixtures.length} loaded, ${selected.length} selected, ${skipped.length} skipped`);

const registry = createAdapters({
  node: process.execPath,
  java: options.java,
  ripstreamRoot: options.ripstreamRoot,
  ripstreamConfig: options.ripstreamConfig,
  ripstreamEmailHeaders: options.ripstreamEmailHeaders,
  tikaClasspath: options.tikaClasspath,
  xberg: options.xberg,
  benchDir,
  timeBinary: options.time,
  scratchDir,
});
const adapters = options.frameworks.map((name) => {
  const make = registry.single.get(name);
  if (make === undefined) throw new Error(`unknown framework ${name}; known: ${[...registry.single.keys()].join(", ")}`);
  return make();
});
const batchAdapters = options.batch.map((name) => {
  const make = registry.batch.get(name);
  if (make === undefined) throw new Error(`unknown batch lane ${name}; known: ${[...registry.batch.keys()].join(", ")}`);
  return make();
});

const truthCache = new Map<string, string>();
const results: TaskResult[] = [];
const coldStartMs: Record<string, number> = {};

// Spawn to READY of the warm lanes' long-lived processes (JVM + Tika init, Node + module load).
const warmProcessStartupMs: Record<string, number> = {};
for (const adapter of adapters) {
  const start = performance.now();
  await adapter.setup(timeoutFor(adapter));
  if (adapter.regime === "warm_in_process") warmProcessStartupMs[adapter.name] = performance.now() - start;
}
await measureColdStarts();
await runQueue();
const warmProcessPeakRssBytes: Record<string, number | null> = {};
for (const adapter of adapters) {
  const peak = await adapter.teardown();
  if (adapter.regime === "warm_in_process") warmProcessPeakRssBytes[adapter.name] = peak;
}
const batchResults = await runBatches();

const meta: RunMeta = {
  startedAt,
  finishedAt: new Date().toISOString(),
  label: options.label,
  options: { ...options, corpus: options.corpus },
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    memoryBytes: totalmem(),
    versions: readVersions(),
  },
  coldStartMs,
  warmProcessStartupMs,
  warmProcessPeakRssBytes,
};
const selectedIds = selected.map((fixture) => fixture.id);
writeFileSync(
  join(options.out, "results.json"),
  `${JSON.stringify({ meta, cohorts, selected: selectedIds, skipped, results, batches: batchResults }, null, 2)}\n`,
);
writeReport(join(options.out, "summary.md"), { meta, selected: selectedIds, skipped, results, batches: batchResults });
log(`wrote ${join(options.out, "results.json")} and summary.md`);

async function measureColdStarts(): Promise<void> {
  // The harness's per-framework warmup on the first supported fixture, reported as cold start.
  const first = selected[0];
  if (first?.documentPath == null) return;
  for (const adapter of adapters) {
    const extraction = await adapter.extract(first.documentPath, timeoutFor(adapter));
    coldStartMs[adapter.name] = extraction.wallMs;
    log(`cold start ${adapter.name}: ${extraction.wallMs.toFixed(1)} ms (${extraction.errorKind})`);
  }
}

async function runQueue(): Promise<void> {
  const total = selected.length * adapters.length;
  let done = 0;
  const started = Date.now();
  for (const fixture of selected) {
    for (const adapter of adapters) {
      const result = await runTask(adapter, fixture);
      results.push(result);
      appendFileSync(partialFile, `${JSON.stringify(result)}\n`);
      done++;
      const eta = ((Date.now() - started) / done) * (total - done);
      log(
        `[${done}/${total}] ${adapter.name} ${fixture.id}: ${result.success ? "ok" : result.errorKind} ` +
          `${meanMs(result.iterations).toFixed(1)} ms` +
          (result.quality === null ? "" : ` TF1 ${result.quality.quality.toFixed(3)}`) +
          ` (eta ${Math.round(eta / 1000)} s)`,
      );
    }
  }
}

/** One fixture on one tool: warmups, then measured iterations (runner/execution.rs). */
async function runTask(adapter: Adapter, fixture: Fixture): Promise<TaskResult> {
  const path = fixture.documentPath ?? "";
  const timeoutMs = timeoutFor(adapter);
  let warmupTimedOut = false;
  for (let index = 0; index < options.warmup; index++) {
    const warm = await adapter.extract(path, timeoutMs);
    if (warm.errorKind === "timeout") {
      warmupTimedOut = true;
      break;
    }
  }
  // A warmup that timed out leaves one measured iteration, as the harness does.
  const iterations = warmupTimedOut ? 1 : options.iterations;
  const runs: Extraction[] = [];
  for (let index = 0; index < iterations; index++) {
    const run = await adapter.extract(path, timeoutMs);
    runs.push(run);
    if (run.errorKind === "timeout") break;
  }
  const failed = runs.find((run) => !run.success);
  const firstSuccess = runs.find((run) => run.success);
  let quality: QualityMetrics | null = null;
  let errorKind: ErrorKind = failed?.errorKind ?? "none";
  let error = failed?.error;
  if (firstSuccess !== undefined && fixture.groundTruthPath !== null) {
    const truth = groundTruth(fixture.groundTruthPath);
    quality = computeQuality(firstSuccess.content, truth);
    // ZeroOverlap: content that shares no token with non-empty ground truth is a failure (run.rs).
    if (failed === undefined && truth.trim() !== "" && quality.f1Text === 0) {
      errorKind = "zero_overlap";
      error = "no token in common with the ground truth";
    }
  }
  const result: TaskResult = {
    framework: adapter.name,
    regime: adapter.regime,
    fixture: fixture.id,
    fileType: fixture.fileType,
    group: fixture.group,
    fileSize: fixture.fileSize,
    success: errorKind === "none",
    errorKind,
    ...(error === undefined ? {} : { error }),
    iterations: runs.map((run) => ({
      wallMs: run.wallMs,
      rssBytes: run.rssBytes,
      ...(run.reportedMs === undefined ? {} : { reportedMs: run.reportedMs }),
    })),
    quality,
  };
  return result;
}

async function runBatches(): Promise<BatchResult[]> {
  if (batchAdapters.length === 0) return [];
  const batches = planBatches();
  const out: BatchResult[] = [];
  for (const batch of batches) {
    const paths = batch.fixtures.map((fixture) => fixture.documentPath ?? "");
    const totalBytes = batch.fixtures.reduce((sum, fixture) => sum + fixture.fileSize, 0);
    for (const adapter of batchAdapters) {
      out.push(await runBatch(adapter, batch.name, batch.fixtures, paths, totalBytes));
    }
  }
  return out;
}

async function runBatch(
  adapter: BatchAdapter,
  name: string,
  fixtures: readonly Fixture[],
  paths: readonly string[],
  totalBytes: number,
): Promise<BatchResult> {
  // Cold end-to-end batch: no warmup (BatchTimingScope::ColdEndToEndSubprocess).
  const timeoutMs = options.timeoutSeconds * 1000;
  const iterations: BatchResult["iterations"][number][] = [];
  for (let index = 0; index < options.iterations; index++) {
    const run = await adapter.run(paths, timeoutMs);
    const succeeded = run.items.filter((item) => item.success).length;
    iterations.push({ wallMs: run.wallMs, rssBytes: run.rssBytes, succeeded, ...(run.error === undefined ? {} : { error: run.error }) });
    log(`batch ${adapter.name} ${name} (${paths.length} files): ${run.wallMs.toFixed(1)} ms, ${succeeded} ok${run.error ? `, ${run.error}` : ""}`);
    if (run.timedOut) break;
  }
  return { framework: adapter.name, batch: name, fixtures: fixtures.map((fixture) => fixture.id), totalBytes, iterations };
}

/** Cohort batches in cohort order; otherwise selected fixtures chunked per file type. */
function planBatches(): { name: string; fixtures: Fixture[] }[] {
  const byId = new Map(selected.map((fixture) => [fixture.id, fixture]));
  const plans: { name: string; fixtures: Fixture[] }[] = [];
  const chunk = (name: string, list: Fixture[], size: number): void => {
    for (let start = 0; start < list.length; start += size) {
      plans.push({ name: `${name}#${start / size + 1}`, fixtures: list.slice(start, start + size) });
    }
  };
  if (cohorts.length > 0) {
    for (const cohort of cohorts) {
      const list = cohort.fixtures.flatMap((id) => byId.get(id) ?? []);
      chunk(cohort.name, list, cohort.batchSize);
    }
    return plans;
  }
  const byType = new Map<string, Fixture[]>();
  for (const fixture of selected) byType.set(fixture.fileType, [...(byType.get(fixture.fileType) ?? []), fixture]);
  for (const [type, list] of byType) chunk(type, list, options.batchSize);
  return plans;
}

function selectFixtures(fixtures: readonly Fixture[]): { selected: Fixture[]; skipped: Skipped[]; cohorts: Cohort[] } {
  const cohorts = options.cohorts.map(loadCohort);
  const wanted = cohorts.length === 0 ? null : new Set(cohorts.flatMap((cohort) => cohort.fixtures));
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const skipped: Skipped[] = [];
  if (wanted !== null) {
    for (const id of wanted) if (!byId.has(id)) skipped.push({ id, fileType: "?", reason: "cohort names a fixture that is not in the fixtures directory" });
  }
  const selected: Fixture[] = [];
  const perType = new Map<string, number>();
  for (const fixture of fixtures) {
    if (wanted !== null && !wanted.has(fixture.id)) continue;
    if (options.types !== null && !options.types.has(fixture.fileType)) continue;
    const reason = exclusionReason(fixture);
    if (reason !== null) {
      skipped.push({ id: fixture.id, fileType: fixture.fileType, reason });
      continue;
    }
    const count = perType.get(fixture.fileType) ?? 0;
    if (options.limitPerType > 0 && count >= options.limitPerType) continue;
    perType.set(fixture.fileType, count + 1);
    selected.push(fixture);
  }
  return { selected, skipped, cohorts };
}

function groundTruth(path: string): string {
  let text = truthCache.get(path);
  if (text === undefined) {
    text = readFileSync(path, "utf8");
    truthCache.set(path, text);
  }
  return text;
}

function timeoutFor(adapter: Adapter): number {
  const requested = options.timeoutSeconds * 1000;
  return adapter.maxTimeoutMs === undefined ? requested : Math.min(requested, adapter.maxTimeoutMs);
}

function meanMs(iterations: readonly Iteration[]): number {
  return iterations.length === 0 ? 0 : iterations.reduce((sum, run) => sum + run.wallMs, 0) / iterations.length;
}

function readVersions(): Record<string, string> {
  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return "unknown";
    }
  };
  return {
    ripstream: read(join(options.ripstreamRoot, "COMMIT")),
    // `xberg --version` prints "xberg 1.4.0".
    xberg: read(join(dirname(options.xberg), "VERSION")).replace(/^xberg /, ""),
    tika: read("/opt/bench/TIKA_VERSION"),
    java: read("/opt/bench/JAVA_VERSION"),
  };
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

interface Options {
  readonly fixtures: string;
  readonly corpus: string[];
  readonly cohorts: string[];
  readonly types: Set<string> | null;
  readonly limitPerType: number;
  readonly iterations: number;
  readonly warmup: number;
  readonly timeoutSeconds: number;
  readonly frameworks: string[];
  readonly batch: string[];
  readonly batchSize: number;
  readonly ripstreamRoot: string;
  readonly ripstreamConfig: string | null;
  readonly ripstreamEmailHeaders: boolean;
  readonly tikaClasspath: string;
  readonly xberg: string;
  readonly java: string;
  readonly time: string | null;
  readonly out: string;
  readonly label: string;
}

function parseArgs(argv: readonly string[]): Options {
  let fixtures = "";
  const corpus: string[] = [];
  const cohortFiles: string[] = [];
  let types: Set<string> | null = null;
  let limitPerType = 0;
  let iterations = 3;
  let warmup = 1;
  let timeoutSeconds = 1800;
  let frameworks = ["ripstream-cli", "ripstream-inproc", "tika", "tika-warm", "xberg"];
  let batch = ["xberg-batch", "ripstream-batch", "tika-batch"];
  let batchSize = 8;
  let ripstreamRoot = "/opt/ripstream";
  // Unlimited output, as TikaExtract's BodyContentHandler(-1) and xberg; ripstream's own default stops at 100,000 chars.
  let ripstreamEmailHeaders = false;
  let ripstreamConfig: string | null = join(dirname(fileURLToPath(import.meta.url)), "ripstream-config.json");
  let tikaClasspath = "/opt/bench/tika-classes:/opt/tika-server/lib/*";
  let xberg = "/opt/xberg/xberg";
  let java = "java";
  let time: string | null = "/usr/bin/time";
  let out = resolve("artifacts/bench-xberg");
  let label = "";
  const list = (value: string): string[] => value.split(",").map((item) => item.trim()).filter((item) => item !== "");
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[++index];
      if (next === undefined) usage(`${flag} expects a value`);
      return next;
    };
    const integer = (): number => {
      const raw = value();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) usage(`${flag} expects a non-negative integer, got ${raw}`);
      return parsed;
    };
    switch (flag) {
      case "--fixtures":
        fixtures = resolve(value());
        break;
      case "--corpus":
        corpus.push(resolve(value()));
        break;
      case "--cohort":
        cohortFiles.push(resolve(value()));
        break;
      case "--types":
        types = new Set(list(value().toLowerCase()));
        break;
      case "--limit-per-type":
        limitPerType = integer();
        break;
      case "-i":
      case "--iterations":
        iterations = integer();
        break;
      case "-w":
      case "--warmup":
        warmup = integer();
        break;
      case "-t":
      case "--timeout":
        timeoutSeconds = integer();
        break;
      case "--frameworks":
        frameworks = list(value());
        break;
      case "--batch":
        batch = list(value());
        break;
      case "--batch-size":
        batchSize = integer();
        break;
      case "--ripstream-root":
        ripstreamRoot = resolve(value());
        break;
      case "--ripstream-config": {
        const raw = value();
        ripstreamConfig = raw === "" ? null : resolve(raw);
        break;
      }
      case "--ripstream-email-headers":
        ripstreamEmailHeaders = true;
        break;
      case "--tika-classpath":
        tikaClasspath = value();
        break;
      case "--xberg":
        xberg = resolve(value());
        break;
      case "--java":
        java = value();
        break;
      case "--time": {
        const raw = value();
        time = raw === "" ? null : raw;
        break;
      }
      case "--out":
        out = resolve(value());
        break;
      case "--label":
        label = value();
        break;
      case "-h":
      case "--help":
        usage(null);
        break;
      default:
        usage(`unknown option ${flag}`);
    }
  }
  if (fixtures === "" || corpus.length === 0) usage("--fixtures and at least one --corpus are required");
  if (iterations < 1) usage("--iterations must be at least 1");
  // Warm lanes need a warmup so the first measured call is not the cold one (helpers.rs).
  if (warmup < 1 && frameworks.some((name) => name.endsWith("-inproc") || name.endsWith("-warm"))) {
    usage("warm lanes need --warmup >= 1");
  }
  if (batchSize < 1) usage("--batch-size must be at least 1");
  return {
    fixtures,
    corpus,
    cohorts: cohortFiles,
    types,
    limitPerType,
    iterations,
    warmup,
    timeoutSeconds,
    frameworks,
    batch,
    batchSize,
    ripstreamRoot,
    ripstreamConfig,
    ripstreamEmailHeaders,
    tikaClasspath,
    xberg,
    java,
    time,
    out,
    label,
  };
}

function usage(message: string | null): never {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const doc = /\/\*\*([\s\S]*?)\*\//.exec(text)?.[1]?.replace(/^ \* ?/gm, "") ?? "";
  if (message !== null) process.stderr.write(`${basename(fileURLToPath(import.meta.url))}: ${message}\n`);
  process.stderr.write(doc);
  process.exit(message === null ? 0 : 2);
}
