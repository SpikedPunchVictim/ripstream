import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointStore, withRetry } from "../src/index.ts";

test("retries and persists checkpoints", async () => {
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts++;
    if (attempts < 3) throw new Error("transient");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);

  const directory = mkdtempSync(join(tmpdir(), "ripstream-checkpoint-"));
  try {
    const path = join(directory, "checkpoint.json");
    const store = await CheckpointStore.open(path);
    assert.equal(store.has("a"), false);
    await store.mark("a");
    const reopened = await CheckpointStore.open(path);
    assert.equal(reopened.has("a"), true);
    assert.match(readFileSync(path, "utf8"), /"a"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CheckpointStore.open on a missing file yields a fresh store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-checkpoint-"));
  try {
    const store = await CheckpointStore.open(join(directory, "missing.json"));
    assert.equal(store.size, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CheckpointStore.open rejects a corrupt non-empty checkpoint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-checkpoint-"));
  try {
    const path = join(directory, "checkpoint.json");
    writeFileSync(path, '["a", "b"');
    await assert.rejects(CheckpointStore.open(path), /Corrupt checkpoint file/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CheckpointStore.mark leaves valid JSON and no temp files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-checkpoint-"));
  try {
    const path = join(directory, "checkpoint.json");
    const store = await CheckpointStore.open(path);
    await Promise.all([store.mark("a"), store.mark("b")]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ["a", "b"]);
    assert.deepEqual(readdirSync(directory), ["checkpoint.json"]);
    assert.equal((await CheckpointStore.open(path)).has("b"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
