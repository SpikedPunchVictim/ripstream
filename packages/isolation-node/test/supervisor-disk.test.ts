import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  AbortError,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  ParseTimeoutError,
} from "@spikedpunch/ripstream-core";
import { CALL_DIR_PREFIX } from "../src/disk.ts";
import { startChild, type RunChildOptions, type RunDiagnostics } from "../src/supervisor.ts";
import { delay, fakeSpawn } from "./fixtures/fake-child.ts";
import { DISK_CHILD, expectGroupGone, runOptions, withDiagnostics } from "./fixtures/helpers.ts";

/**
 * L6 at the supervisor: every call gets a private directory (TMPDIR), it is measured while the child runs, and it is
 * removed once the child is reaped, whatever the outcome. Each test owns its own tempDir under one root removed at
 * the end; nothing here looks at the shared temp directory.
 */
const root = mkdtempSync(join(tmpdir(), "ripstream-disk-sup-"));
after(() => rmSync(root, { recursive: true, force: true }));

const MIB = 1024 * 1024;

function setup(mode: string, args: readonly string[], overrides: Partial<RunChildOptions> = {}) {
  const tempDir = mkdtempSync(join(root, "t-"));
  const { options, diag } = withDiagnostics(
    runOptions(mode, { scriptPath: DISK_CHILD, scriptArgs: [mode, ...args], tempDir, ...overrides }),
  );
  return { tempDir, options, diag };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await delay(10);
  }
}

const settled = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

interface Report {
  tmpdir: string;
  osTmpdir: string;
  cwd: string;
  mode: number;
  files: string[];
}

// ---- (a) TMPDIR ---------------------------------------------------------------------------------

test("TMPDIR: the child gets a fresh private directory under tempDir on every call, never the parent's TMPDIR", async () => {
  const parentEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: "/parent/tmpdir/not/used" };
  const { tempDir, options } = setup("tmpdir-report", [], { parentEnv });
  const reports: Report[] = [];
  for (let call = 0; call < 2; call++) {
    const result = await startChild(options).result;
    assert.equal(result.kind, "text");
    reports.push(JSON.parse(result.kind === "text" ? result.text : "{}") as Report);
  }
  const [first, second] = reports as [Report, Report];
  assert.equal(dirname(first.tmpdir), tempDir);
  assert.ok(basename(first.tmpdir).startsWith(CALL_DIR_PREFIX), first.tmpdir);
  assert.notEqual(first.tmpdir, second.tmpdir, "a new directory per call");
  assert.equal(first.osTmpdir, first.tmpdir, "os.tmpdir() in the child follows TMPDIR");
  assert.equal(first.mode, 0o700);
  assert.deepEqual(first.files, ["probe.txt"], "the directory starts empty");
  assert.deepEqual(readdirSync(tempDir), [], "both directories are gone once the calls have answered");
});

test("TMPDIR: the working directory is not changed (relative input and script paths still resolve)", async () => {
  const { options } = setup("tmpdir-report", []);
  const result = await startChild(options).result;
  const report = JSON.parse(result.kind === "text" ? result.text : "{}") as Report;
  assert.equal(report.cwd, process.cwd());
});

// ---- (b) removal on every outcome ---------------------------------------------------------------

/** After a call: the caller was answered only once the directory was gone, and `dead` agrees. */
async function expectCleanUp(
  tempDir: string,
  run: ReturnType<typeof startChild>,
  diag: () => RunDiagnostics,
): Promise<void> {
  assert.deepEqual(readdirSync(tempDir), [], "the directory was still there when the caller was answered");
  await run.dead;
  assert.deepEqual(readdirSync(tempDir), []);
  const seen = diag();
  assert.equal(seen.tempCleanupError, null);
  assert.ok(seen.callDir !== null && dirname(seen.callDir) === tempDir, String(seen.callDir));
  assert.equal(existsSync(seen.callDir ?? ""), false);
  await expectGroupGone(seen.pid);
}

test("removal: after a success (the child left files, a nested directory and 1 MiB behind)", async () => {
  const { tempDir, options, diag } = setup("spool", ["1", "done"], { maxDiskMb: 1024, diskPollMs: 20 });
  const run = startChild(options);
  const result = await run.result;
  assert.equal(result.kind, "text");
  const files = result.kind === "text" ? result.metadata.files : undefined;
  assert.deepEqual([...(files ?? [])].sort(), ["nested", "spool.bin"], "the files existed while the child ran");
  await expectCleanUp(tempDir, run, diag);
});

test("removal: after an error frame from the child", async () => {
  const { tempDir, options, diag } = setup("spool", ["1", "error"]);
  const run = startChild(options);
  const error = await settled(run.result);
  assert.ok(error instanceof MalformedDocumentError, String(error));
  await expectCleanUp(tempDir, run, diag);
});

test("removal: after the child crashed", async () => {
  const { tempDir, options, diag } = setup("spool", ["1", "crash"]);
  const run = startChild(options);
  const error = await settled(run.result);
  assert.ok(error instanceof IsolationError && error.reason === "crash", String(error));
  await expectCleanUp(tempDir, run, diag);
});

test("removal: after the wall-clock kill, with the child's files on disk when it was killed", async () => {
  const { tempDir, options, diag } = setup("spool", ["2", "hang"], { deadlineMs: 1500, maxDiskMb: 1024, diskPollMs: 20 });
  const run = startChild(options);
  const error = await settled(run.result);
  assert.ok(error instanceof ParseTimeoutError, String(error));
  assert.equal(diag().killReason, "timeout");
  assert.ok((diag().disk?.peakBytes ?? 0) >= 2 * MIB, "the poll saw the spool before the kill");
  await run.dead;
  assert.deepEqual(readdirSync(tempDir), []);
  assert.equal(diag().tempCleanupError, null);
  await expectGroupGone(diag().pid);
});

test("removal: after an abort", async () => {
  const controller = new AbortController();
  const { tempDir, options, diag } = setup("spool", ["2", "hang"], { signal: controller.signal });
  const run = startChild(options);
  // The child writes the nested file last, so everything is on disk when the abort arrives.
  await waitFor(() => {
    const [dir] = readdirSync(tempDir);
    return dir !== undefined && existsSync(join(tempDir, dir, "nested", "deep", "x.txt"));
  });
  controller.abort();
  const error = await settled(run.result);
  assert.ok(error instanceof AbortError, String(error));
  await run.dead;
  assert.deepEqual(readdirSync(tempDir), []);
  assert.equal(diag().tempCleanupError, null);
  await expectGroupGone(diag().pid);
});

test("removal: after a spawn that throws, and after a spawn that fails asynchronously (nothing ran)", async () => {
  const thrown = setup("spool", ["1", "done"], {
    spawnFn: () => {
      throw new Error("no fork for you");
    },
  });
  const first = await settled(startChild(thrown.options).result);
  assert.ok(first instanceof IsolationError && first.reason === "unavailable", String(first));
  assert.deepEqual(readdirSync(thrown.tempDir), []);

  const missing = setup("spool", ["1", "done"], { spawnFn: (_file, args, spawnOptions) => spawn("/nonexistent/bin/sh", args, spawnOptions) });
  const run = startChild(missing.options);
  const second = await settled(run.result);
  assert.ok(second instanceof IsolationError && second.reason === "unavailable", String(second));
  assert.deepEqual(readdirSync(missing.tempDir), [], "gone before the caller was answered");
  await run.dead;
  assert.equal(missing.diag().tempCleanupError, null);
});

test("removal: a call that is refused up front (bad header) leaves nothing behind", async () => {
  const { tempDir, options } = setup("spool", ["1", "done"], { request: { input: { path: "" } } });
  const error = await settled(startChild(options).result);
  assert.ok(error instanceof TypeError, String(error));
  assert.deepEqual(readdirSync(tempDir), []);
});

test("a tempDir that cannot hold the call directory is 'unavailable', with the reason", async () => {
  const { tempDir, options } = setup("spool", ["1", "done"], { tempDir: join(root, "does-not-exist") });
  const run = startChild(options);
  const error = await settled(run.result);
  assert.ok(error instanceof IsolationError && error.reason === "unavailable", String(error));
  assert.match((error as Error).message, /temporary directory/);
  await run.dead; // nothing was spawned
  assert.deepEqual(readdirSync(tempDir), []);
});

test("the directory is kept while the leader is not reaped, and removed when it finally is", async () => {
  const tempDir = mkdtempSync(join(root, "t-"));
  const { spawnFn, children } = fakeSpawn();
  const controller = new AbortController();
  const { options, diag } = withDiagnostics({
    ...runOptions("unused", { tempDir, signal: controller.signal }),
    spawnFn,
    reapWaitMs: 30,
  });
  const run = startChild(options);
  await waitFor(() => children.length === 1 && readdirSync(tempDir).length === 1);
  controller.abort();
  const error = await settled(run.result);
  assert.ok(error instanceof AbortError, String(error));
  assert.equal(diag().outcome, "unreaped");
  assert.equal(readdirSync(tempDir).length, 1, "a child that may still be writing keeps its directory");
  children[0]?.exit(null, "SIGKILL");
  await run.dead;
  assert.deepEqual(readdirSync(tempDir), [], "removed once the leader was reaped");
});

test(
  "a directory that cannot be removed is reported and does not change the outcome",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const tempDir = mkdtempSync(join(root, "t-"));
    const reports: string[] = [];
    const { spawnFn } = fakeSpawn({
      onInput: (child) => {
        // Removing an entry needs write access to the parent: take it away, then let the child finish normally.
        chmodSync(tempDir, 0o500);
        child.writeFd3('{"t":"meta","metadata":{}}\n{"t":"text","chunk":"fine"}\n{"t":"done"}\n');
        child.exit(0, null);
        child.close();
      },
    });
    const { options, diag } = withDiagnostics({
      ...runOptions("unused", { tempDir, onTempCleanupError: (message) => reports.push(message) }),
      spawnFn,
    });
    try {
      const run = startChild(options);
      const result = await run.result;
      await run.dead;
      assert.deepEqual(result, { kind: "text", metadata: {}, text: "fine" }, "the verdict is untouched");
      assert.equal(reports.length, 1);
      assert.match(reports[0] ?? "", /Could not remove the isolated parser's temporary directory .*ripstream-call-/);
      assert.equal(diag().tempCleanupError, reports[0]);
    } finally {
      chmodSync(tempDir, 0o700);
    }
  },
);

// ---- (c) the budget -----------------------------------------------------------------------------

test("a child writing past the budget is killed promptly with the disk-budget error, and its directory is removed", async () => {
  const { tempDir, options, diag } = setup("spool", ["64", "hang"], { maxDiskMb: 5, diskPollMs: 20, deadlineMs: 20_000 });
  const started = Date.now();
  const run = startChild(options);
  const error = await settled(run.result);
  const elapsed = Date.now() - started;
  assert.ok(error instanceof LimitExceededError, String(error));
  assert.match(error.message, /temporary disk budget of 5 MiB exceeded/);
  assert.doesNotMatch(error.message, /more than \d+ files/, "a plain overrun does not blame the walk bounds");
  assert.ok(elapsed < 8000, `the kill should come long before the 20 s deadline, took ${elapsed} ms`);
  assert.equal(diag().killReason, "disk");
  assert.ok((diag().disk?.bytesAtLimit ?? 0) > 5 * MIB);
  assert.equal(diag().disk?.boundHit, false);
  await run.dead;
  assert.deepEqual(readdirSync(tempDir), []);
  assert.equal(diag().tempCleanupError, null);
  await expectGroupGone(diag().pid);
});

test("without maxDiskMb nothing is measured (the directory is still private and removed)", async () => {
  const { tempDir, options, diag } = setup("spool", ["8", "done"]);
  const run = startChild(options);
  assert.equal((await run.result).kind, "text");
  assert.equal(diag().disk, null);
  await run.dead;
  assert.deepEqual(readdirSync(tempDir), []);
});

// ---- (d) sparse files ---------------------------------------------------------------------------

test("a sparse 1 GiB file does not trip a 5 MiB budget (allocated bytes are measured, not length)", async (t) => {
  const { tempDir, options, diag } = setup("sparse", ["1", "400"], { maxDiskMb: 5, diskPollMs: 20 });
  const run = startChild(options);
  const result = await run.result;
  assert.equal(result.kind, "text");
  const allocated = Number(result.kind === "text" ? result.metadata.allocated?.[0] : Number.NaN);
  if (!(allocated < MIB)) {
    t.skip(`this filesystem allocates ${allocated} bytes for a hole`);
    return;
  }
  assert.equal(diag().killReason, null);
  assert.ok((diag().disk?.samples ?? 0) >= 3, `the hole was measured: ${JSON.stringify(diag().disk)}`);
  assert.ok((diag().disk?.peakBytes ?? Number.POSITIVE_INFINITY) < 5 * MIB);
  await run.dead;
  assert.deepEqual(readdirSync(tempDir), []);
});

// ---- (e) the walk bound -------------------------------------------------------------------------

test("more files than the walk bound is over budget however small they are", async () => {
  const { tempDir, options, diag } = setup("many-files", ["10001"], { maxDiskMb: 1024, diskPollMs: 20, deadlineMs: 30_000 });
  const run = startChild(options);
  const error = await settled(run.result);
  assert.ok(error instanceof LimitExceededError, String(error));
  assert.match(error.message, /temporary disk budget of 1024 MiB exceeded \(more than 10000 files and directories/);
  assert.equal(diag().killReason, "disk");
  assert.equal(diag().disk?.boundHit, true);
  await run.dead;
  assert.deepEqual(readdirSync(tempDir), [], "10,001 files are removed too");
});

// ---- the poll, with a fake measurement ----------------------------------------------------------

test("poll: over budget in a sample kills the group with the reason 'disk' (fake child, fake measurement)", async () => {
  const { spawnFn } = fakeSpawn();
  const { options, diag } = withDiagnostics({
    ...runOptions("unused", { deadlineMs: 5000 }),
    spawnFn,
    maxDiskMb: 5,
    diskPollMs: 5,
    reapWaitMs: 30,
    diskSampler: () => ({ bytes: 6 * MIB, entries: 3, boundHit: false }),
  });
  const error = await settled(startChild(options).result);
  assert.ok(error instanceof LimitExceededError, String(error));
  assert.match(error.message, /temporary disk budget of 5 MiB exceeded/);
  assert.equal(diag().killReason, "disk");
  assert.equal(diag().disk?.bytesAtLimit, 6 * MIB);
});

test("poll: starts at 'ready', not before, and a sample under the budget kills nothing", async () => {
  let samples = 0;
  const { spawnFn, children } = fakeSpawn({ autoReady: false });
  const { options } = withDiagnostics({
    ...runOptions("unused", { deadlineMs: 5000 }),
    spawnFn,
    maxDiskMb: 5,
    diskPollMs: 5,
    diskSampler: () => {
      samples++;
      return { bytes: MIB, entries: 1, boundHit: false };
    },
  });
  const run = startChild(options);
  await waitFor(() => children.length === 1);
  await delay(60);
  assert.equal(samples, 0, "no input has been written yet, so nothing can be on disk");
  children[0]?.writeFd3('{"t":"ready","pid":1}\n');
  await waitFor(() => samples >= 3);
  children[0]?.writeFd3('{"t":"meta","metadata":{}}\n{"t":"text","chunk":"ok"}\n{"t":"done"}\n');
  children[0]?.exit(0, null);
  children[0]?.close();
  assert.deepEqual(await run.result, { kind: "text", metadata: {}, text: "ok" });
});

test("poll: no sample is taken after the child exits", async () => {
  let samples = 0;
  const { spawnFn } = fakeSpawn({
    onInput: (child) => {
      setTimeout(() => {
        child.writeFd3('{"t":"meta","metadata":{}}\n{"t":"text","chunk":"x"}\n{"t":"done"}\n');
        child.exit(0, null);
        child.close();
      }, 60);
    },
  });
  const { options } = withDiagnostics({
    ...runOptions("unused"),
    spawnFn,
    maxDiskMb: 5,
    diskPollMs: 5,
    diskSampler: () => {
      samples++;
      return { bytes: 0, entries: 0, boundHit: false };
    },
  });
  await startChild(options).result;
  const atSettle = samples;
  assert.ok(atSettle >= 3, `the poll ticked ${atSettle} times before the exit`);
  await delay(120);
  assert.equal(samples, atSettle, "the poll kept sampling after the child exited");
});

test("options: a bad maxDiskMb or diskPollMs is refused before anything is spawned", async () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const error = await settled(startChild({ ...runOptions("echo"), maxDiskMb: bad }).result);
    assert.ok(error instanceof RangeError && /maxDiskMb/.test(error.message), `${bad}: ${String(error)}`);
  }
  const error = await settled(startChild({ ...runOptions("echo"), diskPollMs: 0 }).result);
  assert.ok(error instanceof RangeError && /diskPollMs/.test(error.message), String(error));
});
