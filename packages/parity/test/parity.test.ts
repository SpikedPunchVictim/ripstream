import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureGolden,
  formatReport,
  runParity,
  compareSnapshot,
  goldenPath,
  readGolden,
  needsRegeneration,
  regenerateGolden,
  textSimilarity,
  writeGolden,
  type Oracle,
  type OracleSnapshot,
  type ParityFixture,
} from "../src/index.ts";

const fixture: ParityFixture = {
  id: "text/plain",
  mediaType: "text/plain",
  bytes: new TextEncoder().encode("hello"),
};

const snapshot: OracleSnapshot = {
  mediaType: "text/plain",
  text: "hello world",
  metadata: {
    "Content-Type": ["text/plain"],
    "X-TIKA:parse_time_millis": ["12"],
  },
};

const oracle: Oracle = {
  version: "test-oracle-1",
  configHash: "config-a",
  async analyze(): Promise<OracleSnapshot> {
    return snapshot;
  },
};

test("captures and round-trips goldens", async () => {
  const root = mkdtempSync(join(tmpdir(), "ripstream-parity-"));
  try {
    const golden = await captureGolden(oracle, fixture);
    const path = writeGolden(root, golden);
    assert.equal(path, goldenPath(root, fixture.id));
    const loaded = readGolden(path);
    assert.equal(loaded.oracle.version, "test-oracle-1");
    assert.equal(loaded.fixture.sha256, golden.fixture.sha256);
    assert.deepEqual(
      compareSnapshot(fixture.id, snapshot, loaded, {
        ignoreMetadataKeys: ["X-TIKA:parse_time_millis"],
      }),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports media type, text and metadata diffs", async () => {
  const golden = await captureGolden(oracle, fixture);
  const diffs = compareSnapshot(
    fixture.id,
    {
      mediaType: "application/octet-stream",
      text: "totally different",
      metadata: { "Content-Type": ["text/html"] },
    },
    golden,
    { textThreshold: 0.9 },
  );
  assert.deepEqual(
    diffs.map((diff) => diff.kind).sort(),
    ["mediaType", "metadata", "text"],
  );
});

test("normalizes whitespace and computes similarity", () => {
  assert.equal(textSimilarity("a \n b", "a b"), 1);
  assert.ok(textSimilarity("hello world", "hello") < 1);
});

test("runs the golden suite without the oracle container", async () => {
  const root = mkdtempSync(join(tmpdir(), "ripstream-parity-run-"));
  try {
    writeGolden(root, await captureGolden(oracle, fixture));
    const report = await runParity([fixture], oracle, root);
    assert.equal(report.passed, 1);
    assert.deepEqual(report.failed, []);
    assert.match(formatReport(report), /fixtures: 1, passed: 1/);

    const missing = await runParity(
      [{ ...fixture, id: "missing" }],
      oracle,
      root,
    );
    assert.deepEqual(missing.missingGoldens, ["missing"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regenerates goldens when oracle config changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ripstream-parity-regen-"));
  try {
    const golden = await captureGolden(oracle, fixture);
    assert.equal(needsRegeneration(golden, oracle), false);
    assert.equal(
      needsRegeneration(golden, { ...oracle, configHash: "changed" }),
      true,
    );
    await regenerateGolden(root, { ...oracle, configHash: "changed" }, fixture);
    assert.equal(readGolden(goldenPath(root, fixture.id)).oracle.configHash, "changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
