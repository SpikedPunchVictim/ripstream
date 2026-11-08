// Chaos suite runner. usage: node run.mjs [--only a,b] [--mode main|cgroup|group1]
//   main   (default) everything except g/g1
//   cgroup fixture g   (needs a finite cgroup v2 memory limit, e.g. docker --memory=700m --memory-swap=700m)
//   group1 fixture g1  (needs --privileged + the same limit; the runner is expected to be killed with the cgroup)
// env CHAOS_EMULATED=1 marks emulated results. Linux only. Exit code 1 if any row FAILs.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMULATED, HERE, PAGE, checkObs, expectationFor, platformKey } from './lib.mjs';
import { makeCases } from './cases.mjs';

if (process.platform !== 'linux') {
  console.error(`chaos suite needs Linux (RLIMIT/proc/cgroup semantics); this is ${process.platform}. Use run-docker.sh.`);
  process.exit(2);
}
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'main';
const table = JSON.parse(readFileSync(path.join(HERE, 'expected.json'), 'utf8'));
const key = platformKey();
const scratch = mkdtempSync(path.join(process.env.CHAOS_SCRATCH ?? os.tmpdir(), 'chaos-'));
const thp = (() => { try { return readFileSync('/sys/kernel/mm/transparent_hugepage/enabled', 'utf8').trim(); } catch { return 'n/a'; } })();
console.log(`== chaos suite: ${key} node=${process.version} pagesize=${PAGE} thp=[${thp}] mode=${mode}${EMULATED ? ' [EMULATED, not authoritative]' : ''}`);
if (key === 'musl-amd64') console.log('!! musl-amd64 expectations in expected.json were NEVER OBSERVED (marked "unobserved"); treat results as first observations.');

const tally = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0, FINDING: 0 };
const say = (status, id, text) => { tally[status]++; console.log(`${status.padEnd(4)} ${id.padEnd(26)} ${text}`); };

try {
  for (const c of makeCases(table, key, { scratch })) {
    const caseMode = c.mode ?? 'main';
    if (only ? !only.includes(c.id) : caseMode !== mode) continue;
    if (only && caseMode !== mode) { say('SKIP', c.id, `needs --mode ${caseMode}`); continue; }
    let rows;
    try { rows = await c.run(); } catch (err) { say('FAIL', c.id, `harness error: ${err.stack}`); continue; }
    for (const r of rows) {
      if (r.skip) { say('SKIP', r.id, r.skip); continue; }
      const e = expectationFor(table, r.id, key);
      const fails = [...(r.fails ?? [])];
      if (r.obs) {
        if (!e) fails.push('no entry in expected.json');
        else fails.push(...checkObs(e, r.obs));
      }
      const o = r.obs;
      const seen = o ? `${o.outcome}${o.killReason ? ` killedBy=${o.killReason}` : ''} ready=${o.readySeen ? 'y' : 'n'}` +
        (o.stderr.trim() ? ` stderr=${JSON.stringify((o.stderr.trim().split('\n').find((x) => /FATAL|Fatal|RangeError|Failed|not found|not set/.test(x)) ?? o.stderr.trim().split('\n')[0]).slice(0, 90))}` : '') : '';
      const soft = EMULATED && e?.emulatedSoft;
      const status = fails.length === 0 ? 'PASS' : soft ? 'WARN' : 'FAIL';
      const unobs = e?.unobserved ? ' [expectation UNOBSERVED on this platform]' : '';
      say(status, r.id, `${seen} ${r.notes ?? ''}${unobs}${fails.length ? `\n     ${soft ? 'emulated-variance: ' : 'because: '}${fails.join('; ')}` : ''}`);
      for (const f of r.findings ?? []) { tally.FINDING++; console.log(`     *** ${f}`); }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`== ${key}: ${tally.PASS} pass, ${tally.FAIL} fail, ${tally.WARN} warn(emulated), ${tally.SKIP} skip, ${tally.FINDING} design-finding(s)`);
process.exit(tally.FAIL ? 1 : 0);
