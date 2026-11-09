// (d, production protocol) fast page-touch of a big pre-reserved ArrayBuffer; valid frames only.
import { ready, send } from './_common.mjs';
ready();
const a = new Uint8Array(3 * 2 ** 30);
for (let i = 0; i < a.length; i += 4096) a[i] = 1;
send({ t: 'meta', metadata: {} });
send({ t: 'done' });
