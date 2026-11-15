import assert from "node:assert/strict";
import { test } from "node:test";
import { CpuPoller, parseProcStatCpuSecs, parsePsCpuTime, sampleCpuSecs, type CpuSampler } from "../src/cpu.ts";

/** A /proc/<pid>/stat line with `comm` and the given utime/stime (ticks); every other field is a plausible constant. */
function statLine(comm: string, utime: number | string, stime: number | string): string {
  const after = ["S", "1", "1", "1", "0", "-1", "4194560", "100", "0", "0", "0", String(utime), String(stime), "0", "0", "20", "0", "1"];
  return `4242 (${comm}) ${after.join(" ")}`;
}

test("parseProcStatCpuSecs: utime + stime in seconds at 100 ticks per second", () => {
  assert.equal(parseProcStatCpuSecs(statLine("node", 250, 50)), 3);
});

test("parseProcStatCpuSecs: a command name with spaces and parentheses is skipped from the last ')'", () => {
  assert.equal(parseProcStatCpuSecs(statLine("we ird) (name", 10, 5)), 0.15);
});

test("parseProcStatCpuSecs: the tick rate is a parameter", () => {
  assert.equal(parseProcStatCpuSecs(statLine("node", 1000, 0), 1000), 1);
});

for (const [label, line] of [
  ["no parenthesis", "4242 node S 1 1"],
  ["too few fields", "4242 (node) S 1 1 1"],
  ["a non-numeric utime", statLine("node", "x", 1)],
  ["a negative stime", statLine("node", 1, -1)],
  ["an empty line", ""],
] as const) {
  test(`parseProcStatCpuSecs: ${label} is null`, () => {
    assert.equal(parseProcStatCpuSecs(line), null);
  });
}

for (const [text, secs] of [
  ["0:00.25", 0.25],
  ["  1:02.50\n", 62.5],
  ["120:21.57", 120 * 60 + 21.57],
  ["01:00:00", 3600],
  ["2-01:00:00", 2 * 86400 + 3600],
  ["0:07", 7],
] as const) {
  test(`parsePsCpuTime: ${JSON.stringify(text)} is ${secs} s`, () => {
    assert.ok(Math.abs(parsePsCpuTime(text)! - secs) < 1e-9);
  });
}

for (const text of ["", "\n", "abc", "1.5", "1:2:3:4", "-1:00"]) {
  test(`parsePsCpuTime: ${JSON.stringify(text)} is null`, () => {
    assert.equal(parsePsCpuTime(text), null);
  });
}

test("sampleCpuSecs: this process has used some CPU, and the count only grows", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
  const first = await sampleCpuSecs(process.pid);
  assert.ok(first !== null && first > 0, String(first));
  const end = performance.now() + 50;
  while (performance.now() < end) {
    // burn a little CPU
  }
  const second = await sampleCpuSecs(process.pid);
  assert.ok(second !== null && second >= first, `${String(second)} after ${first}`);
});

test("sampleCpuSecs: a pid that does not exist is null", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
  assert.equal(await sampleCpuSecs(2_147_483_646), null);
});

test("sampleCpuSecs: a platform without a measurement is null", async () => {
  assert.equal(await sampleCpuSecs(process.pid, "win32"), null);
});

/** A sampler whose answers are scripted; records how many samples were taken. */
function scripted(values: readonly (number | null | Error)[]): { sample: CpuSampler; calls: () => number } {
  let calls = 0;
  return {
    sample: () => {
      const value = values[Math.min(calls, values.length - 1)];
      calls += 1;
      if (value instanceof Error) return Promise.reject(value);
      return value ?? null;
    },
    calls: () => calls,
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("CpuPoller: over budget calls back once with the CPU used, then stops", async () => {
  const over: number[] = [];
  const s = scripted([10.2, 10.4, 11.5, 12]);
  const poller = new CpuPoller({ pid: 1, platform: "linux", baselineSecs: 10, budgetSecs: 1, pollMs: 5, sample: s.sample, onOverBudget: (used) => over.push(used) });
  poller.start();
  await wait(80);
  assert.equal(over.length, 1);
  assert.ok(Math.abs(over[0]! - 1.5) < 1e-9);
  assert.equal(s.calls(), 3);
  assert.equal(poller.lastSecs, 11.5);
});

test("CpuPoller: the first sample is one interval in", async () => {
  const s = scripted([0]);
  const poller = new CpuPoller({ pid: 1, platform: "linux", baselineSecs: 0, budgetSecs: 1, pollMs: 60, sample: s.sample, onOverBudget: () => {} });
  poller.start();
  assert.equal(poller.lastSecs, null);
  await wait(20);
  assert.equal(s.calls(), 0);
  await wait(80);
  assert.ok(s.calls() >= 1);
  poller.stop();
});

test("CpuPoller: a sample that fails or finds nothing keeps polling", async () => {
  const over: number[] = [];
  const s = scripted([null, new Error("ps failed"), 5]);
  const poller = new CpuPoller({ pid: 1, platform: "linux", baselineSecs: 0, budgetSecs: 1, pollMs: 5, sample: s.sample, onOverBudget: (used) => over.push(used) });
  poller.start();
  await wait(80);
  assert.deepEqual(over, [5]);
});

test("CpuPoller: stop prevents any later callback", async () => {
  const over: number[] = [];
  const s = scripted([100]);
  const poller = new CpuPoller({ pid: 1, platform: "linux", baselineSecs: 0, budgetSecs: 1, pollMs: 5, sample: s.sample, onOverBudget: (used) => over.push(used) });
  poller.start();
  poller.stop();
  await wait(40);
  assert.deepEqual(over, []);
  assert.equal(s.calls(), 0);
});

test("CpuPoller: a platform without a measurement is refused unless a sampler is given", () => {
  assert.throws(() => new CpuPoller({ pid: 1, platform: "win32", baselineSecs: 0, budgetSecs: 1, onOverBudget: () => {} }), /no CPU measurement/);
  assert.doesNotThrow(() => new CpuPoller({ pid: 1, platform: "win32", baselineSecs: 0, budgetSecs: 1, onOverBudget: () => {}, sample: () => 0 }));
});
