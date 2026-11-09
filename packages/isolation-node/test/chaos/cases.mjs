// Parent-side checks, one case per entry. Each run() returns rows { id, obs?, notes?, fails? };
// the runner applies the expected-outcome table (expected.json) to every row that has an `obs`.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import {
  cpuSecs,
  REF_SCRIPT, REPO_ROOT, cgroupFile, checkObs, expectationFor, isAlive, phaseOf, proc, runChild, sleep,
} from './lib.mjs';
import { DEFAULT_VMEM_KB, leakFails, runProd, waitGroupGone } from './lib-prod.mjs';

const bytesMb = (n) => Math.round(n / 1048576);
const row = (id, obs, notes = '', fails = []) => ({ id, obs, notes, fails });

export function makeCases(table, key, ctx) {
  const SCRATCH = ctx.scratch;
  const limits = (id) => expectationFor(table, id, key)?.limits ?? {};

  // PRODUCTION wrapper meets a `ulimit` the OS refuses (valid number above an inherited hard limit): must exit 126 before node runs.
  // Shared by rows k-ulimit-fails-prod and w7-fail-closed-ulimit-refused-prod. Runs the production supervisor in a sub-process
  // that a shell has put under a lowered hard address-space limit.
  const ulimitRefusedProd = async () => {
    const p = spawn('/bin/sh', ['-c', 'ulimit -v 5000000 || exit 99; exec "$0" "$@"', process.execPath, proc('p-ulimit-refused.parent.mjs')],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (x) => (out += x));
    p.stderr.on('data', (x) => (out += x));
    const [code] = await new Promise((r) => p.on('close', (cd, sg) => r([cd, sg])));
    const line = out.split('\n').find((x) => x.startsWith('RESULT '));
    if (!line) return { obs: { outcome: `parent:code:${code}`, stderr: out.slice(-500), readySeen: false, killReason: null, error: null, frames: [] }, fails: [`no RESULT line from the production parent (exit ${code}): ${out.slice(-300)}`] };
    const r = JSON.parse(line.slice(7));
    return { obs: { ...r, killReason: null, frames: [] }, fails: [] };
  };

  // (a) sync hang killed by the parent timer (L2).
  const a = async () => {
    const obs = await runChild({ argv: [proc('a-sync-hang.child.mjs')], timeoutMs: 1500 });
    const prod = await runProd({ child: proc('a-sync-hang.child.mjs'), deadlineMs: 1500 });
    return [
      row('a-sync-hang', obs, `wall=${obs.wallMs}ms`),
      row('a-sync-hang-prod', prod.obs, `PRODUCTION supervisor: wall=${prod.obs.wallMs}ms`, leakFails(prod)),
    ];
  };

  // (b) heap OOM under L1; 128MB heap keeps it quick.
  const b = async () => {
    const obs = await runChild({ argv: [proc('b-heap-oom.child.mjs')], env: { REF_HEAP_MB: '128' }, timeoutMs: 30000 });
    const max = limits('b-heap-oom').maxWallMs;
    const prod = await runProd({ child: proc('b-heap-oom.child.mjs'), heapMb: 128, deadlineMs: 30000 });
    return [
      row('b-heap-oom', obs, `wall=${obs.wallMs}ms (bound ${max}ms: L1 must bite fast, not at the default ~2GB heap)`,
        obs.wallMs <= max ? [] : [`took ${obs.wallMs}ms > ${max}ms: --max-old-space-size not effective?`]),
      row('b-heap-oom-prod', prod.obs, `PRODUCTION supervisor: wall=${prod.obs.wallMs}ms (bound ${max}ms)`,
        [...leakFails(prod), ...(prod.obs.wallMs <= max ? [] : [`took ${prod.obs.wallMs}ms > ${max}ms: --max-old-space-size not effective?`])]),
    ];
  };

  // (c) RangeError 'Invalid string length', rc=1, NOT an abort.
  const c = async () => {
    const obs = await runChild({ argv: [proc('c-string-length.child.mjs')], timeoutMs: 30000 });
    const prod = await runProd({ child: proc('c-string-length.child.mjs'), deadlineMs: 30000 });
    return [
      row('c-string-length', obs, `wall=${obs.wallMs}ms`),
      row('c-string-length-prod', prod.obs, `PRODUCTION supervisor: wall=${prod.obs.wallMs}ms`, leakFails(prod)),
    ];
  };

  // (d) fast page-touch of a 3 GiB reserved buffer. The asserted number is the WORST per-poll RSS step over N reps
  // (what the pool gate must add per child), not rssAtKill-limit (which is sampling-phase luck).
  // dCore is shared by the P0 stand-in row ('d-page-touch') and the PRODUCTION row ('d-page-touch-prod'): `runOnce(rssLimitMb)`
  // returns an observation from whichever supervisor is under test.
  const dCore = async (id, runOnce) => {
    const l = limits(id);
    const e = expectationFor(table, id, key);
    const LIMIT = 512;
    const reps = Number(process.env.CHAOS_D_REPS ?? l.reps);
    const steps = [];
    const dts = [];
    const medDts = [];
    const overs = [];
    const fails = [];
    for (let r = 1; r <= reps; r++) {
      const obs = await runOnce(LIMIT);
      fails.push(...checkObs(e, obs).map((x) => `rep${r}: ${x}`));
      if (obs.groupLeak) fails.push(`rep${r}: process group still alive after the run settled`);
      overs.push(obs.rssAtKillMb === null ? NaN : Math.round(obs.rssAtKillMb - LIMIT));
      // Free run: same poller, never kills, so the poll sees the child's full growth capability (the kill run above
      // stops at the first sample over the limit and therefore truncates the step it can observe).
      const free = await runOnce(1e9);
      // A free run that finished its work is a success even if the supervisor's post-'done' grace kill (250ms)
      // beat the exit of a process that had to tear down 3GiB (harness race, reproduced under CPU load; the P0 raw
      // runner has no killReason, so it still requires a clean exit).
      const freeOk = free.outcome === 'code:0' || (free.killReason === 'grace' && free.outcome === 'signal:SIGKILL');
      if (!freeOk) fails.push(`rep${r}: free run ended ${free.outcome} killReason=${free.killReason ?? 'none'}`);
      steps.push(Math.round(free.maxStepMb));
      dts.push(free.maxStepDtMs);
      medDts.push(free.medianDtMs);
    }
    const sorted = [...steps].sort((a, b) => a - b);
    const max = sorted.at(-1);
    const median = sorted[Math.floor(sorted.length / 2)];
    // The measured step does NOT discriminate poll intervals in a VM (growth saturates at ~0.5-1GB per poll), so the
    // fixture asserts on the MEASURED poller interval (median of the real inter-sample deltas per rep), not on config:
    // a poller slower than the design's measures nothing, whatever pollMs claims.
    const measuredPollMs = Math.max(...medDts);
    if (measuredPollMs > 1.5 * l.designPollMs) {
      fails.push(`MEASURED poll interval ${measuredPollMs}ms (median inter-sample delta, worst rep) > 1.5 x the design's ${l.designPollMs}ms`);
    }
    if (max > l.maxStepMb) fails.push(`worst per-poll step ${max}MB > asserted bound ${l.maxStepMb}MB`);
    const findings = max > l.designStepMb
      ? [`DESIGN FINDING: worst per-poll RSS step ${max}MB (measured poll ${measuredPollMs}ms) exceeds the design's ${l.designStepMb}MB per-child overshoot`]
      : [];
    return [{
      ...row(id, null,
        `measuredPollMs=${measuredPollMs} (configured ${l.pollMs}) reps=${reps} (free-run) perPollStepMB min=${sorted[0]} median=${median} MAX=${max} (bound ${l.maxStepMb}, design ${l.designStepMb}) steps=[${steps.join(',')}] stepDtMs=[${dts.join(',')}] rssAtKill-limit=[${overs.join(',')}]`, fails),
      findings,
    }];
  };
  const d = async () => {
    const l = limits('d-page-touch');
    const lp = limits('d-page-touch-prod');
    return [
      ...(await dCore('d-page-touch', (rssLimitMb) => runChild({ argv: [proc('d-page-touch.child.mjs')], rssLimitMb, pollMs: l.pollMs, timeoutMs: 60000 }))),
      ...(await dCore('d-page-touch-prod', async (rssLimitMb) => {
        const r = await runProd({ child: proc('p-page-touch.child.mjs'), rssLimitMb, pollMs: lp.pollMs, deadlineMs: 60000 });
        return Object.assign(r.obs, { groupLeak: !r.groupGone });
      })),
    ];
  };

  // (e) memory pressure then new Worker: must die AFTER ready; startup-phase death is distinguishable.
  const e = async () => {
    const rows = [];
    for (let i = 1; i <= 3; i++) {
      const obs = await runChild({ argv: [proc('e-pressure-worker.child.mjs')], env: { REF_VMEM_KB: '2097152' }, timeoutMs: 30000 });
      const fails = phaseOf(obs) === 'crash' || phaseOf(obs) === 'done' ? [] : [`phase=${phaseOf(obs)} (mid-run death misread as startup)`];
      const marker = /Failed to reserve|out of memory|Fatal|worker|Worker/.exec(obs.stderr + JSON.stringify(obs.frames))?.[0] ?? '-';
      rows.push(row(`e-pressure-worker#${i}`, obs, `phase=${phaseOf(obs)} marker=${marker}`, fails));
    }
    // Control: a cap too small to boot dies BEFORE ready -> 'unavailable' phase.
    const boot = await runChild({ argv: [proc('k-trivial.child.mjs')], env: { REF_VMEM_KB: '102400' }, timeoutMs: 30000 });
    const fails = phaseOf(boot) === 'unavailable' ? [] : [`startup death classified ${phaseOf(boot)}`];
    rows.push(row('e-startup-control', boot, `phase=${phaseOf(boot)}`, fails));

    // PRODUCTION supervisor + wrapper. The production coarse cap has a 4 GiB floor, so the pressure child fills up to it.
    for (let i = 1; i <= 3; i++) {
      const prod = await runProd({ child: proc('p-pressure-worker.child.mjs'), vmemKb: 4194304, deadlineMs: 30000 });
      const marker = /Failed to reserve|out of memory|Fatal|worker|Worker/.exec(prod.obs.stderr)?.[0] ?? '-';
      rows.push(row(`e-pressure-worker-prod#${i}`, prod.obs, `PRODUCTION supervisor: marker=${marker}`, leakFails(prod)));
    }
    // Control: a child that cannot even load dies BEFORE ready -> the production classifier must say 'unavailable'.
    const prodBoot = await runProd({ child: '/nonexistent/chaos-child.mjs', deadlineMs: 30000 });
    rows.push(row('e-startup-control-prod', prodBoot.obs, `PRODUCTION supervisor: error=${prodBoot.obs.error}`, leakFails(prodBoot)));
    return rows;
  };

  // (f) WASM sqlite parse (~28MB db) under the coarse L4 cap. The Opus-review banding only exists in the full pipeline, so
  // the built bundle (packages/bundle-standard/dist) is REQUIRED: missing => FAIL (or loud SKIP with CHAOS_SKIP_BUNDLE=1).
  const MARKERS = [['Array buffer allocation failed', 'arrbuf'], ['Zone', 'zone'], ['Failed to reserve virtual memory', 'reserve'],
    ['Allocation failed', 'alloc'], ['out of memory', 'oom']];
  const markerOf = (o) => MARKERS.find(([m]) => o.stderr.includes(m))?.[1] ?? (o.stderr.trim() ? 'stderr?' : '-');
  const refDefaultMb = Number(/REF_VMEM_KB:-(\d+)/.exec(REF_SCRIPT)[1]) / 1024;
  const f = async () => {
    const sqljs = createRequire(path.join(REPO_ROOT, 'packages/parser-db/package.json')).resolve('sql.js');
    const dist = process.env.CHAOS_BUNDLE_DIST ?? path.join(REPO_ROOT, 'packages/bundle-standard/dist/index.js');
    const db = path.join(SCRATCH, 'blob28.sqlite');
    const SQL = await createRequire(import.meta.url)(sqljs)();
    const d = new SQL.Database();
    d.run("create table t(a blob); insert into t values('hi');");
    d.run('insert into t values(zeroblob(28000000))');
    writeFileSync(db, d.export());
    d.close();
    const bare = { SQLJS_PATH: sqljs };
    const rows = [];
    const okDone = (o) => (o.frames.some((x) => x.t === 'done') ? [] : ['no done frame']);
    const r1 = await runChild({ argv: [proc('f-sqlite.child.mjs'), db], env: bare, timeoutMs: 120000 });
    rows.push(row('f-sqljs-coarse', r1, `wall=${r1.wallMs}ms rss=${r1.frames.find((x) => x.t === 'done')?.rssMb}MB`, okDone(r1)));
    const p1 = await runProd({ child: proc('p-sqlite.child.mjs'), args: [db, 'bare', sqljs], deadlineMs: 120000 });
    rows.push(row('f-sqljs-coarse-prod', p1.obs, `PRODUCTION supervisor (default coarse cap ${DEFAULT_VMEM_KB / 1024}MB): wall=${p1.obs.wallMs}ms`, leakFails(p1)));
    if (!existsSync(dist)) {
      const why = 'packages/bundle-standard/dist missing (run `pnpm build` first): full-pipeline fixture cannot run';
      if (process.env.CHAOS_SKIP_BUNDLE === '1') return [...rows, { id: 'f-sqlite-coarse', skip: `LOUD SKIP: ${why}` }, { id: 'f-sqlite-sweep', skip: `LOUD SKIP: ${why}` }];
      return [...rows, row('f-sqlite-coarse', null, '', [why]), row('f-sqlite-sweep', null, '', [why])];
    }
    const full = { BUNDLE_DIST: dist };
    const r2 = await runChild({ argv: [proc('f-sqlite.child.mjs'), db], env: full, timeoutMs: 120000 });
    rows.push(row('f-sqlite-coarse', r2, `via=bundle wall=${r2.wallMs}ms rss=${r2.frames.find((x) => x.t === 'done')?.rssMb}MB`, okDone(r2)));
    const p2 = await runProd({ child: proc('p-sqlite.child.mjs'), args: [db, 'bundle', dist], deadlineMs: 120000 });
    rows.push(row('f-sqlite-coarse-prod', p2.obs, `PRODUCTION supervisor (default coarse cap ${DEFAULT_VMEM_KB / 1024}MB) via=bundle: wall=${p2.obs.wallMs}ms`, leakFails(p2)));

    const caps = (process.env.CHAOS_SWEEP_CAPS ?? '1000,1100,1500,2000,2500,3000,3500,4096,4500,5000,6144,8192').split(',').map(Number);
    const reps = Number(process.env.CHAOS_SWEEP_REPS ?? 3);
    const cells = [];
    for (const cap of caps) {
      const outs = [];
      for (let r = 0; r < reps; r++) {
        const o = await runChild({ argv: [proc('f-sqlite.child.mjs'), db], env: { ...full, REF_VMEM_KB: String(cap * 1024) }, timeoutMs: 120000 });
        const short = o.outcome.replace('signal:SIG', '').replace('code:', 'rc');
        outs.push(short === 'rc0' ? short : `${short}/${markerOf(o)}`);
      }
      cells.push({ cap, outs, pass: outs.every((x) => x === 'rc0') });
    }
    const nonMono = cells.some((x, i) => !x.pass && cells.slice(i + 1).some((y) => y.pass));
    // Coarse-cap evidence: smallest cap from which EVERY larger swept cap passed in ALL reps, then +25% margin.
    const from = cells.find((x, i) => cells.slice(i).every((y) => y.pass))?.cap;
    const recommended = from === undefined ? undefined : cells.find((x) => x.cap >= from * 1.25 && x.pass)?.cap;
    const fails = [];
    if (from === undefined) fails.push('no cap in the sweep passes in all reps (incl. the largest)');
    else if (recommended === undefined) fails.push(`no swept cap gives a 25% margin over ${from}MB`);
    else if (refDefaultMb < recommended) fails.push(`reference default ${refDefaultMb}MB < recommended coarse cap ${recommended}MB`);
    else if (DEFAULT_VMEM_KB / 1024 < recommended) fails.push(`PRODUCTION default coarse cap ${DEFAULT_VMEM_KB / 1024}MB < recommended coarse cap ${recommended}MB`);
    const matrix = cells.map((x) => `${x.cap}:[${x.outs.join(',')}]`).join(' ');
    rows.push(row('f-sqlite-sweep', null,
      `banding(non-monotonic)=${nonMono ? 'YES' : 'no'} reps=${reps}\n     matrix ${matrix}\n     COARSE-CAP EVIDENCE: all-reps-pass from ${from}MB; +25% margin => recommended >= ${recommended}MB; reference default ${refDefaultMb}MB; production default ${DEFAULT_VMEM_KB / 1024}MB` +
      '\n     note: a failure here is a BENIGN 28MB sqlite; unhandled it would surface as MalformedDocument/LimitExceeded for a good file', fails));
    return rows;
  };

  // cgroup v2 preflight shared by g and g1: refuse unless memory.max is a small finite limit (never run the hog unbounded).
  const cgPreflight = () => {
    const memMax = cgroupFile('memory.max');
    const group = cgroupFile('memory.oom.group');
    const fails = [];
    if (memMax === null) fails.push('cgroup v2 memory.max unreadable (cgroup v1 or no cgroupfs): refusing to run');
    else if (memMax === 'max') fails.push('memory.max is unlimited: refusing to run an unbounded memory hog');
    else if (Number(memMax) > 4 * 2 ** 30) fails.push(`memory.max=${memMax} is above 4GiB: refusing`);
    return { memMax, group, fails };
  };
  const runOomParent = async (mode, script = 'g-oom-parent.parent.mjs') => {
    const p = spawn(process.execPath, [proc(script), mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (x) => (out += x));
    p.stderr.on('data', (x) => (out += x));
    const [code, signal] = await new Promise((r) => p.on('close', (cd, sg) => r([cd, sg])));
    return { out, obs: { outcome: signal ? `signal:${signal}` : `code:${code}`, stderr: out, readySeen: true, frames: [], killReason: null } };
  };

  // (g) cgroup OOM with parent (~400MB) larger than child, oom.group=0 (Docker default). Runs only in the --memory=700m container.
  const g = async () => {
    const pre = cgPreflight();
    if (pre.group !== '0') pre.fails.push(`memory.oom.group=${pre.group}: the oom_score_adj mitigation is only meaningful with 0`);
    const rows = [row('g-cgroup-preflight', null, `memory.max=${pre.memMax} memory.oom.group=${pre.group}`, pre.fails)];
    if (pre.fails.length) return rows;
    for (const mode of ['adj', 'noadj']) {
      const { out, obs } = await runOomParent(mode);
      const survived = out.includes('PARENT SURVIVED');
      const fails = [];
      if (mode === 'adj' && !out.includes('child outcome=signal:SIGKILL')) fails.push('with oom_score_adj the child was not the SIGKILLed one');
      await sleep(1000); // let the cgroup drain before the next mode
      rows.push(row(`g-cgroup-oom-${mode}`, obs, `parentSurvived=${survived} :: ${out.trim().split('\n').pop()}`, fails));
    }
    // PRODUCTION supervisor + wrapper: the wrapper itself must set oom_score_adj so the cgroup OOM killer takes the child, not the parent.
    const prod = await runOomParent('adj', 'g-prod.parent.mjs');
    const pfails = [];
    if (!prod.out.includes('PARENT SURVIVED')) pfails.push('production parent did not survive');
    if (!prod.out.includes('child outcome=signal:SIGKILL')) pfails.push('production: the child was not the SIGKILLed one');
    if (!prod.out.includes('error=LimitExceededError')) pfails.push('production classifier did not report LimitExceededError for the OOM-killed child');
    rows.push(row('g-cgroup-oom-prod', prod.obs, `PRODUCTION supervisor :: ${prod.out.trim().split('\n').pop()}`, pfails));
    return rows;
  };

  // (g1) memory.oom.group=1 (Kubernetes >= 1.28 default behaviour): the kernel kills the WHOLE cgroup, parent included.
  // The runner dies with it, so run-docker.sh judges this row from outside (container exit 137 + ARMED + no SURVIVED).
  const g1 = async () => {
    const pre = cgPreflight();
    const fails = [...pre.fails];
    if (!fails.length) {
      try { writeFileSync('/sys/fs/cgroup/memory.oom.group', '1'); } catch (err) { fails.push(`cannot write memory.oom.group (${err.code}): run with --privileged on cgroup v2`); }
      if (!fails.length && cgroupFile('memory.oom.group') !== '1') fails.push('memory.oom.group did not read back as 1');
    }
    if (fails.length) return [row('g-cgroup-oom-group1', null, `memory.max=${pre.memMax}`, fails)];
    writeSync(1, `ARMED memory.max=${pre.memMax} memory.oom.group=${cgroupFile('memory.oom.group')} (oom_score_adj=1000 child; parent must die too)\n`);
    const { out } = await runOomParent('adj');
    return [row('g-cgroup-oom-group1', null, out.trim().split('\n').pop(), [`parent SURVIVED with oom.group=1 (expected the whole cgroup to die): ${out.trim()}`])];
  };

  // (h) parent SIGKILL while child is in a sync loop: the ppid-watcher cannot reap it; L5 bounds it. Once the parent is gone
  // the exit status is unobservable, so WHICH limit fired is decided from CPU TIME (immune to scheduler contention, unlike
  // wall clock): poll /proc/<pid>/stat utime+stime, keep the last value seen before death. ~N => soft limit (SIGXCPU),
  // ~N+2 => hard limit (SIGKILL). Wall-clock bounds only guard against "never dies".
  const h = async () => {
    const one = async (id, cpu, ignoreXcpu, parentScript = 'h-parent.parent.mjs') => {
      const p = spawn(process.execPath, [proc(parentScript)], {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, H_CPU_SECS: String(cpu), ...(ignoreXcpu ? { H_IGNORE_XCPU: '1' } : {}) },
      });
      const childPid = await new Promise((res, rej) => {
        p.stdout.once('data', (x) => res(Number(String(x).trim().split(' ')[1])));
        p.on('exit', () => rej(new Error('parent died before CHILD line')));
      });
      await sleep(200); // let the child actually be inside the loop
      process.kill(p.pid, 'SIGKILL');
      await new Promise((r) => p.on('close', r));
      const l = limits(id);
      const t0 = performance.now();
      let lastCpu = null;
      let aliveAfter1s = null;
      let goneAfterMs = null;
      while (performance.now() - t0 < l.maxGoneMs) {
        const c = cpuSecs(childPid);
        if (c !== null) lastCpu = c;
        if (aliveAfter1s === null && performance.now() - t0 >= 1000) aliveAfter1s = isAlive(childPid); // sync loop + dead parent: ppid watcher cannot fire
        if (!isAlive(childPid)) { goneAfterMs = Math.round(performance.now() - t0); break; }
        await sleep(10);
      }
      if (goneAfterMs === null) try { process.kill(-childPid, 'SIGKILL'); } catch { /* ignore */ }
      const fails = [];
      if (aliveAfter1s === false || (aliveAfter1s === null && goneAfterMs !== null)) fails.push('child was NOT orphaned/alive 1s after parent SIGKILL');
      let which = 'n/a';
      if (goneAfterMs === null) fails.push(`child still alive ${l.maxGoneMs}ms after parent death: L5 did not bound it`);
      else if (lastCpu === null) fails.push('never saw the orphan\'s CPU time');
      else {
        // Midpoint between soft (cpu) and hard (cpu+2) decides the label; the tolerance below covers poll lag only.
        which = lastCpu < cpu + 1 ? 'soft' : 'hard';
        const want = l.death;
        if (which !== want) fails.push(`orphan died at cpu=${lastCpu.toFixed(2)}s which is the ${which} limit; expected the ${want} limit (soft=${cpu}s, hard=${cpu + 2}s)`);
        const lo = want === 'soft' ? cpu - 1 : cpu + 1;
        const hi = want === 'soft' ? cpu + 1 : cpu + 2.5;
        if (lastCpu < lo || lastCpu > hi) fails.push(`last cpu ${lastCpu.toFixed(2)}s outside [${lo}, ${hi}]s expected for the ${want} limit`);
      }
      return row(id, null, `aliveAfter1s=${aliveAfter1s} goneAfter=${goneAfterMs}ms lastCpu=${lastCpu === null ? 'n/a' : lastCpu.toFixed(2)}s inferredDeath=${which === 'soft' ? 'soft-limit SIGXCPU' : which === 'hard' ? 'hard-limit SIGKILL' : 'n/a'} (RLIMIT_CPU soft=${cpu}s hard=${cpu + 2}s, childIgnoresSIGXCPU=${Boolean(ignoreXcpu)})`, fails);
    };
    return [
      await one('h-orphan-hung', 3, false), await one('h-orphan-hung-hard', 2, true),
      // The same two scenarios with the child launched by the PRODUCTION supervisor/wrapper.
      await one('h-orphan-hung-prod', 3, false, 'h-prod.parent.mjs'), await one('h-orphan-hung-hard-prod', 2, true, 'h-prod.parent.mjs'),
    ];
  };

  // (i) giant single fd-3 frame: naive reader amplification vs per-frame-cap reader.
  const i = async () => {
    const rows = [];
    let maxLag = 0;
    let last = performance.now();
    const lag = setInterval(() => { const t = performance.now(); maxLag = Math.max(maxLag, t - last - 5); last = t; }, 5);
    let parseMs = 0;
    let heapDelta = 0;
    let rssDelta = 0;
    const base = process.memoryUsage();
    let keep;
    const naive = await runChild({
      argv: [proc('i-giant-frame.child.mjs')], timeoutMs: 120000,
      parse: (s) => {
        if (s.length < 1024) return JSON.parse(s);
        const t = performance.now();
        keep = JSON.parse(s);
        parseMs = performance.now() - t;
        const m = process.memoryUsage();
        heapDelta = m.heapUsed - base.heapUsed;
        rssDelta = m.rss - base.rss;
        return { t: 'big-parsed', n: keep.length };
      },
    });
    clearInterval(lag);
    const frameMb = 64;
    const amp = heapDelta / (frameMb * 1048576);
    const min = limits('i-giant-frame-naive').minAmplification ?? 2;
    const f1 = [];
    if (keep?.length !== 2 ** 25 - 1) f1.push(`naive parse produced ${keep?.length} elements`);
    if (amp < min) f1.push(`heap amplification ${amp.toFixed(2)}x < ${min}x`);
    rows.push(row('i-giant-frame-naive', naive,
      `frame=${frameMb}MiB parseBlock=${Math.round(parseMs)}ms maxLoopLag=${Math.round(maxLag)}ms heapDelta=+${bytesMb(heapDelta)}MB rssDelta=+${bytesMb(rssDelta)}MB amplification=${amp.toFixed(1)}x`, f1));
    keep = undefined;

    const CAP = 1 << 20;
    const capped = await runChild({ argv: [proc('i-giant-frame.child.mjs')], timeoutMs: 30000, frameCap: CAP });
    const f2 = [];
    if (capped.parseCalls > 2) f2.push(`parse called ${capped.parseCalls}x (giant frame reached JSON.parse?)`);
    if (capped.fd3Bytes > CAP + (1 << 20)) f2.push(`read ${capped.fd3Bytes} bytes before kill (cap ${CAP})`);
    if (capped.frames.some((x) => x.t === 'big' || x.t === 'done')) f2.push('reader went past the oversized frame');
    rows.push(row('i-giant-frame-capped', capped, `cap=${CAP} bytesRead=${capped.fd3Bytes} parseCalls=${capped.parseCalls} wall=${capped.wallMs}ms`, f2));

    // PRODUCTION FrameReader (default 1 MiB per-frame cap): the 64 MiB line must be cut off before JSON.parse ever sees it.
    const prod = await runProd({ child: proc('p-giant-frame.child.mjs'), deadlineMs: 30000 });
    const f3 = [...leakFails(prod)];
    if (prod.obs.fd3Bytes > CAP + (1 << 20)) f3.push(`read ${prod.obs.fd3Bytes} bytes before kill (cap ${CAP})`);
    rows.push(row('i-giant-frame-capped-prod', prod.obs, `PRODUCTION supervisor: cap=${CAP} bytesRead=${prod.obs.fd3Bytes} wall=${prod.obs.wallMs}ms`, f3));
    return rows;
  };

  // (j) terminal 'done' frame, then linger: kill-after-grace of the process GROUP.
  const j = async () => {
    const GRACE = 200;
    const run = (group) => {
      let gcPid;
      return runChild({
        argv: [proc('j-done-linger.child.mjs')], timeoutMs: 15000,
        onFrame: (v, ctl) => {
          if (v.t === 'gc') gcPid = v.pid;
          if (v.t === 'done') setTimeout(() => {
            if (group) ctl.kill('grace');
            else try { process.kill(ctl.pid, 'SIGKILL'); } catch { /* gone */ }
          }, GRACE);
        },
      }).then(async (obs) => {
        await sleep(300);
        return { obs, gcAlive: gcPid !== undefined && isAlive(gcPid), gcPid };
      });
    };
    const g1 = await run(true);
    const f1 = [];
    if (g1.obs.doneMs === null) f1.push('done frame not seen');
    if (g1.gcAlive) f1.push('grandchild survived the group kill');
    if (g1.obs.killReason !== 'grace') f1.push(`killReason ${g1.obs.killReason}`);
    const lat = g1.obs.exitMs - g1.obs.doneMs;
    if (lat > GRACE + 1000) f1.push(`exit ${lat}ms after done (grace ${GRACE}ms)`);
    const rows = [row('j-done-linger-group', g1.obs, `classified=${phaseOf(g1.obs)} killLatency=${lat}ms grandchildAlive=${g1.gcAlive}`, f1)];
    // Negative control: killing only the leader leaves the grandchild behind (why the group kill is required).
    const g2 = await run(false);
    const f2 = g2.gcAlive ? [] : ['control: expected grandchild to survive a leader-only kill'];
    if (g2.gcAlive) try { process.kill(g2.gcPid, 'SIGKILL'); } catch { /* gone */ }
    rows.push(row('j-leader-only-control', g2.obs, `grandchildAliveAfterLeaderKill=${g2.gcAlive}`, f2));

    // PRODUCTION: terminal frame, then the supervisor's own grace kill of the whole group.
    const prod = await runProd({ child: proc('p-done-linger.child.mjs'), graceMs: GRACE, deadlineMs: 15000 });
    const f3 = [...leakFails(prod)];
    const gc = Number(prod.result?.kind === 'text' ? prod.result.text : NaN);
    if (!prod.result) f3.push(`run did not succeed: ${prod.error}`);
    if (!Number.isInteger(gc)) f3.push('grandchild pid not reported');
    else {
      for (let waited = 0; isAlive(gc) && waited < 3000; waited += 20) await sleep(20);
      if (isAlive(gc)) { f3.push('grandchild survived the production group kill'); try { process.kill(gc, 'SIGKILL'); } catch { /* gone */ } }
    }
    if (prod.diag && !prod.diag.graceKilled) f3.push('supervisor did not report a grace kill');
    const plat = (prod.diag?.exitMs ?? Infinity) - (prod.diag?.terminalMs ?? 0);
    if (!(plat <= GRACE + 1000)) f3.push(`exit ${plat}ms after done (grace ${GRACE}ms)`);
    rows.push(row('j-done-linger-group-prod', prod.obs, `PRODUCTION supervisor: killLatency=${plat}ms`, f3));
    return rows;
  };

  // (k) no /bin/sh (probe-style failure) vs other startup failures vs mid-run crash.
  const k = async () => {
    const rows = [];
    const noShell = await runChild({ shell: '/nonexistent/bin/sh', argv: [proc('k-trivial.child.mjs')], timeoutMs: 10000 });
    rows.push(row('k-no-shell', noShell, `pid=${noShell.pid} syscall=${noShell.spawnError?.syscall} phase=${phaseOf(noShell)}`,
      noShell.pid === undefined && phaseOf(noShell) === 'unavailable' ? [] : ['expected no pid and phase=unavailable']));
    const noNode = await runChild({ script: 'exec /nonexistent/node "$@"', argv: ['x'], timeoutMs: 10000 });
    rows.push(row('k-no-node', noNode, `phase=${phaseOf(noNode)}`,
      phaseOf(noNode) === 'unavailable' ? [] : ['expected phase=unavailable']));
    const ulim = await runChild({ script: 'ulimit -S -t bogus || exit 126; exec node "$@"', argv: ['-e', '0'], timeoutMs: 10000 });
    rows.push(row('k-ulimit-fails', ulim, `phase=${phaseOf(ulim)}`, phaseOf(ulim) === 'unavailable' ? [] : ['expected phase=unavailable']));
    const mid = await runChild({ argv: [proc('b-heap-oom.child.mjs')], env: { REF_HEAP_MB: '64' }, timeoutMs: 30000 });
    rows.push(row('k-midrun-crash', mid, `phase=${phaseOf(mid)}`, phaseOf(mid) === 'crash' ? [] : ['expected phase=crash']));

    // The same four through the PRODUCTION supervisor and classifier.
    const pShell = await runProd({
      child: proc('p-trivial.child.mjs'), deadlineMs: 10000,
      spawnFn: (_file, args, options) => spawn('/nonexistent/bin/sh', args, options),
    });
    rows.push(row('k-no-shell-prod', pShell.obs, `PRODUCTION supervisor: pid=${pShell.obs.pid} error=${pShell.obs.error}`,
      pShell.obs.pid === undefined ? [] : ['expected no pid']));
    const pNode = await runProd({ child: proc('p-trivial.child.mjs'), nodePath: '/nonexistent/node', deadlineMs: 10000 });
    rows.push(row('k-no-node-prod', pNode.obs, `PRODUCTION supervisor: error=${pNode.obs.error}`, leakFails(pNode)));
    const pUlimit = await ulimitRefusedProd();
    rows.push(row('k-ulimit-fails-prod', pUlimit.obs, `PRODUCTION wrapper under a lowered hard limit: error=${pUlimit.obs.error}`, pUlimit.fails));
    const pMid = await runProd({ child: proc('b-heap-oom.child.mjs'), heapMb: 64, deadlineMs: 30000 });
    rows.push(row('k-midrun-crash-prod', pMid.obs, `PRODUCTION supervisor: error=${pMid.obs.error}`, leakFails(pMid)));
    return rows;
  };

  // (l) RLIMIT_CPU semantics and ulimit failure handling, through this image's /bin/sh.
  const l = async () => {
    const impl = (() => { try { return execFileSync('readlink', ['-f', '/bin/sh'], { encoding: 'utf8' }).trim(); } catch { return '/bin/sh'; } })();
    const sh = async (id, script, timeoutMs = 20000) => {
      const obs = await runChild({ script, timeoutMs });
      const m = /rc=(\d+)/.exec(obs.stdout);
      obs.outcome = m ? `rc:${m[1]}` : obs.outcome;
      return row(id, obs, `shell=${impl} wall=${obs.wallMs}ms`);
    };
    const busy = 'node -e "for(;;);"';
    return [
      await sh('l-soft-hard-split', `ulimit -S -t 1; ulimit -H -t 3; ${busy}; echo rc=$?`),
      await sh('l-hard-only', `ulimit -t 1; ${busy}; echo rc=$?`),
      await sh('l-io-sleep', 'ulimit -S -t 1; ulimit -H -t 3; node -e "setTimeout(()=>{},2500)"; echo rc=$?'),
      await sh('l-ulimit-bogus-arg', 'ulimit -S -t bogus; echo rc=$?'),
      await sh('l-ulimit-hard-below-soft', 'ulimit -S -t 5; ulimit -H -t 3; echo rc=$?'),
      await sh('l-ulimit-step-exits-126', 'ulimit -S -t 5; ulimit -H -t 3 || exit 126; echo rc=reached'),
      row('l-reference-xcpu', await runChild({ argv: ['-e', 'for(;;);'], env: { REF_CPU_SECS: '1' }, timeoutMs: 20000 }), `via reference.sh REF_CPU_SECS=1`),
      // PRODUCTION wrapper: the parent sees signal:SIGXCPU (not rc152) and the classifier calls it a CPU limit.
      await (async () => {
        const prod = await runProd({ child: proc('a-sync-hang.child.mjs'), cpuSecs: 1, deadlineMs: 20000 });
        return row('l-production-xcpu', prod.obs, 'via the PRODUCTION wrapper cpuSecs=1', leakFails(prod));
      })(),
    ];
  };

  // (n) close-vs-exit: a grandchild inheriting stdout/stderr/fd3 delays 'close' after the child has exited.
  const n = async () => {
    const GRACE = 200;
    const run = (grace) => runChild({
      argv: [proc('n-linger-fds.child.mjs')], timeoutMs: 2500,
      onFrame: (v, ctl) => { if (v.t === 'done' && grace) setTimeout(() => ctl.kill('grace'), GRACE); },
    });
    const g1 = await run(true);
    const f1 = [];
    if (g1.doneMs === null) f1.push('done frame not seen');
    if (g1.exitMs === null || g1.exitMs > 1500) f1.push(`child exit took ${g1.exitMs}ms`);
    if (g1.wallMs > g1.doneMs + GRACE + 1000) f1.push(`reader finished ${g1.wallMs - g1.doneMs}ms after done (grace ${GRACE}ms)`);
    const rows = [row('n-close-vs-exit-grace', g1, `exit@${g1.exitMs}ms done@${g1.doneMs}ms close@${g1.wallMs}ms classified=${phaseOf(g1)}`, f1)];
    // Control: wait on 'close' alone -> only the safety timer ends it. Classification must not depend on this.
    const g2 = await run(false);
    const delay = g2.wallMs - g2.exitMs;
    const f2 = delay >= 1500 ? [] : [`control: close came only ${delay}ms after exit; expected it to be held open by the grandchild`];
    rows.push(row('n-close-vs-exit-control', g2, `exit@${g2.exitMs}ms close@${g2.wallMs}ms (close lagged exit by ${delay}ms; ended by killReason=${g2.killReason})`, f2));

    // PRODUCTION: settles on the terminal frame + leader exit, never on 'close'; the grandchild holding the fds is swept.
    const prod = await runProd({ child: proc('p-linger-fds.child.mjs'), graceMs: GRACE, deadlineMs: 20000 });
    const f3 = [...leakFails(prod)];
    if (!prod.result) f3.push(`run did not succeed: ${prod.error}`);
    if ((prod.obs.wallMs ?? Infinity) > 1500) f3.push(`production run settled after ${prod.obs.wallMs}ms (waited on close?)`);
    const gc = Number(prod.result?.kind === 'text' ? prod.result.text : NaN);
    if (Number.isInteger(gc)) {
      for (let waited = 0; isAlive(gc) && waited < 3000; waited += 20) await sleep(20);
      if (isAlive(gc)) { f3.push('grandchild holding the stdio fds survived'); try { process.kill(gc, 'SIGKILL'); } catch { /* gone */ } }
    } else f3.push('grandchild pid not reported');
    rows.push(row('n-close-vs-exit-grace-prod', prod.obs, `PRODUCTION supervisor: exit@${prod.obs.exitMs}ms settled@${prod.obs.wallMs}ms`, f3));
    return rows;
  };

  // (w) reference.sh ITSELF: fails closed, applies soft N / hard N+2, hard limit is a real SIGKILL backstop.
  const w = async () => {
    const rows = [];
    const trivial = proc('k-trivial.child.mjs');
    const w1 = await runChild({ argv: [trivial], env: { REF_CPU_SECS: 'bogus' }, timeoutMs: 10000 });
    rows.push(row('w1-fail-closed-cpu', w1, `node-ever-ran=${w1.readySeen}`));
    const w2 = await runChild({ argv: [trivial], env: { REF_VMEM_KB: 'bogus' }, timeoutMs: 10000 });
    rows.push(row('w2-fail-closed-vmem', w2, `node-ever-ran=${w2.readySeen}`));

    // Numeric validation: 'unlimited' is accepted by `ulimit` itself and would run node uncapped; 20-digit values etc. too.
    const w5 = await runChild({ argv: [trivial], env: { REF_CPU_SECS: 'unlimited' }, timeoutMs: 10000 });
    rows.push(row('w5-fail-closed-cpu-unlimited', w5, `node-ever-ran=${w5.readySeen}`));
    const w6 = await runChild({ argv: [trivial], env: { REF_VMEM_KB: 'unlimited' }, timeoutMs: 10000 });
    rows.push(row('w6-fail-closed-vmem-unlimited', w6, `node-ever-ran=${w6.readySeen}`));
    const w8 = await runChild({ argv: [trivial], env: { REF_VMEM_KB: '99999999999999999999' }, timeoutMs: 10000 });
    rows.push(row('w8-fail-closed-vmem-20-digits', w8, `node-ever-ran=${w8.readySeen}`));
    // Valid numbers that `ulimit` itself refuses (cannot raise an inherited hard limit): the `|| exit 126` path.
    const w7 = await runChild({ argv: [trivial], script: `ulimit -v 2000000 || exit 99\n${REF_SCRIPT}`, timeoutMs: 10000 });
    rows.push(row('w7-fail-closed-ulimit-refused', w7, `node-ever-ran=${w7.readySeen}`));

    const N = 7;
    const VM = 3145728;
    const w3 = await runChild({ argv: [proc('w-limits.child.mjs')], env: { REF_CPU_SECS: String(N), REF_VMEM_KB: String(VM) }, timeoutMs: 15000 });
    const lim = w3.frames.find((x) => x.t === 'limits');
    const f3 = [];
    if (!lim) f3.push('no limits frame');
    else {
      if (lim.cpu.soft !== String(N) || lim.cpu.hard !== String(N + 2)) f3.push(`cpu soft/hard ${lim.cpu.soft}/${lim.cpu.hard} != ${N}/${N + 2}`);
      if (lim.as.soft !== String(VM * 1024) || lim.as.hard !== String(VM * 1024)) f3.push(`address space ${lim.as.soft}/${lim.as.hard} != ${VM * 1024}`);
      if (lim.oomAdj !== '1000') f3.push(`oom_score_adj=${lim.oomAdj} != 1000`);
      if (lim.arenaMax !== '1') f3.push(`MALLOC_ARENA_MAX=${lim.arenaMax} != 1`);
    }
    rows.push(row('w3-limits-visible', w3, lim ? `cpu=${lim.cpu.soft}/${lim.cpu.hard}s as=${lim.as.soft}/${lim.as.hard}B oom_score_adj=${lim.oomAdj} arena=${lim.arenaMax}` : '', f3));

    const w4 = await runChild({ argv: [proc('w-ignore-xcpu.child.mjs')], env: { REF_CPU_SECS: '1' }, timeoutMs: 20000 });
    const f4 = w4.wallMs >= (limits('w4-hard-backstop').minWallMs ?? 2500) ? [] : [`died after ${w4.wallMs}ms: the soft limit (1s) must have been survived`];
    rows.push(row('w4-hard-backstop', w4, `soft=1s hard=3s wall=${w4.wallMs}ms`, f4));

    // ---- the PRODUCTION wrapper (src/wrapper.ts) -------------------------------------------------------------------------------
    // Fail-closed numeric validation happens in JS before anything is spawned (the shell `num()` guard of reference.sh is gone).
    const rej = async (id, o, note) => {
      const r = await runProd({ child: proc('p-trivial.child.mjs'), deadlineMs: 10000, ...o });
      return row(id, r.obs, `PRODUCTION: ${note} -> ${r.obs.outcome} (${r.error?.message ?? 'no error'})`, r.obs.pid === undefined ? [] : ['a child was spawned despite the invalid value']);
    };
    rows.push(await rej('w1-fail-closed-cpu-prod', { cpuSecs: 'bogus' }, 'cpuSecs=bogus'));
    rows.push(await rej('w2-fail-closed-vmem-prod', { vmemKb: 'bogus' }, 'vmemKb=bogus'));
    rows.push(await rej('w5-fail-closed-cpu-unlimited-prod', { cpuSecs: 'unlimited' }, 'cpuSecs=unlimited'));
    rows.push(await rej('w6-fail-closed-vmem-unlimited-prod', { vmemKb: 'unlimited' }, 'vmemKb=unlimited'));
    rows.push(await rej('w8-fail-closed-vmem-20-digits-prod', { vmemKb: Number('99999999999999999999') }, 'vmemKb=20 digits'));
    const w7p = await ulimitRefusedProd();
    rows.push(row('w7-fail-closed-ulimit-refused-prod', w7p.obs, `PRODUCTION wrapper: error=${w7p.obs.error}`, w7p.fails));

    const NP = 7;
    const VMP = 4194304; // production floor (4 GiB): the P0 3 GiB value is below it
    const w3p = await runProd({ child: proc('p-limits.child.mjs'), cpuSecs: NP, vmemKb: VMP, deadlineMs: 15000 });
    const mp = w3p.result?.kind === 'text' ? w3p.result.metadata : null;
    const f3p = [...leakFails(w3p)];
    if (!mp) f3p.push(`no limits meta frame: ${w3p.error}`);
    else {
      if (mp.cpuSoft?.[0] !== String(NP) || mp.cpuHard?.[0] !== String(NP + 2)) f3p.push(`cpu soft/hard ${mp.cpuSoft}/${mp.cpuHard} != ${NP}/${NP + 2}`);
      if (mp.asSoft?.[0] !== String(VMP * 1024) || mp.asHard?.[0] !== String(VMP * 1024)) f3p.push(`address space ${mp.asSoft}/${mp.asHard} != ${VMP * 1024}`);
      if (mp.oomAdj?.[0] !== '1000') f3p.push(`oom_score_adj=${mp.oomAdj} != 1000`);
      if (mp.arenaMax?.[0] !== '1') f3p.push(`MALLOC_ARENA_MAX=${mp.arenaMax} != 1`);
    }
    rows.push(row('w3-limits-visible-prod', w3p.obs, mp ? `PRODUCTION: cpu=${mp.cpuSoft}/${mp.cpuHard}s as=${mp.asSoft}/${mp.asHard}B oom_score_adj=${mp.oomAdj} arena=${mp.arenaMax}` : '', f3p));

    const w4p = await runProd({ child: proc('w-ignore-xcpu.child.mjs'), cpuSecs: 1, deadlineMs: 20000 });
    const f4p = [...leakFails(w4p)];
    if (w4p.obs.wallMs < (limits('w4-hard-backstop-prod').minWallMs ?? 2500)) f4p.push(`died after ${w4p.obs.wallMs}ms: the soft limit (1s) must have been survived`);
    rows.push(row('w4-hard-backstop-prod', w4p.obs, `PRODUCTION: soft=1s hard=3s wall=${w4p.obs.wallMs}ms`, f4p));
    return rows;
  };

  // (m) issue_cmap12: needs the pdf corpus fixture, tracked in P6.
  const m = async () => [{ id: 'm-issue-cmap12', skip: 'needs pdf fixture (2KB pdf, 282MB heap); tracked in tikajs-zgg2.8 (P6)' }];

  return [
    { id: 'a', run: a }, { id: 'b', run: b }, { id: 'c', run: c }, { id: 'd', run: d }, { id: 'e', run: e },
    { id: 'f', run: f }, { id: 'g', mode: 'cgroup', run: g }, { id: 'g1', mode: 'group1', run: g1 }, { id: 'h', run: h },
    { id: 'i', run: i }, { id: 'j', run: j }, { id: 'k', run: k }, { id: 'l', run: l }, { id: 'n', run: n }, { id: 'w', run: w },
    { id: 'm', run: m },
  ];
}
