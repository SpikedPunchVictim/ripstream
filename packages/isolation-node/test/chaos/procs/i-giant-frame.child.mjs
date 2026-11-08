// (i) one 64 MiB single-line JSON frame ('[0,0,...]') on fd 3, after a small valid frame.
import { ready, send, sendBuf } from './_common.mjs';
ready();
send({ t: 'hello' });
const N = 64 * 2 ** 20; // frame is N-1 bytes: '[' + '0,0,...,0' + ']' = 2^25-1 elements
const big = Buffer.alloc(N - 1);
big.fill('0,', 1, N - 2);
big[0] = 0x5b; big[N - 2] = 0x5d;
sendBuf(big);
sendBuf(Buffer.from('\n'));
send({ t: 'done' });
