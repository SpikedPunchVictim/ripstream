// (n, production protocol) 'done', then exit at once, leaving a grandchild that holds stdout/stderr/fd 3 open.
import { spawn } from 'node:child_process';
import { ready, send } from './_common.mjs';
ready();
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit', 3] });
send({ t: 'meta', metadata: {} });
send({ t: 'text', chunk: String(gc.pid) });
send({ t: 'done' });
process.exit(0);
