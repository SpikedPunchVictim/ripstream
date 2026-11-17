// The crash child docs/worker-hosting.md shows callers: the whole file is the documented recipe, except that the
// import there names the package ("@spikedpunch/ripstream-isolation-node") instead of the source.
import { initChildProcess, readInput, sendFrame } from "../../src/index.ts";

initChildProcess();
sendFrame({ t: "ready", pid: process.pid });
await readInput();
process.exit(1); // no terminal frame: the parent reports IsolationError("crash")
