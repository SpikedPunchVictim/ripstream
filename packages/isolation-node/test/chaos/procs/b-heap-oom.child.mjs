// (b) V8 heap exhaustion under --max-old-space-size (small-object push).
import { ready } from './_common.mjs';
ready();
const a = [];
for (let i = 0; ; i++) a.push({ i, s: 'x' + i });
