// Shared helpers for the chaos fixtures. Plain ESM, no dependencies, not part of any package build.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = process.env.CHAOS_REPO_ROOT ?? path.resolve(HERE, '../../../..');
export const REF_SCRIPT = readFileSync(path.join(HERE, 'reference.sh'), 'utf8');
export const EMULATED = process.env.CHAOS_EMULATED === '1';
export const proc = (name) => path.join(HERE, 'procs', name);

/** "glibc-arm64" | "glibc-amd64" | "musl-arm64" | "musl-amd64" */
export function platformKey() {
  const glibc = Boolean(process.report?.getReport().header.glibcVersionRuntime);
  return `${glibc ? 'glibc' : 'musl'}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Page size for /proc/<pid>/statm: getconf, else the kernel's smaps report, else 4096. */
function pageSize() {
  try { return Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim()) || 4096; } catch { /* no getconf */ }
  try { return Number(/KernelPageSize:\s+(\d+) kB/.exec(readFileSync('/proc/self/smaps', 'utf8'))[1]) * 1024; } catch { /* no smaps */ }
  return 4096;
}
export const PAGE = pageSize();

/** Read a cgroup v2 control file (null if absent). */
export function cgroupFile(name) {
  try { return readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim(); } catch { return null; }
}

export function readRssMb(pid) {
  try {
    return (Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * PAGE) / 1048576;
  } catch {
    return null;
  }
}

/** Process state letter from /proc/<pid>/stat, or null if gone. 'Z' = zombie (dead, unreaped). */
export function procState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
  } catch {
    return null;
  }
}
export const isAlive = (pid) => {
  const s = procState(pid);
  return s !== null && s !== 'Z' && s !== 'X';
};

/**
 * Spawn a child the way the design's isolator will: `/bin/sh -c <script> reference.sh <argv...>`,
 * detached (own process group), stdio [ignore, pipe, pipe(8KiB ring), pipe fd3 = NDJSON frames].
 * Resolves on 'close' (stdio drained) with an observation record. Never rejects.
 *
 * Options: argv, env, shell, script, timeoutMs (parent timer -> SIGKILL pgroup, killReason 'timer'),
 * rssLimitMb + pollMs (statm poller -> 'rss'), frameCap (bytes; reader kills BEFORE parse -> 'frame-cap'),
 * parse (line -> value; default JSON.parse), onFrame(frame, ctl), onReady(pid), graceMs-style logic lives in onFrame.
 */
export function runChild(o) {
  const {
    argv = [], env = {}, shell = '/bin/sh', script = REF_SCRIPT, timeoutMs = 30000,
    rssLimitMb, pollMs = 20, frameCap = Infinity, parse = JSON.parse, onFrame, onReady,
  } = o;
  return new Promise((resolve) => {
    const t0 = performance.now();
    const now = () => Math.round(performance.now() - t0);
    const obs = {
      pid: undefined, spawnError: null, code: null, signal: null, outcome: '',
      stderr: '', stdout: '', frames: [], readySeen: false, readyMs: null, doneMs: null,
      killReason: null, killMs: null, exitMs: null, peakRssMb: 0, rssAtKillMb: null, maxStepMb: 0, maxStepDtMs: 0, medianDtMs: 0, samples: 0,
      parseCalls: 0, fd3Bytes: 0, wallMs: 0,
    };
    let settled = false;
    const child = spawn(shell, ['-c', script, 'reference.sh', ...argv], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    obs.pid = child.pid;
    const ctl = {
      pid: child.pid,
      now,
      kill(reason) {
        if (!obs.killReason) { obs.killReason = reason; obs.killMs = now(); }
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      },
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      obs.wallMs = now();
      obs.outcome = obs.spawnError ? `spawn:${obs.spawnError.code}` : obs.signal ? `signal:${obs.signal}` : `code:${obs.code}`;
      resolve(obs);
    };

    const timer = setTimeout(() => ctl.kill('timer'), timeoutMs);
    let lastRss = 0;
    let lastT = performance.now();
    const dts = []; // real inter-sample deltas of the poller (what was MEASURED, not what was configured)
    const poller = rssLimitMb === undefined ? undefined : setInterval(() => {
      const rss = readRssMb(child.pid);
      if (rss === null) return;
      const t = performance.now();
      dts.push(t - lastT);
      obs.samples = dts.length;
      obs.medianDtMs = Math.round([...dts].sort((x, y) => x - y)[Math.floor(dts.length / 2)]);
      if (rss - lastRss > obs.maxStepMb) { obs.maxStepMb = rss - lastRss; obs.maxStepDtMs = Math.round(t - lastT); }
      lastRss = rss;
      lastT = t;
      obs.peakRssMb = Math.max(obs.peakRssMb, rss);
      if (rss > rssLimitMb && !obs.killReason) { obs.rssAtKillMb = rss; ctl.kill('rss'); }
    }, pollMs);

    // fd3: NDJSON with a per-frame size cap enforced BEFORE parsing.
    let pending = [];
    let pendingLen = 0;
    let stopped = false;
    const handleLine = (buf) => {
      let v;
      try { obs.parseCalls++; v = parse(buf.toString('utf8')); } catch (e) { v = { t: 'bad', err: String(e) }; }
      if (buf.length < 1024) obs.frames.push(v);
      else obs.frames.push({ t: 'big', bytes: buf.length });
      if (v && v.t === 'ready' && !obs.readySeen) { obs.readySeen = true; obs.readyMs = now(); onReady?.(child.pid); }
      if (v && v.t === 'done' && obs.doneMs === null) obs.doneMs = now();
      onFrame?.(v, ctl);
    };
    child.stdio[3].on('data', (chunk) => {
      if (stopped) return;
      obs.fd3Bytes += chunk.length;
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start);
        const end = nl < 0 ? chunk.length : nl;
        pending.push(chunk.subarray(start, end));
        pendingLen += end - start;
        if (pendingLen > frameCap) { stopped = true; pending = []; ctl.kill('frame-cap'); return; }
        if (nl < 0) return;
        const line = Buffer.concat(pending);
        pending = []; pendingLen = 0; start = nl + 1;
        if (line.length) handleLine(line);
      }
    });
    child.stdout.on('data', (d) => { if (obs.stdout.length < 65536) obs.stdout += d; });
    child.stderr.on('data', (d) => { obs.stderr = (obs.stderr + d).slice(-8192); });
    child.on('error', (e) => { obs.spawnError = { code: e.code, syscall: e.syscall }; finish(); });
    child.on('exit', (code, signal) => { obs.code = code; obs.signal = signal; obs.exitMs = now(); });
    child.on('close', finish);
  });
}

/** 'unavailable' = never reached ready (init-probe failure); 'crash' = died after ready. */
export function phaseOf(obs) {
  if (obs.spawnError || !obs.readySeen) return 'unavailable';
  return obs.doneMs !== null ? 'done' : 'crash';
}

/** Merge the platform variant over the default expectation. */
export function expectationFor(table, id, key) {
  const base = table[id.replace(/#\d+$/, '')];
  if (!base) return null;
  return { ...base, ...(base.variants?.[key] ?? {}) };
}

/** Apply a table entry to an observation. Returns a list of failure strings. */
export function checkObs(e, obs) {
  const fails = [];
  if (e.allow && !e.allow.includes(obs.outcome)) fails.push(`outcome ${obs.outcome} not in allowed [${e.allow.join(', ')}]`);
  if (e.forbid?.includes(obs.outcome)) fails.push(`forbidden outcome ${obs.outcome}`);
  const err = obs.stderr;
  if (e.stderrAny?.length && !e.stderrAny.some((m) => err.includes(m))) fails.push(`stderr lacks any of [${e.stderrAny.join(' | ')}]`);
  if (e.stderrNone?.some((m) => err.includes(m))) fails.push(`stderr contains forbidden marker`);
  if (e.ready === true && !obs.readySeen) fails.push('ready frame NOT seen before death (would be misread as startup failure)');
  if (e.ready === false && obs.readySeen) fails.push('ready frame seen but expected startup-phase death');
  if ('killedBy' in e && (obs.killReason ?? null) !== e.killedBy) fails.push(`killReason ${obs.killReason} != ${e.killedBy}`);
  return fails;
}

export const lastLine = (s) => s.trim().split('\n').pop() ?? '';

/** Clock ticks per second (for /proc/<pid>/stat utime/stime). */
export const CLK_TCK = (() => {
  try { return Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100; } catch { return 100; }
})();

/** CPU seconds (utime+stime, all threads) consumed so far by pid, from /proc/<pid>/stat; null if the pid is gone. Readable for zombies. */
export function cpuSecs(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // f[0] = state (field 3)
    return (Number(f[11]) + Number(f[12])) / CLK_TCK; // utime = field 14, stime = field 15
  } catch {
    return null;
  }
}
