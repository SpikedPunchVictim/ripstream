// (h, production protocol) usage: p-hung.child.mjs <pidfile> [ignore-xcpu]. Reports its pid via the file just before
// it enters the sync loop (the doomed parent cannot see it otherwise; the wrapper passes no custom env).
import { writeFileSync } from 'node:fs';
import { ready } from './_common.mjs';
if (process.argv[3] === 'ignore-xcpu') process.on('SIGXCPU', () => {});
ready();
setTimeout(() => { writeFileSync(process.argv[2], String(process.pid)); for (;;); }, 100);
