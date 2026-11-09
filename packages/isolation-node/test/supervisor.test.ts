import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  AbortError,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  ParseTimeoutError,
} from "@spikedpunch/ripstream-core";
import { runChild, startChild } from "../src/supervisor.ts";
import { delay, fakeSpawn, type FakeChild } from "./fixtures/fake-child.ts";
import { expectGroupGone, expectNoNewHandles, expectPidGone, handleCounts, runOptions, settleHandles, withDiagnostics } from "./fixtures/helpers.ts";

const rssIsMeasurable = process.platform === "linux" || process.platform === "darwin";

/** Runs and asserts afterwards: the group is gone and no timer/child/pipe handle of ours is left. */
async function supervised(
  mode: string,
  overrides: Parameters<typeof runOptions>[1] = {},
  input?: Parameters<typeof runOptions>[2],
) {
  await settleHandles();
  const before = handleCounts();
  const { options, diag } = withDiagnostics(runOptions(mode, overrides, input));
  const outcome = await runChild(options).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await expectGroupGone(diag().pid);
  await settleHandles();
  expectNoNewHandles(before);
  return { outcome, diag: diag() };
}

function failure(outcome: Awaited<ReturnType<typeof supervised>>["outcome"]): unknown {
  assert.equal(outcome.ok, false, "expected the run to reject");
  return outcome.ok ? undefined : outcome.error;
}

// ---- success ------------------------------------------------------------------------

test("text success: input bytes reach the child after ready and the result is assembled", async () => {
  const { outcome, diag } = await supervised("echo", { request: { input: new TextEncoder().encode("héllo"), filename: "a.txt" } });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok && outcome.value, {
    kind: "text",
    metadata: { filename: ["a.txt"], path: [""], output: ["text"] },
    text: "héllo",
  });
  assert.equal(diag.terminal, "done");
  assert.equal(diag.killReason, null);
  assert.ok(diag.readyMs !== null && diag.terminalMs !== null && diag.readyMs <= diag.terminalMs);
});

test("{ path } input is passed in the header, with no inline bytes", async () => {
  const { outcome } = await supervised("echo", { request: { input: { path: "/trusted/file.bin" } } });
  assert.deepEqual(outcome.ok && outcome.value, {
    kind: "text",
    metadata: { filename: [""], path: ["/trusted/file.bin"], output: ["text"] },
    text: "",
  });
});

test("records success with embedded records", async () => {
  const { outcome } = await supervised("records", { request: { input: new Uint8Array(0), output: "records" } });
  assert.equal(outcome.ok && outcome.value.kind, "records");
  const records = outcome.ok && outcome.value.kind === "records" ? outcome.value.records : [];
  assert.deepEqual(records.map((r) => [r.depth, r.content]), [[0, "outer"], [1, "inner"]]);
});

test("a large input survives the length-prefixed stdin transfer intact", async () => {
  const big = "0123456789".repeat(300_000); // 3 MB, many pipe buffers
  const { outcome } = await supervised("echo", { request: { input: new TextEncoder().encode(big) }, maxResultBytes: 8 * 1024 * 1024, maxFrameBytes: 8 * 1024 * 1024 });
  assert.equal(outcome.ok && outcome.value.kind === "text" && outcome.value.text.length, big.length);
});

// ---- ready handshake ----------------------------------------------------------------

test("nothing is written to stdin before the ready frame", async () => {
  // This child blocks reading stdin BEFORE it sends ready; a parent that wrote early would make it succeed.
  const { outcome, diag } = await supervised("read-before-ready", { readyTimeoutMs: 400 });
  assert.ok(failure(outcome) instanceof IsolationError);
  assert.equal((failure(outcome) as IsolationError).reason, "unavailable");
  assert.equal(diag.phase, "pre-ready");
});

test("never ready: the ready deadline kills the group and reports unavailable, not timeout", async () => {
  const { outcome, diag } = await supervised("never-ready", { readyTimeoutMs: 300 });
  const error = failure(outcome);
  assert.ok(error instanceof IsolationError && error.reason === "unavailable");
  assert.equal(diag.readyTimedOut, true);
  assert.equal(diag.killReason, null);
  assert.equal(diag.outcome, "signal:SIGKILL");
});

test("the ready deadline never outlasts the overall deadline (a timeout wins when it is shorter)", async () => {
  const { outcome, diag } = await supervised("never-ready", { readyTimeoutMs: 5000, deadlineMs: 300 });
  assert.ok(failure(outcome) instanceof ParseTimeoutError);
  assert.equal(diag.readyTimedOut, false);
  assert.equal(diag.killReason, "timeout");
});

// ---- deadline and abort -------------------------------------------------------------

test("wall-clock deadline kills a hung child: ParseTimeoutError, reason recorded, group dead", async () => {
  const { outcome, diag } = await supervised("hang", { deadlineMs: 400 });
  assert.ok(failure(outcome) instanceof ParseTimeoutError);
  assert.equal(diag.killReason, "timeout");
  assert.equal(diag.phase, "post-ready");
  assert.equal(diag.outcome, "signal:SIGKILL");
});

test("abort mid-run: AbortError carrying the abort, child killed", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("user went away")), 400);
  const { outcome, diag } = await supervised("hang", { signal: controller.signal });
  assert.ok(failure(outcome) instanceof AbortError);
  assert.equal(diag.killReason, "abort");
});

test("abort with a TimeoutError reason maps to ParseTimeoutError", async () => {
  const signal = AbortSignal.timeout(400);
  const { outcome } = await supervised("hang", { signal });
  assert.ok(failure(outcome) instanceof ParseTimeoutError);
});

test("an already-aborted signal rejects without spawning anything", async () => {
  let spawned = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runChild({
      ...runOptions("echo", { signal: controller.signal }),
      spawnFn: (...args) => {
        spawned++;
        return spawn(...args);
      },
    }),
    AbortError,
  );
  assert.equal(spawned, 0);
});

test("a zero budget rejects with ParseTimeoutError without spawning anything", async () => {
  await assert.rejects(runChild(runOptions("echo", { deadlineMs: 0 })), ParseTimeoutError);
});

test("bad numeric options fail fast", async () => {
  await assert.rejects(runChild(runOptions("echo", { deadlineMs: Number.NaN })), RangeError);
  await assert.rejects(runChild(runOptions("echo", { rssLimitMb: 0 })), RangeError);
  await assert.rejects(runChild(runOptions("echo", { cpuSecs: 0 })), RangeError);
});

// ---- result and frame caps ----------------------------------------------------------

test("a frame over the per-frame cap kills the child: LimitExceededError, frame_cap", async () => {
  const { outcome, diag } = await supervised("giant-frame", { maxFrameBytes: 64 * 1024 });
  assert.ok(failure(outcome) instanceof LimitExceededError);
  assert.equal(diag.killReason, "frame_cap");
  assert.ok(diag.fd3Bytes < 512 * 1024, `read ${diag.fd3Bytes} bytes of a 1 MiB frame`);
});

test("output over the total cap kills the child: LimitExceededError, result_cap", async () => {
  const { outcome, diag } = await supervised("result-cap", { maxResultBytes: 50_000 });
  assert.ok(failure(outcome) instanceof LimitExceededError);
  assert.equal(diag.killReason, "result_cap");
});

test("a protocol violation kills the child and is an IsolationError crash, never a limit", async () => {
  const { outcome, diag } = await supervised("protocol-violation");
  const error = failure(outcome);
  assert.ok(error instanceof IsolationError && error.reason === "crash");
  assert.match((error as Error).message, /unknown frame type/);
  assert.equal(diag.killReason, "protocol");
});

test("a meta frame with too many keys kills the child at once: LimitExceededError, metadata_cap", async () => {
  // 250,000 empty-valued keys is ~3 MB of JSON: raise the byte caps so the key bound is what trips, not the frame cap.
  const { outcome, diag } = await supervised("meta-flood", { maxFrameBytes: 8 * 1024 * 1024, maxResultBytes: 8 * 1024 * 1024 });
  const error = failure(outcome);
  assert.ok(error instanceof LimitExceededError, String(error));
  assert.match((error as Error).message, /metadata/i);
  assert.equal(diag.killReason, "metadata_cap");
});

test("sequence errors are caught at the offending frame, and the child is killed then (not after it finishes)", async () => {
  for (const [mode, output, pattern] of [
    ["second-meta", "text", /second "meta"/],
    ["record-in-text", "text", /"record" frame for text output/],
    ["text-in-records", "records", /"text" frame for records output/],
  ] as const) {
    const { outcome, diag } = await supervised(mode, { request: { input: new Uint8Array(1), output }, deadlineMs: 5000 });
    const error = failure(outcome);
    assert.ok(error instanceof IsolationError && error.reason === "crash", `${mode}: ${String(error)}`);
    assert.match((error as Error).message, pattern, mode);
    assert.equal(diag.killReason, "protocol", mode);
    assert.ok(diag.settledMs < 4000, `${mode} settled after ${diag.settledMs} ms; the hanging child must have been killed`);
  }
});

test("more frames than maxFrames: the flood is cut off with a protocol violation", async () => {
  const { outcome, diag } = await supervised("text-flood", { maxFrames: 100 });
  const error = failure(outcome);
  assert.ok(error instanceof IsolationError && error.reason === "crash");
  assert.match((error as Error).message, /more than 100 frames/);
  assert.equal(diag.killReason, "protocol");
  assert.ok(diag.frameCount <= 100);
});

test("a partial line trickled in one byte at a time hits the frame cap: LimitExceededError, frame_cap", async () => {
  const { outcome, diag } = await supervised("trickle", { maxFrameBytes: 50_000, deadlineMs: 20_000 });
  assert.ok(failure(outcome) instanceof LimitExceededError);
  assert.equal(diag.killReason, "frame_cap");
});

// ---- terminal outcomes --------------------------------------------------------------

test("exit without a terminal frame is a crash and carries the stderr tail", async () => {
  const { outcome } = await supervised("exit-without-terminal");
  const error = failure(outcome) as IsolationError;
  assert.ok(error instanceof IsolationError && error.reason === "crash");
  assert.match(String((error.cause as Error).message), /boom-marker/);
});

test("a heap OOM whose fatal line scrolled out of the stderr tail is still a LimitExceededError", async () => {
  const { outcome, diag } = await supervised("oom-long-dump");
  assert.ok(failure(outcome) instanceof LimitExceededError, String(failure(outcome)));
  assert.equal(diag.signal, "SIGABRT");
  assert.doesNotMatch(diag.stderrTail, /heap out of memory/, "the marker must be outside the 8 KiB tail for this test to mean anything");
});

test("error frame kind malformed => MalformedDocumentError", async () => {
  const { outcome, diag } = await supervised("error-frame-malformed");
  assert.ok(failure(outcome) instanceof MalformedDocumentError);
  assert.equal(diag.terminal, "error");
});

test("error frame kind limit => LimitExceededError", async () => {
  const { outcome } = await supervised("error-frame-limit");
  assert.ok(failure(outcome) instanceof LimitExceededError);
});

// ---- done, then linger --------------------------------------------------------------

test("done then linger with a grandchild: resolves after the grace, the whole group is killed", async () => {
  await settleHandles();
  const before = handleCounts();
  const { options, diag } = withDiagnostics(runOptions("done-linger", { graceMs: 100 }));
  const started = performance.now();
  const result = await runChild(options);
  const elapsed = performance.now() - started;
  const grandchild = Number(result.kind === "text" ? result.text : "NaN");
  assert.ok(Number.isInteger(grandchild) && grandchild > 0);
  assert.equal(diag().graceKilled, true);
  assert.equal(diag().killReason, null);
  assert.ok(elapsed < 5000, `took ${elapsed} ms`);
  await expectGroupGone(diag().pid);
  await expectPidGone(grandchild);
  await settleHandles();
  expectNoNewHandles(before);
});

test("done then immediate exit with a grandchild holding the stdio fds: resolves on exit, grandchild swept", async () => {
  const { options, diag } = withDiagnostics(runOptions("done-exit-grandchild", { graceMs: 100 }));
  const result = await runChild(options);
  const grandchild = Number(result.kind === "text" ? result.text : "NaN");
  assert.equal(diag().code, 0);
  assert.equal(diag().graceKilled, false);
  assert.ok(diag().settledMs < 3000, `settled after ${diag().settledMs} ms`);
  await expectPidGone(grandchild);
  await expectGroupGone(diag().pid);
});

// ---- stdin EPIPE ----------------------------------------------------------------------

test("a child that dies before reading stdin: EPIPE is swallowed and the run rejects as a crash", async () => {
  let uncaught: unknown;
  const onUncaught = (error: unknown): void => {
    uncaught = error;
  };
  process.on("uncaughtException", onUncaught);
  try {
    const big = new Uint8Array(8 * 1024 * 1024); // far beyond the pipe buffer, so the write really meets a dead reader
    const { outcome, diag } = await supervised("early-death", { request: { input: big } });
    const error = failure(outcome);
    assert.ok(error instanceof IsolationError && error.reason === "crash");
    assert.equal(diag.code, 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.equal(uncaught, undefined);
});

// ---- spawn failure ----------------------------------------------------------------------

test("spawn failure (no /bin/sh) is IsolationError unavailable and never throws", async () => {
  const { options, diag } = withDiagnostics({
    ...runOptions("echo"),
    spawnFn: (_file, args, spawnOptions) => spawn("/nonexistent/bin/sh", args, spawnOptions),
  });
  const error = await runChild(options).then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof IsolationError && error.reason === "unavailable");
  assert.match((error as Error).message, /ENOENT/);
  assert.equal(diag().outcome, "spawn:ENOENT");
  assert.equal(diag().pid, undefined);
});

test("a synchronous spawn throw is IsolationError unavailable", async () => {
  const error = await runChild({
    ...runOptions("echo"),
    spawnFn: () => {
      throw new Error("EAGAIN-ish");
    },
  }).then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof IsolationError && error.reason === "unavailable");
});

test("missing node binary: sh exec fails before ready => unavailable", async () => {
  const { outcome, diag } = await supervised("echo", { nodePath: "/nonexistent/node" });
  const error = failure(outcome);
  assert.ok(error instanceof IsolationError && error.reason === "unavailable");
  assert.equal(diag.phase, "pre-ready");
  assert.ok(diag.code === 126 || diag.code === 127, `exit code ${String(diag.code)}`); // dash/ash: 127, macOS sh: 126
});

// ---- RSS poll ---------------------------------------------------------------------------

test(
  "RSS over the limit kills the child (L3): LimitExceededError, rss, poll stats reported",
  { skip: !rssIsMeasurable },
  async () => {
    const { outcome, diag } = await supervised("rss", { rssLimitMb: 150, deadlineMs: 15_000 });
    assert.ok(failure(outcome) instanceof LimitExceededError);
    assert.equal(diag.killReason, "rss");
    assert.ok(diag.rss !== null && diag.rss.samples >= 1 && (diag.rss.rssAtLimitMb ?? 0) > 150);
    assert.ok(diag.rss.effectiveIntervalMs >= (process.platform === "darwin" ? 250 : 20));
  },
);

test("a real child is sampled at least once by the RSS poll", { skip: !rssIsMeasurable }, async () => {
  const { outcome, diag } = await supervised("echo", { rssLimitMb: 100_000 });
  assert.equal(outcome.ok, true);
  assert.ok(diag.rss !== null && diag.rss.samples >= 1);
});

test("the RSS poll stops when the child exits: no sample is taken afterwards", async () => {
  // A fake child and a counting sampler make this deterministic on every platform: the poll provably ran
  // before the exit (several 5 ms ticks) and provably did not run after it.
  let samples = 0;
  const { spawnFn } = fakeSpawn({
    onInput: (child) => {
      setTimeout(() => {
        child.writeFd3(META + '{"t":"text","chunk":"x"}\n{"t":"done"}\n');
        child.exit(0, null);
        child.close();
      }, 60);
    },
  });
  const { options, diag } = withDiagnostics({
    ...runOptions("unused"),
    spawnFn,
    platform: "linux",
    rssLimitMb: 100_000,
    pollMs: 5,
    rssSampler: () => {
      samples++;
      return 10;
    },
  });
  await runChild(options);
  const atSettle = samples;
  assert.ok(atSettle >= 3, `the poll should have ticked several times before the exit, ticked ${atSettle}`);
  assert.equal(diag().rss?.samples, atSettle);
  await delay(120); // 24 ticks' worth
  assert.equal(samples, atSettle, "the poll kept sampling after the child exited");
});

// ---- exactly-once -----------------------------------------------------------------------

test("settles exactly once even when timeout, abort and exit race", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  let settledCalls = 0;
  const options = { ...runOptions("hang", { deadlineMs: 150, signal: controller.signal }), onSettled: () => settledCalls++ };
  await assert.rejects(runChild(options));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settledCalls, 1);
});

// ---- caps and violations seen AFTER the leader's exit (F2) ---------------------------------

const META = '{"t":"meta","metadata":{}}\n';

/**
 * The leader's 'exit' can reach the parent before the bytes still sitting in the pipe do. A cap or protocol
 * violation processed in that window must classify exactly as it does when the bytes come first.
 */
async function runFake(
  script: (child: FakeChild) => void,
  overrides: Partial<Parameters<typeof runChild>[0]> = {},
): Promise<{ error: unknown; diag: ReturnType<ReturnType<typeof withDiagnostics>["diag"]> }> {
  const { spawnFn } = fakeSpawn({ onInput: script });
  const { options, diag } = withDiagnostics({
    ...runOptions("unused", { maxResultBytes: 1000, deadlineMs: 3000 }),
    spawnFn,
    ...overrides,
  });
  const error = await runChild(options).then(() => undefined, (e: unknown) => e);
  return { error, diag: diag() };
}

const exitFirst = (bytes: string) => (child: FakeChild) => {
  child.exit(0, null);
  child.writeFd3(bytes);
  setTimeout(() => child.close(), 50);
};
const bytesFirst = (bytes: string) => (child: FakeChild) => {
  child.writeFd3(bytes);
  setTimeout(() => {
    child.exit(null, "SIGKILL");
    child.close();
  }, 50);
};

const oversize = META + `{"t":"text","chunk":"${"x".repeat(2000)}"}\n`;
const bigFrame = META + "y".repeat(600);

for (const [label, bytes, overrides, kind] of [
  ["over the total cap", oversize, {}, "result_cap"],
  ["an oversized frame", bigFrame, { maxFrameBytes: 500, maxResultBytes: 100_000 }, "frame_cap"],
] as const) {
  for (const [order, script] of [["exit first", exitFirst], ["bytes first", bytesFirst]] as const) {
    test(`${label} after ${order}: LimitExceededError (${kind}), identical in both orders`, async () => {
      const { error, diag } = await runFake(script(bytes), overrides);
      assert.ok(error instanceof LimitExceededError, String(error));
      assert.equal(diag.killReason, kind);
    });
  }
}

for (const [order, script] of [["exit first", exitFirst], ["bytes first", bytesFirst]] as const) {
  test(`garbage after ${order}: IsolationError crash (protocol), identical in both orders`, async () => {
    const { error, diag } = await runFake(script("garbage\n"));
    assert.ok(error instanceof IsolationError && error.reason === "crash", String(error));
    assert.match((error as Error).message, /protocol violation/);
    assert.equal(diag.killReason, "protocol");
  });
}

test("a violation after exit settles at once; it does not wait for the drain window", async () => {
  // No 'close' is ever emitted, so only the violation itself can end the run before the 500 ms drain timer.
  const { diag } = await runFake((child) => {
    child.exit(0, null);
    child.writeFd3("garbage\n");
  });
  assert.ok(diag.settledMs < 300, `settled after ${diag.settledMs} ms`);
});

// ---- bytes arriving after exit but before the drain ends are still processed (M21) ---------

test("frames that arrive after the leader's exit, within the drain window, still produce the result", async () => {
  const { spawnFn } = fakeSpawn({
    onInput: (child) => {
      child.exit(0, null);
      setTimeout(() => {
        child.writeFd3(META + '{"t":"text","chunk":"late"}\n{"t":"done"}\n');
        child.close();
      }, 60);
    },
  });
  const { options, diag } = withDiagnostics({ ...runOptions("unused"), spawnFn });
  const result = await runChild(options);
  assert.deepEqual(result, { kind: "text", metadata: {}, text: "late" });
  assert.equal(diag().terminal, "done");
  assert.ok((diag().exitMs ?? Infinity) < (diag().terminalMs ?? 0), "exit must have been observed before the terminal frame");
});

test("with no terminal frame after exit the drain window is bounded: the run still settles as a crash", async () => {
  const { error, diag } = await runFake((child) => child.exit(0, null));
  assert.ok(error instanceof IsolationError && error.reason === "crash");
  assert.ok(diag.settledMs >= 400 && diag.settledMs < 2000, `settled after ${diag.settledMs} ms`);
});


// ---- two promises: `dead` is the resource owner's, `result` the caller's (F4) -----------------

type Race = "dead" | "pending";
const state = (promise: Promise<unknown>, waitMs = 80): Promise<Race> =>
  Promise.race([promise.then((): Race => "dead"), delay(waitMs).then((): Race => "pending")]);

test("startChild: dead is already resolved when nothing was ever spawned", async () => {
  const thrown = startChild({ ...runOptions("echo"), spawnFn: () => { throw new Error("EAGAIN-ish"); } });
  await assert.rejects(thrown.result, IsolationError);
  assert.equal(await state(thrown.dead), "dead");

  const controller = new AbortController();
  controller.abort();
  const aborted = startChild({ ...runOptions("echo"), signal: controller.signal });
  await assert.rejects(aborted.result, AbortError);
  assert.equal(await state(aborted.dead), "dead");

  const noBudget = startChild({ ...runOptions("echo"), deadlineMs: 0 });
  await assert.rejects(noBudget.result, ParseTimeoutError);
  assert.equal(await state(noBudget.dead), "dead");
});

test("startChild: a spawn failure reported through 'error' also resolves dead", async () => {
  const run = startChild({ ...runOptions("echo"), spawnFn: (_file, args, o) => spawn("/nonexistent/bin/sh", args, o) });
  await assert.rejects(run.result, IsolationError);
  assert.equal(await state(run.dead), "dead");
});

test("startChild: on a normal run dead resolves before the caller hears the result", async () => {
  const order: string[] = [];
  const run = startChild(runOptions("echo"));
  void run.dead.then(() => order.push("dead"));
  void run.result.then(() => order.push("result"));
  await run.result;
  await run.dead;
  assert.deepEqual(order, ["dead", "result"]);
});

test("startChild: a child that survives its kill answers the caller at reapWaitMs but is not dead", async () => {
  const { spawnFn, children } = fakeSpawn();
  const controller = new AbortController();
  const started = performance.now();
  const run = startChild({
    ...runOptions("unused", { deadlineMs: 10_000 }),
    spawnFn,
    reapWaitMs: 40,
    signal: controller.signal,
  });
  run.result.catch(() => {});
  await delay(20);
  controller.abort();
  await assert.rejects(run.result, AbortError);
  const waited = performance.now() - started;
  assert.ok(waited < 1000, `caller waited ${Math.round(waited)} ms; it must be answered after the reap wait, not forever`);
  assert.equal(await state(run.dead, 100), "pending", "the leader was never reaped, so the child is not dead");
  children[0]?.exit(null, "SIGKILL"); // the kernel finally reaps it
  assert.equal(await state(run.dead, 500), "dead");
});

test("startChild: dead never rejects, even when the run fails", async () => {
  const run = startChild(runOptions("exit-without-terminal"));
  await assert.rejects(run.result, IsolationError);
  await run.dead;
});

// ---- a second 'error' event must not become an uncaught exception (F13) --------------------

test("two 'error' events on a child that never spawned do not throw: the listener is persistent", async () => {
  let uncaught: unknown;
  const onUncaught = (error: unknown): void => {
    uncaught = error;
  };
  process.on("uncaughtException", onUncaught);
  try {
    const { spawnFn } = fakeSpawn({
      autoReady: false,
      onSpawn: (child) => {
        child.pid = undefined as unknown as number; // spawn failed: Node gives no pid
        setImmediate(() => {
          const failure = Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN", syscall: "spawn" });
          child.emit("error", failure);
          child.emit("error", failure);
        });
      },
    });
    const { options, diag } = withDiagnostics({ ...runOptions("unused"), spawnFn });
    const error = await runChild(options).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof IsolationError && error.reason === "unavailable", String(error));
    assert.equal(diag().outcome, "spawn:EAGAIN");
    await delay(50);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.equal(uncaught, undefined);
});

// ---- stderr budget (F5) -------------------------------------------------------------------

const BUDGET = 64 * 1024;
/** A read hands over at most one 64 KiB chunk, so the budget can be overshot by that much and no more. */
const READ_SLACK = 64 * 1024;

test("stderr: the pipe is destroyed once the budget is read (fake child, deterministic)", async () => {
  const { spawnFn, children } = fakeSpawn({
    onInput: (child) => {
      child.writeStderr("a".repeat(40 * 1024));
      setTimeout(() => {
        child.writeStderr("b".repeat(40 * 1024));
        setTimeout(() => {
          child.writeFd3(META + '{"t":"text","chunk":"ok"}\n{"t":"done"}\n');
          child.exit(0, null);
          child.close();
        }, 30);
      }, 30);
    },
  });
  const { options, diag } = withDiagnostics({ ...runOptions("unused"), spawnFn, stderrBudgetBytes: 50 * 1024 });
  const result = await runChild(options);
  assert.equal(result.kind === "text" && result.text, "ok");
  assert.equal(diag().stderrClosed, true);
  assert.ok(diag().stderrBytes >= 50 * 1024 && diag().stderrBytes <= 80 * 1024, `read ${diag().stderrBytes} bytes`);
  assert.equal(children[0]?.stderrDestroyed(), true);
});

test("stderr: an OOM marker split across two reads is still seen (fake child, deterministic)", async () => {
  const { spawnFn } = fakeSpawn({
    onInput: (child) => {
      child.writeStderr("FATAL ERROR: JavaScript heap out of me");
      setTimeout(() => {
        child.writeStderr("mory\n" + "x".repeat(20 * 1024));
        setTimeout(() => {
          child.exit(null, "SIGABRT");
          child.close();
        }, 30);
      }, 30);
    },
  });
  const { options } = withDiagnostics({ ...runOptions("unused"), spawnFn });
  await assert.rejects(runChild(options), LimitExceededError);
});

test("stderr: under the budget the pipe stays open", async () => {
  let destroyedBeforeExit: boolean | undefined;
  const { spawnFn } = fakeSpawn({
    onInput: (child) => {
      child.writeStderr("small");
      setTimeout(() => {
        destroyedBeforeExit = child.stderrDestroyed();
        child.writeFd3(META + '{"t":"text","chunk":"ok"}\n{"t":"done"}\n');
        child.exit(0, null);
        child.close();
      }, 20);
    },
  });
  const { options, diag } = withDiagnostics({ ...runOptions("unused"), spawnFn });
  await runChild(options);
  assert.equal(diag().stderrClosed, false);
  assert.equal(diag().stderrBytes, 5);
  assert.equal(destroyedBeforeExit, false);
});

test("stderr flood from a real child that handles EPIPE: not killed, result intact, reading stopped at the budget", async () => {
  const { outcome, diag } = await supervised("stderr-spam", { stderrBudgetBytes: BUDGET, deadlineMs: 20_000 });
  assert.ok(outcome.ok, String(outcome.ok ? "" : outcome.error));
  const result = outcome.ok ? outcome.value : undefined;
  assert.equal(result?.kind === "text" && result.text, "after-spam");
  assert.equal(diag.stderrClosed, true);
  assert.ok(diag.stderrBytes >= BUDGET && diag.stderrBytes <= BUDGET + READ_SLACK, `read ${diag.stderrBytes} of 4 MiB`);
  assert.equal(diag.killReason, null);
  // The child's side of the contract: once the parent stops reading, its writes fail with EPIPE.
  assert.ok(Number(result?.kind === "text" ? result.metadata.epipe?.[0] : 0) > 0, "the flood should have met a closed pipe");
});

test("stderr: a one-byte-per-write trickle is cut off at the budget, not read for as long as the child writes", async () => {
  const { outcome, diag } = await supervised("stderr-spam", {
    scriptArgs: ["stderr-spam", "1", String(300_000)],
    stderrBudgetBytes: 1024,
    deadlineMs: 20_000,
  });
  assert.ok(outcome.ok, String(outcome.ok ? "" : outcome.error));
  assert.equal(diag.stderrClosed, true);
  assert.ok(diag.stderrBytes >= 1024 && diag.stderrBytes <= 1024 + READ_SLACK, `read ${diag.stderrBytes} bytes`);
  const value = outcome.ok ? outcome.value : undefined;
  assert.ok(Number(value?.kind === "text" ? value.metadata.epipe?.[0] : 0) > 0);
});

test("stderr flood from a child that skips initChildProcess() dies of EPIPE: a crash, as documented", async () => {
  const { outcome, diag } = await supervised("stderr-spam-unhandled", { stderrBudgetBytes: BUDGET, deadlineMs: 20_000 });
  const error = failure(outcome);
  assert.ok(error instanceof IsolationError && error.reason === "crash", String(error));
  assert.equal(diag.stderrClosed, true);
  assert.equal(diag.killReason, null, "the supervisor did not kill it: the child's own uncaught EPIPE did");
});

// ---- the child's environment and stdio (M25, M20) --------------------------------------------

test("M25: the child really receives only the allowlist, plus MALLOC_ARENA_MAX", async () => {
  const parentEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/home/test",
    LANG: "C.UTF-8",
    TZ: "UTC",
    NODE_OPTIONS: "--no-warnings --require /evil.js",
    LD_PRELOAD: "/evil.so",
    LD_LIBRARY_PATH: "/evil",
    DYLD_LIBRARY_PATH: "/evil",
    DYLD_INSERT_LIBRARIES: "/evil.dylib",
    SECRET_TOKEN: "s3cret",
    AWS_SECRET_ACCESS_KEY: "s3cret",
  };
  const { outcome } = await supervised("env", { parentEnv });
  assert.ok(outcome.ok, String(outcome.ok ? "" : outcome.error));
  const text = outcome.ok && outcome.value.kind === "text" ? outcome.value.text : "{}";
  const env = JSON.parse(text) as Record<string, string>;
  for (const secret of ["NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "SECRET_TOKEN", "AWS_SECRET_ACCESS_KEY"]) {
    assert.equal(secret in env, false, `${secret} leaked into the child`);
  }
  assert.equal(env.MALLOC_ARENA_MAX, "1");
  assert.equal(env.HOME, "/home/test");
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.TZ, "UTC");
  assert.equal(env.PATH, parentEnv.PATH);
  // What sh and the OS add on their own is not ours to forbid; nothing else may be there.
  const allowed = new Set(["PATH", "HOME", "LANG", "TZ", "MALLOC_ARENA_MAX", "PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"]);
  const extra = Object.keys(env).filter((name) => !allowed.has(name));
  assert.deepEqual(extra, []);
});

test("M20: the child's stdout is not connected to anything (stdio config)", async () => {
  let captured: Parameters<NonNullable<Parameters<typeof runChild>[0]["spawnFn"]>>[2] | undefined;
  const { outcome } = await supervised("echo", {
    spawnFn: (file, args, spawnOptions) => {
      captured = spawnOptions;
      return spawn(file, args, spawnOptions);
    },
  });
  assert.ok(outcome.ok);
  assert.deepEqual(captured?.stdio, ["pipe", "ignore", "pipe", "pipe"]);
  assert.equal(captured?.detached, true);
});

test("M20: a child that prints to stdout does not reach the parent's stdout (real process)", async () => {
  const fixture = new URL("./fixtures/stdout-parent.ts", import.meta.url).pathname;
  const parent = spawn(process.execPath, [...process.execArgv.filter((arg) => !arg.startsWith("--test")), fixture], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  parent.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  parent.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => parent.once("close", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stdout, "PARENT-DONE text\n");
  assert.equal(stdout.includes("CHILD-STDOUT-MARKER"), false);
});

// ---- R1: bytes after the terminal frame cannot undo the result ----------------------------------------------

test("R1 text: a late frame in the same write as done does not empty the result (real child)", async () => {
  const { outcome, diag } = await supervised("done-then-late");
  assert.ok(outcome.ok, String(outcome.ok ? "" : outcome.error));
  assert.deepEqual(outcome.ok ? outcome.value : undefined, { kind: "text", metadata: { a: ["b"] }, text: "IMPORTANT CONTENT" });
  assert.equal(diag.terminal, "done");
  assert.equal(diag.killReason, null);
});

test("R1 records: junk in the same write as done does not empty the result (real child)", async () => {
  const { outcome } = await supervised("done-then-late", {
    scriptArgs: ["done-then-late", "records"],
    request: { input: new Uint8Array([1]), output: "records" },
  });
  assert.ok(outcome.ok, String(outcome.ok ? "" : outcome.error));
  const value = outcome.ok ? outcome.value : undefined;
  assert.equal(value?.kind, "records");
  assert.equal(value?.kind === "records" ? value.records[0]?.content : undefined, "IMPORTANT");
  assert.equal(value?.kind === "records" ? value.records.length : 0, 1);
});

for (const [label, tail] of [
  ["a late text frame", '{"t":"text","chunk":"late"}\n'],
  ["garbage", "not json\n"],
  ["a flood past the total cap", "x".repeat(5000)],
] as const) {
  test(`R1 fake child, one chunk: ${label} after done is ignored, in either exit order`, async () => {
    for (const exitFirst of [true, false]) {
      const { spawnFn } = fakeSpawn({
        onInput: (child) => {
          if (exitFirst) child.exit(0, null);
          child.writeFd3(META + '{"t":"text","chunk":"IMPORTANT CONTENT"}\n{"t":"done"}\n' + tail);
          if (!exitFirst) child.exit(0, null);
          setTimeout(() => child.close(), 20);
        },
      });
      const { options, diag } = withDiagnostics({ ...runOptions("unused", { maxResultBytes: 200 }), spawnFn });
      const result = await runChild(options);
      assert.deepEqual(result, { kind: "text", metadata: {}, text: "IMPORTANT CONTENT" }, `exitFirst=${exitFirst}`);
      assert.equal(diag().terminal, "done");
      assert.equal(diag().killReason, null);
    }
  });
}

// ---- R2: a chatty legitimate child (initChildProcess) is never cut off by the parent's stderr budget ---------

const CHILD_BUDGET = 256 * 1024;

test("R2 a child that logs 1.2 MB of warnings and then succeeds: success, the parent never closes the pipe", async () => {
  const { outcome, diag } = await supervised("warn-flood", { scriptArgs: ["warn-flood", "success"], deadlineMs: 20_000 });
  assert.ok(outcome.ok, String(outcome.ok ? "" : outcome.error));
  assert.equal(outcome.ok && outcome.value.kind === "text" ? outcome.value.text : undefined, "after-warnings");
  assert.equal(diag.stderrClosed, false, "the child stopped writing long before the parent's budget");
  assert.ok(diag.stderrBytes <= CHILD_BUDGET, `parent read ${diag.stderrBytes} bytes`);
  assert.ok(diag.stderrBytes >= CHILD_BUDGET - 64, `the flood must really have reached the child's budget (${diag.stderrBytes})`);
});

test("R2 the same flood and then an out-of-memory abort: LimitExceeded, not a crash", async () => {
  const { outcome, diag } = await supervised("warn-flood", { scriptArgs: ["warn-flood", "oom"], heapMb: 64, deadlineMs: 30_000 });
  const error = failure(outcome);
  assert.ok(error instanceof LimitExceededError, String(error));
  assert.equal(diag.stderrClosed, false);
  assert.equal(diag.killReason, null, "the child died of its own heap limit");
});

test("R2 the same flood and then a string-length RangeError: LimitExceeded, not a crash", async () => {
  const { outcome, diag } = await supervised("warn-flood", { scriptArgs: ["warn-flood", "strlen"], deadlineMs: 30_000 });
  const error = failure(outcome);
  assert.ok(error instanceof LimitExceededError, String(error));
  assert.equal(diag.stderrClosed, false);
});

test("R2 a child that passes a smaller budget to initChildProcess is cut off earlier, by itself", async () => {
  const { outcome, diag } = await supervised("warn-flood", {
    scriptArgs: ["warn-flood", "success", "400000", "20000"],
    deadlineMs: 20_000,
  });
  assert.ok(outcome.ok, String(outcome.ok ? "" : outcome.error));
  assert.ok(diag.stderrBytes <= 20_000 && diag.stderrBytes > 0, `read ${diag.stderrBytes}`);
});
