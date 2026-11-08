// (h) child that goes into a sync loop shortly after ready; its ppid-watcher can never fire.
// H_IGNORE_XCPU=1: also swallows SIGXCPU so only the HARD RLIMIT_CPU (SIGKILL) can end it.
import { ready, send } from './_common.mjs';
const ppid = process.ppid;
setInterval(() => { if (process.ppid !== ppid) process.exit(137); }, 20); // the (insufficient) ppid watcher
if (process.env.H_IGNORE_XCPU) process.on('SIGXCPU', () => {});
ready();
setTimeout(() => { send({ t: 'looping', pid: process.pid }); for (;;); }, 100);
