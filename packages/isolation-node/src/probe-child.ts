import { initChildProcess, readInput, sendFrame } from "./child-io.ts";

/**
 * Built-in probe child: speaks the whole child protocol with a trivial
 * payload, so the probe exercises the wrapper, ulimit steps, spawn, fd 3 and
 * stdin delivery exactly as a real parse would. Answers with the number of
 * input bytes it received.
 */
initChildProcess();
sendFrame({ t: "ready", pid: process.pid });
const { bytes } = await readInput();
sendFrame({ t: "meta", metadata: { "ripstream-probe": ["1"] } });
sendFrame({ t: "text", chunk: `probe-ok:${bytes.length}` });
sendFrame({ t: "done" });
