// (k/w7, production) run under a shell that LOWERED the address-space limit, so the production wrapper's
// `ulimit -v <default 6 GiB>` is refused. Prints "RESULT <json>".
import { runProd, DEFAULT_VMEM_KB } from '../lib-prod.mjs';
const r = await runProd({ child: new URL('./k-trivial.child.mjs', import.meta.url).pathname, vmemKb: DEFAULT_VMEM_KB, deadlineMs: 20000 });
console.log(`RESULT ${JSON.stringify({ outcome: r.obs.outcome, readySeen: r.obs.readySeen, error: r.obs.error, stderr: r.obs.stderr })}`);
