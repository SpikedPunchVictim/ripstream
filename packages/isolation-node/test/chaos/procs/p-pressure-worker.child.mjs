// (e, production protocol) same pressure as e-pressure-worker.child.mjs, but only frames the production reader accepts.
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
const w = new Worker('setTimeout(() => {}, 10)', { eval: true });
w.on('error', (e) => { process.stderr.write(`worker-error ${String(e.message).slice(0, 200)}\n`); process.exit(3); });
w.on('exit', () => { send({ t: 'meta', metadata: {} }); send({ t: 'done' }); process.exit(0); });
