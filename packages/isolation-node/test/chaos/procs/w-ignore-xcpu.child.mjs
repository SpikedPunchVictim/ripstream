// (w) handles/ignores SIGXCPU and burns CPU: only the HARD RLIMIT_CPU backstop (SIGKILL) can stop it.
import { ready } from './_common.mjs';
process.on('SIGXCPU', () => {});
ready();
for (;;);
