#!/usr/bin/env node
/**
 * Re-renders summary.md from a results.json written by run.ts, e.g. after the report format
 * changed or to merge runs.
 *
 * Usage:
 *   node scripts/bench/render.ts <results.json>... [--out <summary.md>]
 *
 * Several results files are merged: their results, batches and skipped lists are
 * concatenated and the first file's meta is kept.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeReport, type Report } from "./report.ts";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
const inputs = outIndex < 0 ? args : args.filter((_, index) => index !== outIndex && index !== outIndex + 1);
if (inputs.length === 0) {
  process.stderr.write("usage: render.ts <results.json>... [--out <summary.md>]\n");
  process.exit(2);
}
const reports = inputs.map((file) => JSON.parse(readFileSync(file, "utf8")) as Report);
const first = reports[0];
if (first === undefined) process.exit(2);
const merged: Report = {
  meta: first.meta,
  selected: [...new Set(reports.flatMap((report) => report.selected))],
  skipped: reports.flatMap((report) => report.skipped),
  results: reports.flatMap((report) => report.results),
  batches: reports.flatMap((report) => report.batches),
};
const target = out ?? join(dirname(inputs[0] ?? "."), "summary.md");
writeReport(target, merged);
process.stderr.write(`wrote ${target}\n`);
