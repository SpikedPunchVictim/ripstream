import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";
import { ole2FromSpec, type Ole2Spec } from "./ole2-fixture.ts";

interface Measured {
  /** Tika 4.2.0's answer when the name is the typical one for the format, and when it is `x.bin`. */
  readonly typical: string;
  readonly neutral: string;
}

interface RealGolden extends Measured {
  /** A Tika 4.2.0 test document, kept under `fixtures/ole2`. */
  readonly file: string;
}

interface SyntheticGolden extends Measured {
  readonly id: string;
  readonly note?: string;
  readonly filename: string;
  readonly spec: Ole2Spec;
}

const goldens = JSON.parse(readFileSync(new URL("./ole2-goldens.json", import.meta.url), "utf8")) as {
  tikaVersion: string;
  real: readonly RealGolden[];
  synthetic: readonly SyntheticGolden[];
};

const detector = new DefaultDetector();

async function detect(bytes: Uint8Array, filename: string): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    const metadata = new Metadata();
    metadata.set("tk:resource-name", filename);
    return (await detector.detect(stream, metadata, new ParseContext())).toString();
  } finally {
    await stream.close();
  }
}

async function mismatches(bytes: Uint8Array, id: string, filename: string, measured: Measured): Promise<string[]> {
  const failures: string[] = [];
  for (const [variant, name, expected] of [
    ["typical", filename, measured.typical],
    ["neutral", "x.bin", measured.neutral],
  ] as const) {
    const actual = await detect(bytes, name);
    if (actual !== expected) failures.push(`${id} (${variant}, ${name}): expected ${expected}, got ${actual}`);
  }
  return failures;
}

test("OLE2 detection matches Tika 4.2.0 on every measured test document", async () => {
  assert.equal(goldens.tikaVersion, "4.2.0");
  const failures: string[] = [];
  for (const golden of goldens.real) {
    const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/ole2/${golden.file}`, import.meta.url)));
    failures.push(...(await mismatches(bytes, golden.file, golden.file, golden)));
  }
  assert.deepEqual(failures, []);
});

test("OLE2 detection matches Tika 4.2.0 on every measured synthetic file", async () => {
  const failures: string[] = [];
  for (const golden of goldens.synthetic) {
    failures.push(...(await mismatches(ole2FromSpec(golden.spec), golden.id, golden.filename, golden)));
  }
  assert.deepEqual(failures, []);
});

test("the goldens cover each OLE2 rule", () => {
  const ids = new Set(goldens.synthetic.map((golden) => golden.id));
  for (const id of [
    "workbook-msgraph",
    "stardraw3-impress",
    "works-compobj-quill96",
    "sldworks",
    "outlook",
    "project-props",
    "esri-layer",
    "dgn8",
    "hwp",
    "quattro-7-8",
    "quattro-9",
    "corel-presentations",
    "word-beats-hwp",
    "drm-data-space-at-depth-10",
    "duplicate-names",
    "sibling-loop",
    "sector-size-4096",
    "difat-large-file",
    "compobj-mini-chain-loop",
  ]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.ok(goldens.real.length >= 20);
});
