/**
 * Turns a run into summary.md: tables by format group, batch throughput, failures and the
 * skipped fixtures. Aggregation follows xberg's harness: latency percentiles over every
 * measured iteration of successful results (R-7, p95 only from 20 samples), throughput in
 * MB/s and memory in MB (decimal), quality over successful results.
 */
import { writeFileSync } from "node:fs";
import type { Skipped } from "./fixtures.ts";
import type { BatchResult, RunMeta, TaskResult } from "./run.ts";
import { max, mean, MIN_SAMPLES_FOR_P95, percentileR7, tailPercentile } from "./stats.ts";

export interface Report {
  readonly meta: RunMeta;
  /** Ids of the selected fixtures. */
  readonly selected: readonly string[];
  readonly skipped: readonly Skipped[];
  readonly results: readonly TaskResult[];
  readonly batches: readonly BatchResult[];
}

export interface Aggregate {
  readonly files: number;
  readonly succeeded: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly throughputMBps: number | null;
  readonly rssP50MB: number | null;
  readonly rssMaxMB: number | null;
  readonly tf1Mean: number | null;
  readonly tf1Correct: number;
}

const GROUP_ORDER = ["text", "markup", "data", "email", "office", "ebook", "pdf", "archive", "other"];

export function aggregate(results: readonly TaskResult[]): Aggregate {
  const ok = results.filter((result) => result.success);
  const latencies = ok.flatMap((result) => result.iterations.map((run) => run.wallMs));
  const throughput = ok.flatMap((result) => result.iterations.map((run) => result.fileSize / 1e6 / (run.wallMs / 1000)));
  const rss = ok.flatMap((result) => result.iterations.flatMap((run) => (run.rssBytes === null ? [] : [run.rssBytes / 1e6])));
  const quality = ok.flatMap((result) => (result.quality === null ? [] : [result.quality.quality]));
  return {
    files: results.length,
    succeeded: ok.length,
    p50Ms: percentileR7(latencies, 0.5),
    p95Ms: tailPercentile(latencies, 0.95, MIN_SAMPLES_FOR_P95),
    throughputMBps: percentileR7(throughput, 0.5),
    rssP50MB: percentileR7(rss, 0.5),
    rssMaxMB: max(rss),
    tf1Mean: mean(quality),
    tf1Correct: quality.filter((score) => score >= 0.95).length,
  };
}

export function writeReport(path: string, report: Report): void {
  writeFileSync(path, renderReport(report));
}

export function renderReport(report: Report): string {
  const frameworks = [...new Set(report.results.map((result) => result.framework))];
  const groups = sortGroups([...new Set(report.results.map((result) => result.group))]);
  const lines: string[] = [];
  lines.push("# ripstream vs xberg vs Apache Tika (xberg harness methodology)", "");
  lines.push(...renderMeta(report));

  const common = commonFixtures(report.results, frameworks);
  lines.push(
    "## Common successes by format group",
    "",
    `Only fixtures every lane extracted successfully (${common.size} of ${report.selected.length}), so every row covers the same files.`,
    "",
  );
  lines.push(...aggregateTable(report.results.filter((result) => common.has(result.fixture)), groups, frameworks));

  lines.push("## All selected fixtures by format group", "", "Failures count against `ok`; timings and TF1 cover successes only.", "");
  lines.push(...aggregateTable(report.results, groups, frameworks));

  lines.push("## By file type", "");
  lines.push("| type | lane | ok | p50 ms | MB/s p50 | RSS p50 MB | TF1 |", "|---|---|---:|---:|---:|---:|---:|");
  const types = [...new Set(report.results.map((result) => result.fileType))].sort();
  for (const type of types) {
    for (const framework of frameworks) {
      const subset = report.results.filter((result) => result.fileType === type && result.framework === framework);
      if (subset.length === 0) continue;
      const stats = aggregate(subset);
      lines.push(
        `| ${type} | ${framework} | ${stats.succeeded}/${stats.files} | ${fmt(stats.p50Ms, 1)} | ${fmt(stats.throughputMBps, 3)} | ${fmt(stats.rssP50MB, 0)} | ${fmt(stats.tf1Mean, 3)} |`,
      );
    }
  }
  lines.push("");

  if (report.batches.length > 0) lines.push(...renderBatches(report.batches, report.results));
  lines.push(...renderParityGaps(report.results));
  lines.push(...renderFailures(report.results));
  lines.push(...renderSkipped(report.skipped));
  return `${lines.join("\n")}\n`;
}

function renderMeta(report: Report): string[] {
  const { meta } = report;
  const environment = meta.environment as { versions?: Record<string, string>; cpus?: number; cpuModel?: string; memoryBytes?: number; node?: string };
  const versions = environment.versions ?? {};
  const options = meta.options as { iterations?: number; warmup?: number; timeoutSeconds?: number };
  const lines = [
    `- Run: ${meta.startedAt} to ${meta.finishedAt}${meta.label === "" ? "" : ` (${meta.label})`}`,
    `- Versions: ripstream ${versions.ripstream ?? "?"}, xberg ${versions.xberg ?? "?"}, Tika ${versions.tika ?? "?"} on ${versions.java ?? "?"}, Node ${environment.node ?? "?"}`,
    `- Machine: ${environment.cpus ?? "?"} CPUs (${environment.cpuModel ?? "?"}), ${fmt((environment.memoryBytes ?? 0) / 1e9, 1)} GB`,
    `- Iterations ${options.iterations ?? "?"}, warmup ${options.warmup ?? "?"}, timeout ${options.timeoutSeconds ?? "?"} s (Tika capped at 180 s)`,
    `- Fixtures: ${report.selected.length} selected, ${report.skipped.length} skipped (reasons below)`,
    "- Lanes: `*-cli`, `tika`, `xberg` start a fresh process per file (cold_process). `ripstream-inproc` and `tika-warm` keep one process and are",
    "  warm_in_process: not comparable with the cold lanes, and their per-file RSS is not attributable (the harness zeroes it).",
    "- TF1 = 0.6 text F1 + 0.4 numeric F1 (text F1 alone when the ground truth has no numbers); plaintext output for every tool.",
    "",
    "Cold start is the first extraction of the first fixture (the harness's warmup); for warm lanes it follows process startup,",
    "which is listed separately (spawn to ready).",
    "",
    "| lane | cold start ms | warm process startup ms | warm process peak RSS MB |",
    "|---|---:|---:|---:|",
  ];
  for (const [name, ms] of Object.entries(meta.coldStartMs)) {
    const peak = meta.warmProcessPeakRssBytes[name];
    const startup = meta.warmProcessStartupMs?.[name];
    lines.push(
      `| ${name} | ${fmt(ms, 1)} | ${startup === undefined ? "" : fmt(startup, 0)} | ${peak === undefined || peak === null ? "" : fmt(peak / 1e6, 0)} |`,
    );
  }
  lines.push("");
  return lines;
}

function aggregateTable(results: readonly TaskResult[], groups: readonly string[], frameworks: readonly string[]): string[] {
  const lines = [
    "| group | lane | ok | p50 ms | p95 ms | MB/s p50 | RSS p50 MB | RSS max MB | TF1 mean | TF1 >= 0.95 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const group of [...groups, "all"]) {
    for (const framework of frameworks) {
      const subset = results.filter((result) => result.framework === framework && (group === "all" || result.group === group));
      if (subset.length === 0) continue;
      const stats = aggregate(subset);
      lines.push(
        `| ${group} | ${framework} | ${stats.succeeded}/${stats.files} | ${fmt(stats.p50Ms, 1)} | ${fmt(stats.p95Ms, 1)} | ` +
          `${fmt(stats.throughputMBps, 3)} | ${fmt(stats.rssP50MB, 0)} | ${fmt(stats.rssMaxMB, 0)} | ${fmt(stats.tf1Mean, 3)} | ${stats.tf1Correct} |`,
      );
    }
  }
  lines.push("");
  return lines;
}

function renderBatches(batches: readonly BatchResult[], results: readonly TaskResult[]): string[] {
  const lines = [
    "## Batch throughput (one fresh process per batch, no warmup)",
    "",
    "Per batch the median of the iterations; totals are sums of those medians. A batch is grouped by its first file.",
    "",
    "| group | lane | batches | files | MB | wall ms | files/s | MB/s | RSS max MB | files ok |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const groupOfFixture = new Map(results.map((result) => [result.fixture, result.group]));
  const groupOfBatch = (batch: BatchResult): string => groupOfFixture.get(batch.fixtures[0] ?? "") ?? "other";
  const groups = sortGroups([...new Set(batches.map(groupOfBatch))]);
  const frameworks = [...new Set(batches.map((batch) => batch.framework))];
  for (const group of [...groups, "all"]) {
    for (const framework of frameworks) {
      const own = batches.filter((batch) => batch.framework === framework && (group === "all" || groupOfBatch(batch) === group));
      if (own.length > 0) lines.push(batchRow(group, framework, own));
    }
  }
  lines.push("");
  return lines;
}

function batchRow(group: string, framework: string, own: readonly BatchResult[]): string {
  let files = 0;
  let bytes = 0;
  let wall = 0;
  let ok = 0;
  const rss: number[] = [];
  for (const batch of own) {
    const walls = batch.iterations.map((run) => run.wallMs);
    files += batch.fixtures.length;
    bytes += batch.totalBytes;
    wall += percentileR7(walls, 0.5) ?? 0;
    ok += Math.min(...batch.iterations.map((run) => run.succeeded));
    for (const run of batch.iterations) if (run.rssBytes !== null) rss.push(run.rssBytes / 1e6);
  }
  return (
    `| ${group} | ${framework} | ${own.length} | ${files} | ${fmt(bytes / 1e6, 2)} | ${fmt(wall, 0)} | ${fmt(files / (wall / 1000), 1)} | ` +
    `${fmt(bytes / 1e6 / (wall / 1000), 3)} | ${fmt(max(rss), 0)} | ${ok}/${files} |`
  );
}

const PARITY_GAP = 0.05;

/**
 * ripstream is a Tika port, so a TF1 gap between the two on the same file points at output
 * that differs from Tika's. Uses the first ripstream and Tika lanes present.
 */
function renderParityGaps(results: readonly TaskResult[]): string[] {
  const frameworks = new Set(results.map((result) => result.framework));
  const ours = ["ripstream-inproc", "ripstream-cli"].find((name) => frameworks.has(name));
  const theirs = ["tika-warm", "tika"].find((name) => frameworks.has(name));
  if (ours === undefined || theirs === undefined) return [];
  const score = (framework: string): Map<string, TaskResult> =>
    new Map(results.filter((result) => result.framework === framework).map((result) => [result.fixture, result]));
  const ourResults = score(ours);
  const theirResults = score(theirs);
  const rows: { fixture: string; fileType: string; ours: number | null; theirs: number | null }[] = [];
  for (const [fixture, own] of ourResults) {
    const other = theirResults.get(fixture);
    if (other === undefined) continue;
    const left = own.success ? (own.quality?.quality ?? null) : null;
    const right = other.success ? (other.quality?.quality ?? null) : null;
    if (left === null && right === null) continue;
    if (left !== null && right !== null && Math.abs(left - right) < PARITY_GAP) continue;
    rows.push({ fixture, fileType: own.fileType, ours: left, theirs: right });
  }
  const lines = [
    `## ripstream vs Tika output gaps (${ours} vs ${theirs})`,
    "",
    `Fixtures where TF1 differs by ${PARITY_GAP} or more, or only one of the two succeeded (${rows.length}).`,
    "",
  ];
  if (rows.length === 0) return [...lines, "None.", ""];
  lines.push(`| fixture | type | ${ours} TF1 | ${theirs} TF1 | delta |`, "|---|---|---:|---:|---:|");
  const delta = (row: (typeof rows)[number]): number => (row.ours ?? 0) - (row.theirs ?? 0);
  for (const row of rows.sort((left, right) => delta(left) - delta(right))) {
    lines.push(`| ${row.fixture} | ${row.fileType} | ${row.ours === null ? "failed" : fmt(row.ours, 3)} | ${row.theirs === null ? "failed" : fmt(row.theirs, 3)} | ${fmt(delta(row), 3)} |`);
  }
  lines.push("");
  return lines;
}

function renderFailures(results: readonly TaskResult[]): string[] {
  const failures = results.filter((result) => !result.success);
  if (failures.length === 0) return ["## Failures", "", "None.", ""];
  const lines = ["## Failures", "", "| lane | fixture | kind | detail |", "|---|---|---|---|"];
  for (const failure of failures) {
    const detail = (failure.error ?? "").replace(/\s+/g, " ").replaceAll("|", "\\|").slice(0, 160);
    lines.push(`| ${failure.framework} | ${failure.fixture} | ${failure.errorKind} | ${detail} |`);
  }
  lines.push("");
  return lines;
}

function renderSkipped(skipped: readonly Skipped[]): string[] {
  const lines = ["## Skipped fixtures", ""];
  if (skipped.length === 0) return [...lines, "None.", ""];
  const byReason = new Map<string, Skipped[]>();
  for (const item of skipped) {
    const key = item.reason.replace(/ \(.*\)$/, "");
    byReason.set(key, [...(byReason.get(key) ?? []), item]);
  }
  lines.push("| reason | fixtures | file types |", "|---|---:|---|");
  for (const [reason, items] of [...byReason].sort((left, right) => right[1].length - left[1].length)) {
    const types = new Map<string, number>();
    for (const item of items) types.set(item.fileType, (types.get(item.fileType) ?? 0) + 1);
    const typeList = [...types].sort((left, right) => right[1] - left[1]).map(([type, count]) => `${type} ${count}`).join(", ");
    lines.push(`| ${reason} | ${items.length} | ${typeList} |`);
  }
  lines.push("", "Every skipped fixture and its reason is listed in results.json (`skipped`).", "");
  return lines;
}

function commonFixtures(results: readonly TaskResult[], frameworks: readonly string[]): Set<string> {
  const okBy = new Map<string, Set<string>>();
  for (const result of results) {
    if (!result.success) continue;
    const set = okBy.get(result.fixture) ?? new Set<string>();
    set.add(result.framework);
    okBy.set(result.fixture, set);
  }
  return new Set([...okBy].filter(([, set]) => frameworks.every((framework) => set.has(framework))).map(([fixture]) => fixture));
}

function sortGroups(groups: string[]): string[] {
  return groups.sort((left, right) => GROUP_ORDER.indexOf(left) - GROUP_ORDER.indexOf(right));
}

function fmt(value: number | null, digits: number): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}
