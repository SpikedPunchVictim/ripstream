#!/usr/bin/env node
// Corpus profile of parse isolation (bead tikajs-zgg2.8, P6). Not a workspace package, not matched by `pnpm test`.
//
// Runs every file under --corpus through the REAL standard isolator (one child per file, sequentially so the RSS of a
// run is its own) and records: outcome, wall-clock time, peak child RSS, kill reason. The summary names the files
// that set each maximum, so the defaults in docs/isolation.md can be tied to a measured file.
//
// usage: node profile.mjs --corpus DIR [--corpus DIR ...] [--mode records|text] [--heap-mb N] [--per-child-mb N]
//          [--max-task-ms N] [--vmem-kb N] [--ext docx,xlsx] [--limit N] [--out FILE.jsonl] [--summary FILE.json]
//          [--check expected.json]
//   --check   compare the run with an expected file and exit 1 on a regression (see check() below)
//
// Needs `pnpm build` (the standard child and its parsers load from dist). Corpus files are untrusted input: they
// are only read, never executed or opened in a viewer.
import { createWriteStream, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { createStandardIsolation } from "../../../bundle-standard/src/isolation.ts";

function parseArgs(argv) {
  const options = { corpus: [], mode: "records", ext: null, limit: 0, out: null, summary: null, check: null, config: {}, runner: {} };
  const number = (name, value) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer, got ${value}`);
    return parsed;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    switch (flag) {
      case "--corpus": options.corpus.push(resolve(value())); break;
      case "--mode": options.mode = value(); break;
      case "--heap-mb": options.config.heapMb = number(flag, value()); break;
      case "--per-child-mb": options.config.perChildMb = number(flag, value()); break;
      case "--max-task-ms": options.config.maxTaskMillis = number(flag, value()); break;
      case "--vmem-kb": options.runner.vmemKb = number(flag, value()); break;
      case "--ext": options.ext = new Set(value().split(",").map((e) => `.${e.replace(/^\./, "").toLowerCase()}`)); break;
      case "--limit": options.limit = number(flag, value()); break;
      case "--out": options.out = resolve(value()); break;
      case "--summary": options.summary = resolve(value()); break;
      case "--check": options.check = resolve(value()); break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  if (options.corpus.length === 0) throw new Error("--corpus DIR is required");
  if (options.mode !== "records" && options.mode !== "text") throw new Error("--mode is records or text");
  return options;
}

function walk(root, ext) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile() && (ext === null || ext.has(extname(entry).toLowerCase()))) files.push(path);
    }
  };
  visit(root);
  return files;
}

const percentile = (sorted, p) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);

function summarize(results, options) {
  const outcomes = {};
  for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const ran = results.filter((r) => r.peakRssMb !== null);
  const rss = ran.map((r) => r.peakRssMb).sort((a, b) => a - b);
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const top = (key, n = 5) =>
    [...results].filter((r) => r[key] !== null).sort((a, b) => b[key] - a[key]).slice(0, n).map((r) => ({ file: r.file, [key]: r[key], outcome: r.outcome }));
  return {
    files: results.length,
    ranInChild: ran.length,
    mode: options.mode,
    config: options.config,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    outcomes,
    peakRssMb: { p50: percentile(rss, 50), p95: percentile(rss, 95), p99: percentile(rss, 99), max: rss.at(-1) ?? null },
    ms: { p50: percentile(ms, 50), p95: percentile(ms, 95), p99: percentile(ms, 99), max: ms.at(-1) ?? null },
    topRss: top("peakRssMb"),
    topMs: top("ms"),
    notOk: results.filter((r) => r.outcome !== "ok").map((r) => ({ file: r.file, outcome: r.outcome, killReason: r.killReason, message: r.message })),
  };
}

/**
 * Regression check against an expected file:
 *   { "minFiles": N,              // the run must have covered at least this many files (a partial fetch fails)
 *     "maxPeakRssMb": N,          // no file may exceed this child RSS; the run must report RSS
 *     "maxMs": N,                  // no file may take longer
 *     "allowedNotOk": { "<file>": "<outcome>" }   // exactly these files may fail, with exactly this outcome
 *   }
 * A file failing that is not listed, a listed file that now succeeds or fails differently, and an exceeded bound all
 * count. Returns the list of problems.
 */
function check(summary, results, expected) {
  const problems = [];
  const allowed = expected.allowedNotOk ?? {};
  if (expected.minFiles !== undefined && results.length < expected.minFiles) {
    problems.push(`the run covered ${results.length} files, expected at least ${expected.minFiles} (partial corpus?)`);
  }
  for (const r of results) {
    const want = allowed[r.file];
    if (r.outcome === "ok" && want !== undefined) problems.push(`${r.file}: expected ${want}, got ok (update the expected file if the fix is deliberate)`);
    if (r.outcome !== "ok" && want === undefined) problems.push(`${r.file}: unexpected ${r.outcome}${r.killReason ? ` (kill ${r.killReason})` : ""}: ${r.message ?? ""}`);
    if (r.outcome !== "ok" && want !== undefined && want !== r.outcome) problems.push(`${r.file}: expected ${want}, got ${r.outcome}`);
  }
  for (const file of Object.keys(allowed)) if (!results.some((r) => r.file === file)) problems.push(`${file}: listed in allowedNotOk but not in the corpus run`);
  if (expected.maxPeakRssMb !== undefined) {
    if (summary.peakRssMb.max === null) problems.push("maxPeakRssMb is set but no run reported a child RSS");
    else if (summary.peakRssMb.max > expected.maxPeakRssMb) {
      problems.push(`peak child RSS ${summary.peakRssMb.max} MiB exceeds ${expected.maxPeakRssMb} MiB (${summary.topRss[0]?.file})`);
    }
  }
  if (expected.maxMs !== undefined && summary.ms.max !== null && summary.ms.max > expected.maxMs) {
    problems.push(`slowest file took ${summary.ms.max} ms, bound ${expected.maxMs} ms (${summary.topMs[0]?.file})`);
  }
  return problems;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = options.corpus.flatMap((root) => walk(root, options.ext).map((path) => ({ root, path })));
  const selected = options.limit > 0 ? files.slice(0, options.limit) : files;
  if (selected.length === 0) throw new Error("the corpus has no matching files");

  const settled = [];
  const standard = await createStandardIsolation({
    config: { mode: "strict", ...options.config },
    runner: { ...options.runner, onRunSettled: (diagnostics) => settled.push(diagnostics) },
  });
  const out = options.out === null ? null : createWriteStream(options.out);
  const results = [];
  try {
    for (const { root, path } of selected) {
      const name = relative(root, path);
      const label = options.corpus.length > 1 ? `${basename(root)}/${name}` : name;
      const bytes = readFileSync(path);
      const before = settled.length;
      const started = performance.now();
      let outcome = "ok";
      let message = null;
      try {
        if (options.mode === "records") await standard.ripstream.parseRecursive(bytes, { filename: basename(path) });
        else await standard.ripstream.parse(bytes, { filename: basename(path) });
      } catch (error) {
        outcome = error?.code ?? error?.constructor?.name ?? "Error";
        message = String(error?.message ?? error).slice(0, 200);
      }
      const ms = Math.round(performance.now() - started);
      const run = settled.length > before ? settled[settled.length - 1] : null;
      const result = {
        file: label,
        size: bytes.length,
        outcome,
        ms,
        peakRssMb: run?.rss?.peakMb ?? null,
        killReason: run?.killReason ?? null,
        signal: run?.signal ?? null,
        message,
      };
      results.push(result);
      out?.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    await standard.isolator.dispose();
    await new Promise((done) => (out ? out.end(done) : done()));
  }

  const summary = summarize(results, options);
  if (options.summary !== null) writeFileSync(options.summary, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));

  if (options.check !== null) {
    const problems = check(summary, results, JSON.parse(readFileSync(options.check, "utf8")));
    if (problems.length > 0) {
      console.error(`\nREGRESSION: ${problems.length} problem(s) against ${options.check}`);
      for (const problem of problems) console.error(`  ${problem}`);
      process.exitCode = 1;
    } else {
      console.error(`\nPASS against ${options.check}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 2;
});
