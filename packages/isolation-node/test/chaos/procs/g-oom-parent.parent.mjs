// (g) parent bigger than child inside a small cgroup. usage: g-oom-parent.parent.mjs adj|noadj
// Prints a line only if the PARENT survives; the harness observes the parent's own death otherwise.
import { runChild } from '../lib.mjs';
const keep = [];
for (let i = 0; i < 25; i++) { const b = Buffer.allocUnsafe(16 << 20); b.fill(1); keep.push(b); } // parent ~400MB resident
const obs = await runChild({
  argv: [new URL('./g-oom-child.child.mjs', import.meta.url).pathname],
  env: process.argv[2] === 'adj' ? {} : { REF_NO_OOM_ADJ: '1' },
  timeoutMs: 60000,
});
console.log(`PARENT SURVIVED; child outcome=${obs.outcome} killReason=${obs.killReason}`);
