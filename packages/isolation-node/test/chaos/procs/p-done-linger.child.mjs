// (j, production protocol) a grandchild in our group, the terminal 'done', then linger. The grandchild pid travels in a text frame.
import { spawn } from 'node:child_process';
import { ready, send } from './_common.mjs';
ready();
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
send({ t: 'meta', metadata: {} });
send({ t: 'text', chunk: String(gc.pid) });
send({ t: 'done' });
setInterval(() => {}, 1000);
