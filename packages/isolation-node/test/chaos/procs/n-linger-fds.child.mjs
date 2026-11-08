// (n) sends 'done' and exits at once, but leaves a grandchild holding the child's stdout/stderr/fd 3 open:
// the parent sees 'exit' immediately and 'close' only when the grandchild dies.
import { spawn } from 'node:child_process';
import { ready, send } from './_common.mjs';
ready();
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit', 3] });
send({ t: 'gc', pid: gc.pid });
send({ t: 'done' });
process.exit(0);
