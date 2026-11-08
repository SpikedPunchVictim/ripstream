// (g) child that grows external memory fast until the cgroup limit is hit.
import { ready } from './_common.mjs';
const ppid = process.ppid;
setInterval(() => { if (process.ppid !== ppid) process.exit(0); }, 20); // do not outlive a killed parent: it would poison the next run
ready();
const keep = [];
setInterval(() => { const b = Buffer.allocUnsafe(8 << 20); b.fill(1); keep.push(b); }, 5);
