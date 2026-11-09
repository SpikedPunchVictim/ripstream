// Production-path adapter for the chaos fixtures: runs a child through the REAL supervisor (src/supervisor.ts, which
// builds the real wrapper command and uses the real frame reader / classifier) and reports an observation shaped like
// lib.mjs `runChild`'s, so the same expected.json table and checkObs apply to both the P0 stand-ins and production.
// Node strips the types of the .ts imports; nothing here is built.
import { DEFAULT_VMEM_KB } from '../../src/wrapper.ts';
import { runChild as supervise } from '../../src/supervisor.ts';
import { IsolationError } from '@spikedpunch/ripstream-core';
import { sleep } from './lib.mjs';

export { DEFAULT_VMEM_KB };

/** "LimitExceededError" | "IsolationError:unavailable" | ... | null for success. */
export function errorLabel(error) {
  if (error === undefined || error === null) return null;
  if (error instanceof IsolationError) return `IsolationError:${error.reason}`;
  return error?.constructor?.name ?? String(error);
}

/** Is any process still in the group led by pgid? (kill(-pgid, 0) succeeds while a member, even a zombie, exists.) */
export function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (err) { return err.code !== 'ESRCH'; }
}

export async function waitGroupGone(pgid, ms = 3000) {
  const end = performance.now() + ms;
  while (groupAlive(pgid)) {
    if (performance.now() > end) return false;
    await sleep(20);
  }
  return true;
}

/**
 * o: { child, args = [], input = Uint8Array, output, cpuSecs = 60, heapMb = 256, vmemKb, rssLimitMb, pollMs, deadlineMs = 30000,
 *      maxFrameBytes, maxResultBytes = 1 MiB, graceMs, readyTimeoutMs, nodePath, spawnFn, signal, request }
 * Resolves (never rejects) with { obs, error, result, diag, groupGone }.
 * obs: outcome, stderr, readySeen, killReason (production names: timeout|abort|rss|result_cap|frame_cap|protocol|grace|ready-timeout),
 *      error (label), wallMs, plus rss poll stats (maxStepMb, maxStepDtMs, medianDtMs, rssAtKillMb, peakRssMb, samples).
 */
export async function runProd(o) {
  let diag;
  let result;
  let error;
  try {
    result = await supervise({
      scriptPath: o.child,
      scriptArgs: o.args ?? [],
      cpuSecs: o.cpuSecs ?? 60,
      heapMb: o.heapMb ?? 256,
      ...(o.vmemKb === undefined ? {} : { vmemKb: o.vmemKb }),
      ...(o.rssLimitMb === undefined ? {} : { rssLimitMb: o.rssLimitMb, pollMs: o.pollMs ?? 20 }),
      ...(o.maxFrameBytes === undefined ? {} : { maxFrameBytes: o.maxFrameBytes }),
      ...(o.graceMs === undefined ? {} : { graceMs: o.graceMs }),
      ...(o.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: o.readyTimeoutMs }),
      ...(o.nodePath === undefined ? {} : { nodePath: o.nodePath }),
      ...(o.spawnFn === undefined ? {} : { spawnFn: o.spawnFn }),
      ...(o.signal === undefined ? {} : { signal: o.signal }),
      request: o.request ?? { input: o.input ?? new Uint8Array(0), output: o.output ?? 'text' },
      deadlineMs: o.deadlineMs ?? 30000,
      maxResultBytes: o.maxResultBytes ?? 16 * 1024 * 1024,
      onSettled: (d) => { diag = d; },
    });
  } catch (err) {
    error = err;
  }
  const label = errorLabel(error);
  const killReason = diag === undefined ? null
    : diag.killReason ?? (diag.graceKilled ? 'grace' : diag.readyTimedOut ? 'ready-timeout' : null);
  const obs = {
    pid: diag?.pid,
    outcome: diag === undefined ? 'rejected-before-spawn' : diag.outcome,
    stderr: diag?.stderrTail ?? '',
    stdout: '',
    readySeen: diag?.readyMs != null,
    killReason,
    error: label,
    wallMs: diag?.settledMs ?? 0,
    frames: [],
    doneMs: diag?.terminalMs ?? null,
    exitMs: diag?.exitMs ?? null,
    fd3Bytes: diag?.fd3Bytes ?? 0,
    parseCalls: 0,
    maxStepMb: diag?.rss?.maxStepMb ?? 0,
    maxStepDtMs: Math.round(diag?.rss?.maxStepDtMs ?? 0),
    medianDtMs: Math.round(diag?.rss?.medianIntervalMs ?? 0),
    rssAtKillMb: diag?.rss?.rssAtLimitMb ?? null,
    peakRssMb: diag?.rss?.peakMb ?? 0,
    samples: diag?.rss?.samples ?? 0,
  };
  // No leaked process: the whole group must be gone once the run has settled (poll briefly: SIGKILL delivery is async).
  const groupGone = diag?.pid === undefined ? true : await waitGroupGone(diag.pid);
  return { obs, error, result, diag, groupGone };
}

/** Failure strings for a production observation: the shared table check is done by the runner; this adds the leak check. */
export const leakFails = (r) => (r.groupGone ? [] : [`process group ${r.diag?.pid} still has live members after the run settled`]);
