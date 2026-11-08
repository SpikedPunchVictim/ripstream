// (a) synchronous hang: no timer or signal handler in this process can ever run again.
import { ready } from './_common.mjs';
ready();
for (;;);
