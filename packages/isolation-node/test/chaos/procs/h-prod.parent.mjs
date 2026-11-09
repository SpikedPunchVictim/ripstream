// (h, production) parent that runs a hung child through the PRODUCTION supervisor/wrapper, then gets SIGKILLed by the harness.
// Prints "CHILD <pid>" once the child reports (via a pid file) that it is entering its sync loop.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProd } from '../lib-prod.mjs';
import { sleep } from '../lib.mjs';
const pidfile = path.join(mkdtempSync(path.join(process.env.CHAOS_SCRATCH ?? os.tmpdir(), 'hprod-')), 'pid');
const run = runProd({
  child: new URL('./p-hung.child.mjs', import.meta.url).pathname,
  args: process.env.H_IGNORE_XCPU ? [pidfile, 'ignore-xcpu'] : [pidfile],
  cpuSecs: Number(process.env.H_CPU_SECS ?? 3),
  deadlineMs: 600000,
});
for (;;) {
  if (existsSync(pidfile) && /^\d+$/.test(readFileSync(pidfile, 'utf8'))) break;
  await sleep(10);
}
console.log(`CHILD ${readFileSync(pidfile, 'utf8')}`);
await run;
