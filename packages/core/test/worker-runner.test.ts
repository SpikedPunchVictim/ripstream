import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WorkerTaskError,
  WorkerTimeoutError,
  runIsolatedTask,
} from "../src/index.ts";

const jobs = new URL("./fixtures/worker-jobs.ts", import.meta.url);

test("runs a task in an isolated worker", async () => {
  assert.deepEqual(
    await runIsolatedTask({
      moduleUrl: jobs,
      exportName: "echo",
      payload: { value: 42 },
    }),
    { value: 42 },
  );
});

test("contains worker crashes", async () => {
  await assert.rejects(
    runIsolatedTask({ moduleUrl: jobs, exportName: "crash" }),
    WorkerTaskError,
  );
});

test("times out hung workers", async () => {
  await assert.rejects(
    runIsolatedTask({
      moduleUrl: jobs,
      exportName: "hang",
      timeoutMs: 50,
    }),
    WorkerTimeoutError,
  );
});
