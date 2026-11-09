// (i, production protocol) ready, then ONE 64 MiB fd-3 line (no valid small frame in front of it).
import { ready, sendBuf, send } from './_common.mjs';
ready();
const N = 64 * 2 ** 20;
const big = Buffer.alloc(N - 1);
big.fill('0,', 1, N - 2);
big[0] = 0x5b; big[N - 2] = 0x5d;
sendBuf(big);
sendBuf(Buffer.from('\n'));
send({ t: 'done' });
