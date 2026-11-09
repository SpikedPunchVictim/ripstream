import { MemoryPool } from "../../src/pool.ts";
import { ChildRunner } from "../../src/runner.ts";
import { fakeSpawn } from "./fake-child.ts";
import { CHILD } from "./helpers.ts";

/**
 * A parent process for the "dispose() keeps the process alive until it returns" test. The fake child is never
 * reaped, so after the kill the ONLY thing left that can wake the event loop is dispose()'s own bounded wait. If
 * that timer were unref'd, the loop would be empty, Node would exit with code 13 ("unsettled top-level await") and
 * the line below would never print.
 */
const { spawnFn, children } = fakeSpawn();
const runner = new ChildRunner({
  pool: new MemoryPool({ poolMb: 1024, overshootMb: 0, maxQueue: 1 }),
  childScript: CHILD,
  perChildMb: 256,
  heapMb: 64,
  rssLimitMb: 128,
  cpuSecs: 30,
  maxTaskMillis: 30_000,
  maxInputBytes: 1024,
  maxResultBytes: 1024,
  spawnFn,
  reapWaitMs: 20,
  disposeWaitMs: 300,
});
const running = runner.run({ input: new Uint8Array([1]) });
running.catch(() => {});
while (children.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
const started = performance.now();
await runner.dispose();
process.stdout.write(`DISPOSED after ${performance.now() - started >= 250 ? "the wait" : "too soon"}\n`);
