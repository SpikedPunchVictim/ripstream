// (j) sends the terminal 'done' frame, then lingers; also leaves a lingering grandchild in the same process group.
import { spawn } from 'node:child_process';
import { ready, send } from './_common.mjs';
ready();
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
send({ t: 'gc', pid: gc.pid });
send({ t: 'done' });
setInterval(() => {}, 1000);
