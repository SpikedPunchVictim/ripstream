#!/usr/bin/env node
/**
 * Fetches the binary documents the benchmark fixtures need from xberg's public corpus bucket
 * into a directory of their own. The git clone of xberg-io/test_documents holds the text
 * formats and the ground truth; office, PDF, ebook and other binaries are content-addressed
 * in https://storage.googleapis.com/xberg-test-documents/objects/<sha256> and listed in
 * its corpus.lock.json. Every object is checked against its sha256 before it is kept.
 *
 * Usage:
 *   node scripts/bench/fetch-corpus.ts --fixtures <harness fixtures dir> --corpus <test_documents clone> --out <new dir> [options]
 *
 * Options:
 *   --cohort <file.json>   only the documents of these harness cohorts (repeatable)
 *   --types <list>         only these file types, e.g. docx,xlsx,pdf
 *   --dry-run              list what would be fetched
 *
 * Pass the --out directory to run.ts as a second --corpus (XBERG_CORPUS_BIN for docker/run.sh).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { exclusionReason, loadCohort, loadFixtures } from "./fixtures.ts";

const BUCKET = "https://storage.googleapis.com/xberg-test-documents/objects/";

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const all = (flag: string): string[] => args.flatMap((arg, index) => (arg === flag && args[index + 1] !== undefined ? [args[index + 1] ?? ""] : []));
const fixturesDir = value("--fixtures");
const corpus = value("--corpus");
const out = value("--out");
if (fixturesDir === undefined || corpus === undefined || out === undefined) {
  process.stderr.write("usage: fetch-corpus.ts --fixtures <dir> --corpus <test_documents> --out <dir> [--cohort f.json]... [--types a,b] [--dry-run]\n");
  process.exit(2);
}
const outDir = resolve(out);
const types = value("--types")?.toLowerCase().split(",");
const cohortIds = new Set(all("--cohort").flatMap((file) => loadCohort(resolve(file)).fixtures));
const lock = (JSON.parse(readFileSync(join(corpus, "corpus.lock.json"), "utf8")) as { objects: Record<string, { sha256: string; size: number }> }).objects;

const { fixtures } = loadFixtures(resolve(fixturesDir), [resolve(corpus), outDir]);
const wanted = new Map<string, { sha256: string; size: number }>();
for (const fixture of fixtures) {
  if (cohortIds.size > 0 && !cohortIds.has(fixture.id)) continue;
  if (types !== undefined && !types.includes(fixture.fileType)) continue;
  if (fixture.documentPath !== null) continue;
  // Only documents that would be in the common cohort once present.
  const reason = exclusionReason({ ...fixture, documentPath: "pending" });
  if (reason !== null) continue;
  const entry = lock[fixture.documentRel];
  if (entry === undefined) {
    process.stderr.write(`not in corpus.lock.json: ${fixture.documentRel} (${fixture.id})\n`);
    continue;
  }
  wanted.set(fixture.documentRel, entry);
}

let bytes = 0;
for (const entry of wanted.values()) bytes += entry.size;
process.stderr.write(`${wanted.size} documents, ${(bytes / 1e6).toFixed(1)} MB\n`);
if (args.includes("--dry-run")) {
  for (const path of wanted.keys()) process.stdout.write(`${path}\n`);
  process.exit(0);
}

let failed = 0;
for (const [path, entry] of wanted) {
  const target = resolve(outDir, path);
  if (!target.startsWith(outDir + sep)) throw new Error(`refusing a path outside the output directory: ${path}`);
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`bad sha256 for ${path}`);
  if (existsSync(target)) continue;
  const response = await fetch(BUCKET + entry.sha256);
  if (!response.ok) {
    process.stderr.write(`HTTP ${response.status} for ${path}\n`);
    failed++;
    continue;
  }
  const body = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== entry.sha256) {
    process.stderr.write(`sha256 mismatch for ${path}: got ${digest}\n`);
    failed++;
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  process.stderr.write(`fetched ${path}\n`);
}
process.exit(failed === 0 ? 0 : 1);
