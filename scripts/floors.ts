// Per-cohort quality floors (tikajs-3qub): the benchmark writes artifacts/benchmark.json, this compares each cohort with
// benchmarks/floors.json. A parse-quality score, a throughput, a latency or a peak RSS below/above its floor fails CI.
//
//   pnpm bench && node scripts/floors.ts --check
//   node scripts/floors.ts --check --results other.json
//
// Re-baseline on purpose on a quiet machine: run `pnpm bench`, review its output, and raise the floor in the same commit
// as the change that earns it. Lowering a floor to turn a red run green hides the regression it was meant to catch.
import { readFileSync } from "node:fs";

interface Measurement {
  readonly score: number;
  readonly opsPerSecond: number;
  readonly medianMs: number;
  readonly peakRssMb: number;
}
interface Floor {
  readonly minScore?: number;
  readonly minOpsPerSecond?: number;
  readonly maxMedianMs?: number;
  readonly maxPeakRssMb?: number;
}
interface FloorsFile {
  readonly version: 1;
  readonly cohorts: Readonly<Record<string, Floor>>;
}

const args = process.argv.slice(2);
if (!args.includes("--check")) {
  console.error("usage: node scripts/floors.ts --check [--results FILE]");
  process.exit(2);
}
const resultsAt = args.indexOf("--results");
const resultsPath = resultsAt === -1 ? "artifacts/benchmark.json" : args[resultsAt + 1];
if (resultsPath === undefined) {
  console.error("--results needs a file");
  process.exit(2);
}
const results = JSON.parse(readFileSync(resultsPath, "utf8")) as Record<string, Measurement>;
const floors = JSON.parse(readFileSync("benchmarks/floors.json", "utf8")) as FloorsFile;
const problems: string[] = [];
for (const [cohort, floor] of Object.entries(floors.cohorts)) {
  const measured = results[cohort];
  if (measured === undefined) {
    problems.push(`${cohort}: the benchmark has no such cohort`);
    continue;
  }
  if (floor.minScore !== undefined && measured.score < floor.minScore) {
    problems.push(`${cohort}: score ${measured.score} < ${floor.minScore}`);
  }
  if (floor.minOpsPerSecond !== undefined && measured.opsPerSecond < floor.minOpsPerSecond) {
    problems.push(`${cohort}: ${measured.opsPerSecond} ops/s < ${floor.minOpsPerSecond}`);
  }
  if (floor.maxMedianMs !== undefined && measured.medianMs > floor.maxMedianMs) {
    problems.push(`${cohort}: median ${measured.medianMs} ms > ${floor.maxMedianMs}`);
  }
  if (floor.maxPeakRssMb !== undefined && measured.peakRssMb > floor.maxPeakRssMb) {
    problems.push(`${cohort}: peak RSS ${measured.peakRssMb} MiB > ${floor.maxPeakRssMb}`);
  }
}
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  console.log(`quality floors passed: ${Object.keys(floors.cohorts).join(", ")}`);
}
