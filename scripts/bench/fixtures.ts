/**
 * Loads xberg benchmark-harness fixtures and cohorts and decides which ones every compared
 * tool can run. Documents and ground truth are found by stripping the fixture's
 * `(../)+test_documents/` prefix and looking under each corpus root in order, so the git
 * clone of xberg-io/test_documents and a separate directory of fetched binaries can be
 * layered without copying either.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface Fixture {
  /** Path of the fixture JSON relative to the harness fixtures directory. */
  readonly id: string;
  readonly fileType: string;
  readonly group: string;
  /** Document path relative to test_documents. */
  readonly documentRel: string;
  /** Absolute path under one of the corpus roots, or null when no root has it. */
  readonly documentPath: string | null;
  readonly fileSize: number;
  readonly groundTruthRel: string | null;
  readonly groundTruthPath: string | null;
  readonly requiresOcr: boolean;
  readonly expectedFrameworks: readonly string[];
}

export interface Skipped {
  readonly id: string;
  readonly fileType: string;
  readonly reason: string;
}

export interface Cohort {
  readonly name: string;
  readonly batchSize: number;
  readonly fixtures: readonly string[];
}

/** Formats xberg's harness runs through Tika (adapters/external.rs, get_supported_formats("tika")). */
export const TIKA_FORMATS: ReadonlySet<string> = new Set(
  (
    "pdf docx doc pptx ppt ppsx pptm xlsx xls xlsm xlsb odt ods rtf epub html htm xml svg md txt csv tsv " +
    "json yaml yml toml eml msg tex latex bib rst org ipynb png jpg jpeg gif bmp tiff tif webp jp2 zip tar gz 7z wpd wp"
  ).split(" "),
);

/** Image types the harness treats as OCR-only when the fixture does not say (fixture/mod.rs). */
const OCR_BY_DEFAULT = new Set("jpg jpeg png gif bmp tiff tif webp jp2 jpx jpm mj2".split(" "));

const GROUPS: Readonly<Record<string, string>> = {
  txt: "text",
  md: "text",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  rst: "markup",
  org: "markup",
  tex: "markup",
  latex: "markup",
  bib: "markup",
  csv: "data",
  tsv: "data",
  json: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  ipynb: "data",
  eml: "email",
  msg: "email",
  doc: "office",
  docx: "office",
  ppt: "office",
  pptx: "office",
  ppsx: "office",
  pptm: "office",
  xls: "office",
  xlsx: "office",
  xlsm: "office",
  xlsb: "office",
  odt: "office",
  ods: "office",
  rtf: "office",
  wpd: "office",
  wp: "office",
  epub: "ebook",
  pdf: "pdf",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  "7z": "archive",
};

export function groupOf(fileType: string): string {
  return GROUPS[fileType] ?? "other";
}

interface FixtureJson {
  document?: unknown;
  file_type?: unknown;
  file_size?: unknown;
  expected_frameworks?: unknown;
  metadata?: { requires_ocr?: unknown };
  ground_truth?: { text_file?: unknown; markdown_file?: unknown };
}

export function loadFixtures(fixturesDir: string, corpusRoots: readonly string[]): { fixtures: Fixture[]; invalid: Skipped[] } {
  const fixtures: Fixture[] = [];
  const invalid: Skipped[] = [];
  for (const file of walkJson(fixturesDir)) {
    const id = relative(fixturesDir, file);
    let json: FixtureJson;
    try {
      json = JSON.parse(readFileSync(file, "utf8")) as FixtureJson;
    } catch (error) {
      invalid.push({ id, fileType: "?", reason: `fixture JSON does not parse: ${String(error)}` });
      continue;
    }
    if (typeof json.document !== "string" || typeof json.file_type !== "string") {
      invalid.push({ id, fileType: "?", reason: "fixture has no document or file_type" });
      continue;
    }
    const fileType = json.file_type.toLowerCase();
    // Ground truth: the plaintext file, else the markdown one (runner/run.rs).
    const truth = json.ground_truth?.text_file ?? json.ground_truth?.markdown_file;
    const documentRel = corpusRelative(json.document);
    const groundTruthRel = typeof truth === "string" ? corpusRelative(truth) : null;
    const documentPath = findInRoots(corpusRoots, documentRel);
    fixtures.push({
      id,
      fileType,
      group: groupOf(fileType),
      documentRel,
      documentPath,
      fileSize: documentPath === null ? Number(json.file_size ?? 0) : statSync(documentPath).size,
      groundTruthRel,
      groundTruthPath: groundTruthRel === null ? null : findInRoots(corpusRoots, groundTruthRel),
      requiresOcr: typeof json.metadata?.requires_ocr === "boolean" ? json.metadata.requires_ocr : OCR_BY_DEFAULT.has(fileType),
      expectedFrameworks: Array.isArray(json.expected_frameworks) ? json.expected_frameworks.map(String) : [],
    });
  }
  fixtures.sort((left, right) => left.id.localeCompare(right.id));
  return { fixtures, invalid };
}

/** Why a fixture cannot be in the common cohort, or null when every compared tool can run it. */
export function exclusionReason(fixture: Fixture): string | null {
  if (!TIKA_FORMATS.has(fixture.fileType)) return `format ${fixture.fileType} is not in the harness's Tika format list`;
  if (fixture.requiresOcr) return "requires OCR (ripstream has no OCR)";
  if (fixture.groundTruthRel === null) return "no ground truth in the fixture";
  if (fixture.documentPath === null) return `document not present under any corpus root (${fixture.documentRel})`;
  if (fixture.groundTruthPath === null) return `ground truth not present under any corpus root (${fixture.groundTruthRel})`;
  return null;
}

export function loadCohort(path: string): Cohort {
  const json = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; batch_size?: unknown; fixtures?: unknown };
  if (!Array.isArray(json.fixtures)) throw new Error(`cohort ${path} has no fixtures array`);
  return {
    name: typeof json.name === "string" ? json.name : path,
    batchSize: typeof json.batch_size === "number" ? json.batch_size : 1,
    fixtures: json.fixtures.map(String),
  };
}

function corpusRelative(path: string): string {
  return path.replace(/^(?:\.\.\/)+test_documents\//, "");
}

function findInRoots(roots: readonly string[], rel: string): string | null {
  for (const root of roots) {
    const candidate = resolve(root, rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function* walkJson(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJson(path);
    // Split sidecars describe page ranges of another fixture, as the harness skips them.
    else if (entry.name.endsWith(".json") && !entry.name.endsWith(".split.json")) yield path;
  }
}
