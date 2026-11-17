import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { IsolationError } from "@spikedpunch/ripstream-core";
import { createNodeIsolator, type NodeIsolator } from "../src/index.ts";
import { MemoryPool } from "../src/pool.ts";
import { fakeRipstream } from "./fixtures/fake-ripstream.ts";

/**
 * docs/worker-hosting.md ("Testing your mapping"): a caller gets `IsolationError("crash")` in a test by pointing
 * `childModule` at a child that says "ready" and then exits without a terminal frame. This runs that recipe with the real probe
 * and a real child process.
 */
const CRASH_CHILD = fileURLToPath(new URL("./fixtures/documented-crash-child.ts", import.meta.url));
const pool = new MemoryPool({ poolMb: 16_384, overshootMb: 0, maxQueue: 4 });
let isolator: NodeIsolator | undefined;
after(async () => {
  await isolator?.dispose();
  pool.dispose();
});

test("a child that exits after ready, without a terminal frame, is IsolationError reason crash", async () => {
  isolator = await createNodeIsolator({
    config: { mode: "strict", perChildMb: 512, maxTaskMillis: 10_000 },
    childModule: CRASH_CHILD,
    ripstream: fakeRipstream(), // detects application/zip: never on the in-process allowlist, so a child gets it
    pool,
  });
  await assert.rejects(
    isolator.isolate({ input: new TextEncoder().encode("anything") }),
    (error) => error instanceof IsolationError && error.reason === "crash" && error.recoverable === false,
  );
});
