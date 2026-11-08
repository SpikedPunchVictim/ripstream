// Child-side helpers. fd 3 is the NDJSON frame channel (as in design v3).
import { writeSync } from 'node:fs';
export function sendBuf(buf) {
  for (let off = 0; off < buf.length;) off += writeSync(3, buf, off); // blocking pipe: backpressure
}
export const send = (obj) => sendBuf(Buffer.from(JSON.stringify(obj) + '\n'));
export const ready = () => send({ t: 'ready', pid: process.pid });
