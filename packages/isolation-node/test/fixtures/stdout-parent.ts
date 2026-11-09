import { runChild } from "../../src/supervisor.ts";
import { CHILD } from "./helpers.ts";

/**
 * A parent process for the "child stdout stays out of the parent's stdout" test: it runs the real supervisor
 * against a child that writes markers to its own stdout, and prints one line of its own.
 */
const result = await runChild({
  scriptPath: CHILD,
  scriptArgs: ["stdout-noise"],
  cpuSecs: 30,
  heapMb: 128,
  request: { input: new Uint8Array([1]) },
  deadlineMs: 15_000,
  maxResultBytes: 1024 * 1024,
});
process.stdout.write(`PARENT-DONE ${result.kind}\n`);
