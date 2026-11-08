// (d) fast page-touch of a big pre-reserved (untouched) ArrayBuffer: RSS grows at memory-bandwidth speed.
import { ready, send } from './_common.mjs';
ready();
const a = new Uint8Array(3 * 2 ** 30);
send({ t: 'touching' });
for (let i = 0; i < a.length; i += 4096) a[i] = 1;
send({ t: 'survived' });
