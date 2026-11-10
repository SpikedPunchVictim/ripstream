import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ParityFixture {
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface OracleSnapshot {
  readonly mediaType: string;
  readonly text: string;
  readonly metadata: Readonly<Record<string, readonly string[]>>;
}

export interface Golden {
  readonly formatVersion: 1;
  readonly oracle: { readonly version: string; readonly configHash: string };
  readonly fixture: { readonly id: string; readonly sha256: string };
  readonly snapshot: OracleSnapshot;
}

export interface Oracle {
  readonly version: string;
  readonly configHash: string;
  analyze(fixture: ParityFixture): Promise<OracleSnapshot>;
}

export interface CompareOptions {
  readonly ignoreMetadataKeys?: readonly string[];
  readonly textThreshold?: number;
}

export interface ParityDiff {
  readonly fixtureId: string;
  readonly kind: "mediaType" | "text" | "metadata";
  readonly detail: string;
}

const DEFAULT_IGNORED = ["tk:parse-time-millis", "tk:digest", "tk:exception:embedded-parser"];

export function fixtureSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function goldenPath(root: string, fixtureId: string): string {
  return join(root, `${fixtureId.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
}

export function writeGolden(root: string, golden: Golden): string {
  mkdirSync(root, { recursive: true });
  const path = goldenPath(root, golden.fixture.id);
  writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`);
  return path;
}

export function readGolden(path: string): Golden {
  const value = JSON.parse(readFileSync(path, "utf8")) as Golden;
  if (value.formatVersion !== 1) {
    throw new Error(`Unsupported golden format in ${path}`);
  }
  return value;
}

export async function captureGolden(
  oracle: Oracle,
  fixture: ParityFixture,
): Promise<Golden> {
  return {
    formatVersion: 1,
    oracle: { version: oracle.version, configHash: oracle.configHash },
    fixture: { id: fixture.id, sha256: fixtureSha256(fixture.bytes) },
    snapshot: await oracle.analyze(fixture),
  };
}

export function needsRegeneration(golden: Golden, oracle: Oracle): boolean {
  return (
    golden.oracle.version !== oracle.version ||
    golden.oracle.configHash !== oracle.configHash ||
    golden.formatVersion !== 1
  );
}

/** Recaptures and overwrites a golden; call only from a reviewed regeneration run. */
export async function regenerateGolden(
  root: string,
  oracle: Oracle,
  fixture: ParityFixture,
): Promise<Golden> {
  const golden = await captureGolden(oracle, fixture);
  writeGolden(root, golden);
  return golden;
}

export function compareSnapshot(
  fixtureId: string,
  actual: OracleSnapshot,
  golden: Golden,
  options: CompareOptions = {},
): ParityDiff[] {
  const diffs: ParityDiff[] = [];
  const expected = golden.snapshot;

  if (actual.mediaType !== expected.mediaType) {
    diffs.push({
      fixtureId,
      kind: "mediaType",
      detail: `expected ${expected.mediaType}, got ${actual.mediaType}`,
    });
  }

  const threshold = options.textThreshold ?? 1;
  const similarity = textSimilarity(actual.text, expected.text);
  if (similarity < threshold) {
    diffs.push({
      fixtureId,
      kind: "text",
      detail: `similarity ${similarity.toFixed(4)} below ${threshold}`,
    });
  }

  const ignored = new Set([
    ...DEFAULT_IGNORED,
    ...(options.ignoreMetadataKeys ?? []),
  ]);
  const expectedMetadata = filterMetadata(expected.metadata, ignored);
  const actualMetadata = filterMetadata(actual.metadata, ignored);
  for (const key of new Set([
    ...Object.keys(expectedMetadata),
    ...Object.keys(actualMetadata),
  ])) {
    const want = [...(expectedMetadata[key] ?? [])].sort();
    const got = [...(actualMetadata[key] ?? [])].sort();
    if (want.join("\u0000") !== got.join("\u0000")) {
      diffs.push({
        fixtureId,
        kind: "metadata",
        detail: `${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      });
    }
  }
  return diffs;
}

function filterMetadata(
  metadata: Readonly<Record<string, readonly string[]>>,
  ignored: ReadonlySet<string>,
): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = {};
  for (const [key, values] of Object.entries(metadata)) {
    if (ignored.has(key)) continue;
    result[key] = values;
  }
  return result;
}

export function textSimilarity(actual: string, expected: string): number {
  const left = normalizeText(actual);
  const right = normalizeText(expected);
  if (left === right) return 1;
  if (left.length === 0 && right.length === 0) return 1;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function levenshtein(left: string, right: string): number {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) +
          (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? left.length;
}

export interface ParityReport {
  readonly fixtures: number;
  readonly passed: number;
  readonly failed: readonly ParityDiff[];
  readonly missingGoldens: readonly string[];
}

/** Compares an oracle against checked-in goldens; no Docker needed in CI. */
export async function runParity(
  fixtures: readonly ParityFixture[],
  oracle: Oracle,
  goldenRoot: string,
  options: CompareOptions = {},
): Promise<ParityReport> {
  const failed: ParityDiff[] = [];
  const missing: string[] = [];
  let passed = 0;
  for (const fixture of fixtures) {
    let golden: Golden;
    try {
      golden = readGolden(goldenPath(goldenRoot, fixture.id));
    } catch {
      missing.push(fixture.id);
      continue;
    }
    const actual = await oracle.analyze(fixture);
    const diffs = compareSnapshot(fixture.id, actual, golden, options);
    if (diffs.length === 0) passed++;
    else failed.push(...diffs);
  }
  return {
    fixtures: fixtures.length,
    passed,
    failed,
    missingGoldens: missing,
  };
}

export function formatReport(report: ParityReport): string {
  const lines = [
    `fixtures: ${report.fixtures}, passed: ${report.passed}, failed: ${report.failed.length}, missing goldens: ${report.missingGoldens.length}`,
  ];
  for (const missed of report.missingGoldens) {
    lines.push(`missing golden: ${missed}`);
  }
  for (const diff of report.failed) {
    lines.push(`${diff.fixtureId} [${diff.kind}] ${diff.detail}`);
  }
  return lines.join("\n");
}

export interface RipstreamServerOracleOptions {
  readonly baseUrl: string;
  readonly version?: string;
  readonly configHash?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Oracle backed by a Tika server /rmeta/text endpoint (Docker or remote). */
export class RipstreamServerOracle implements Oracle {
  readonly version: string;
  readonly configHash: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: RipstreamServerOracleOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.version = options.version ?? "tika-server";
    this.configHash = options.configHash ?? "default";
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async analyze(fixture: ParityFixture): Promise<OracleSnapshot> {
    const response = await this.#fetch(`${this.#baseUrl}/rmeta/text`, {
      method: "PUT",
      headers: {
        "Content-Type": fixture.mediaType,
        Accept: "application/json",
      },
      body: fixture.bytes.slice().buffer,
    });
    if (!response.ok) {
      throw new Error(`Tika oracle failed: ${response.status}`);
    }
    const payload = (await response.json()) as Array<Record<string, unknown>>;
    const first = payload[0] ?? {};
    const metadata: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(first)) {
      if (key === "tk:content") continue;
      metadata[key] = Array.isArray(value) ? value.map(String) : [String(value)];
    }
    const content = typeof first["tk:content"] === "string" ? first["tk:content"] : "";
    return {
      mediaType: (metadata["Content-Type"] ?? [fixture.mediaType])[0] ?? fixture.mediaType,
      text: content,
      metadata,
    };
  }
}
