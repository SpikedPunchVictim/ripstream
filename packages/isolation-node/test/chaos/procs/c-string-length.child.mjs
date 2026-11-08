// (c) giant string via doubling: V8 throws RangeError 'Invalid string length' (uncaught -> rc 1), not OOM.
import { ready } from './_common.mjs';
ready();
let s = 'x';
for (;;) s += s;
