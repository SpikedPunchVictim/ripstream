// (h) parent that spawns a hung child via the reference wrapper, then gets SIGKILLed by the harness.
// Prints "CHILD <pid>" only once the child reported it is entering its sync loop.
import { runChild } from '../lib.mjs';
await runChild({
  argv: [new URL('./h-hung.child.mjs', import.meta.url).pathname],
  env: { REF_CPU_SECS: process.env.H_CPU_SECS ?? '3' },
  timeoutMs: 600000,
  onFrame: (v) => { if (v.t === 'looping') console.log(`CHILD ${v.pid}`); },
});
