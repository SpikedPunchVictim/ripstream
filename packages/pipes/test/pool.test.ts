import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointStore, WorkerPool, withRetry } from "../src/index.ts";

const jobs = new URL("./fixtures/jobs.ts", import.meta.url);

test("runs bounded worker pool tasks", async () => {
  const pool = new WorkerPool({ moduleUrl: jobs, exportName: "echo", size: 2 });
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) => pool.run<number>(index)),
  );
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
});

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
