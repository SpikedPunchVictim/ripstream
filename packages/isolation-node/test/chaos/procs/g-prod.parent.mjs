// (g, production) parent (~400MB) larger than the child inside a small cgroup, child supervised by the PRODUCTION supervisor
// (whose wrapper sets oom_score_adj=1000 itself). Prints a line only if the PARENT survives.
import { runProd } from '../lib-prod.mjs';
const keep = [];
for (let i = 0; i < 25; i++) { const b = Buffer.allocUnsafe(16 << 20); b.fill(1); keep.push(b); } // parent ~400MB resident
const r = await runProd({ child: new URL('./g-oom-child.child.mjs', import.meta.url).pathname, deadlineMs: 60000 });
console.log(`PARENT SURVIVED; child outcome=${r.obs.outcome} error=${r.obs.error} killReason=${r.obs.killReason}`);
