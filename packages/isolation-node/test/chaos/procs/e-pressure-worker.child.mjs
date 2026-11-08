// (e) fill the address space (untouched allocations) up to ~24MB below the ulimit -v cap AFTER ready, then start
// a Worker (needs ~270MB of fresh reservations). Expected: dies mid-run (SIGTRAP 'Failed to reserve virtual
// memory' / SIGABRT / ...) -- never before ready.
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { ready, send } from './_common.mjs';
ready();
const capBytes = Number(/Max address space\s+(\d+)/.exec(readFileSync('/proc/self/limits', 'utf8'))[1]);
const vmBytes = () => Number(/VmSize:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))[1]) * 1024;
const keep = [];
for (const [size, headroom] of [[16 << 20, 64 << 20], [1 << 20, 24 << 20]]) {
  while (vmBytes() + size < capBytes - headroom) keep.push(Buffer.allocUnsafe(size));
}
send({ t: 'pressure', headroomMb: Math.round((capBytes - vmBytes()) / 1048576) });
const w = new Worker('setTimeout(() => {}, 10)', { eval: true });
w.on('error', (e) => { send({ t: 'worker-error', msg: String(e.message).slice(0, 200) }); process.exit(3); });
w.on('exit', () => { send({ t: 'worker-exit' }); process.exit(0); });
