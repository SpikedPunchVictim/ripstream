import { fileURLToPath } from "node:url";
import type { RunChildOptions, RunDiagnostics } from "../../src/supervisor.ts";

export const CHILD = fileURLToPath(new URL("./child.ts", import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Options for a supervised run of fixtures/child.ts in `mode`, with generous defaults. */
export function runOptions(
  mode: string,
  overrides: Partial<RunChildOptions> = {},
  input: Uint8Array | { path: string } = new TextEncoder().encode("hello"),
): RunChildOptions {
  return {
    scriptPath: CHILD,
    scriptArgs: [mode],
    cpuSecs: 30,
    heapMb: 128,
    request: { input },
    deadlineMs: 10_000,
    maxResultBytes: 1024 * 1024,
    ...overrides,
  };
}

/** Collects the diagnostics the run reports just before it settles. */
export function withDiagnostics(options: RunChildOptions): { options: RunChildOptions; diag: () => RunDiagnostics } {
  let seen: RunDiagnostics | undefined;
  return {
    options: { ...options, onSettled: (d) => (seen = d) },
    diag: () => {
      if (seen === undefined) throw new Error("run did not report diagnostics");
      return seen;
    },
  };
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Waits (bounded) until no process is left in the group led by `pgid`; kill(-pgid, 0) must give ESRCH. */
export async function expectGroupGone(pgid: number | undefined, timeoutMs = 3000): Promise<void> {
  if (pgid === undefined) throw new Error("no pid to check");
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() > end) throw new Error(`process group ${pgid} still has live members after ${timeoutMs} ms`);
    await sleep(20);
  }
}

export async function expectPidGone(pid: number, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() > end) throw new Error(`pid ${pid} still alive after ${timeoutMs} ms`);
    await sleep(20);
  }
}

/** Counts of the handle kinds a leaking supervisor would leave behind. */
export function handleCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) {
    if (name === "Timeout" || name === "ChildProcess" || name === "PipeWrap" || name === "Process") {
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}

/** Fails if any handle kind has MORE live instances than in `before` (a leak); fewer is just earlier tests winding down. */
export function expectNoNewHandles(before: Record<string, number>): void {
  const after = handleCounts();
  for (const [kind, count] of Object.entries(after)) {
    if (count > (before[kind] ?? 0)) {
      throw new Error(`leaked ${kind} handles: ${count} live, ${before[kind] ?? 0} before the run`);
    }
  }
}

/** Lets close events and destroyed handles finish. */
export async function settleHandles(): Promise<void> {
  await sleep(20);
  await new Promise<void>((resolve) => setImmediate(resolve));
}
