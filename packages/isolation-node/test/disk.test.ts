import assert from "node:assert/strict";
import { chmodSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import {
  CALL_DIR_PREFIX,
  DiskPoller,
  MAX_DISK_DEPTH,
  MAX_DISK_ENTRIES,
  createCallDir,
  measureDiskUsage,
  removeCallDir,
  requireTempDir,
  type DiskUsage,
} from "../src/disk.ts";

/**
 * L6, the pure parts: how a call directory is measured (allocated bytes, bounded walk), how the poller decides, and
 * how the per-call directory is made, validated and removed. Everything here works in a directory THIS file made;
 * nothing touches the shared temp directory's contents.
 */

const MIB = 1024 * 1024;
const root = mkdtempSync(join(tmpdir(), "ripstream-disk-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function freshDir(): string {
  const dir = join(root, `d${counter++}`);
  mkdirSync(dir);
  return dir;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function writeData(path: string, bytes: number): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, Buffer.alloc(bytes, 1));
  } finally {
    closeSync(fd);
  }
}

// ---- measureDiskUsage -----------------------------------------------------------------------

test("the bounds are 10,000 entries and 8 levels", () => {
  assert.equal(MAX_DISK_ENTRIES, 10_000);
  assert.equal(MAX_DISK_DEPTH, 8);
});

test("an empty directory is zero bytes, no entries, no bound hit", async () => {
  assert.deepEqual(await measureDiskUsage(freshDir()), { bytes: 0, entries: 0, boundHit: false });
});

test("files are counted by ALLOCATED bytes, in nested directories too", async () => {
  const dir = freshDir();
  mkdirSync(join(dir, "sub"));
  writeData(join(dir, "a.bin"), MIB);
  writeData(join(dir, "sub", "b.bin"), 2 * MIB);
  const usage = await measureDiskUsage(dir);
  assert.ok(usage !== null);
  assert.equal(usage.boundHit, false);
  assert.equal(usage.entries, 3); // two files and one directory
  assert.ok(usage.bytes >= 3 * MIB && usage.bytes < 3 * MIB + 256 * 1024, `measured ${usage.bytes}`);
});

test("a sparse file counts what is allocated, not its size", async (t: TestContext) => {
  const dir = freshDir();
  const file = join(dir, "sparse.bin");
  const fd = openSync(file, "w");
  try {
    ftruncateSync(fd, 1024 * MIB);
  } finally {
    closeSync(fd);
  }
  const stats = statSync(file);
  if (stats.blocks * 512 > MIB) return t.skip("this filesystem does not keep holes");
  const usage = await measureDiskUsage(dir);
  assert.ok(usage !== null && usage.bytes < MIB, `measured ${usage?.bytes}`);
});

test("a symbolic link counts as a link: its target is neither followed nor counted", async () => {
  const outside = freshDir();
  writeData(join(outside, "big.bin"), 2 * MIB);
  const dir = freshDir();
  symlinkSync(join(outside, "big.bin"), join(dir, "link"));
  symlinkSync(outside, join(dir, "dirlink"));
  const usage = await measureDiskUsage(dir);
  assert.ok(usage !== null && usage.bytes < 64 * 1024 && !usage.boundHit, `measured ${usage?.bytes}`);
});

test("more entries than the bound: the walk stops one past it and says so", async () => {
  const dir = freshDir();
  for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}`), "");
  const usage = await measureDiskUsage(dir, { maxEntries: 20, maxDepth: 8 });
  assert.deepEqual(usage && { entries: usage.entries, boundHit: usage.boundHit }, { entries: 21, boundHit: true });
});

test("exactly as many entries as the bound is within it", async () => {
  const dir = freshDir();
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}`), "");
  const usage = await measureDiskUsage(dir, { maxEntries: 20, maxDepth: 8 });
  assert.deepEqual(usage && { entries: usage.entries, boundHit: usage.boundHit }, { entries: 20, boundHit: false });
});

test("the entry bound is for the whole tree, not per directory", async () => {
  const dir = freshDir();
  for (const name of ["a", "b", "c"]) {
    mkdirSync(join(dir, name));
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, name, `f${i}`), "");
  }
  const usage = await measureDiskUsage(dir, { maxEntries: 25, maxDepth: 8 });
  assert.equal(usage?.boundHit, true); // 33 entries in all
});

test("nesting deeper than the bound is over budget; at the bound it is not", async () => {
  const dir = freshDir();
  mkdirSync(join(dir, "a", "b", "c", "d"), { recursive: true }); // four levels below the root
  assert.equal((await measureDiskUsage(dir, { maxEntries: 100, maxDepth: 4 }))?.boundHit, false);
  assert.equal((await measureDiskUsage(dir, { maxEntries: 100, maxDepth: 3 }))?.boundHit, true);
});

test("a directory that is gone measures as empty (the call dir may be removed under the poll)", async () => {
  assert.deepEqual(await measureDiskUsage(join(root, "never-made")), { bytes: 0, entries: 0, boundHit: false });
});

// ---- DiskPoller -----------------------------------------------------------------------------------

const usage = (bytes: number, boundHit = false): DiskUsage => ({ bytes, entries: 1, boundHit });

function poller(
  samples: Array<DiskUsage | null | "throw">,
  over: Array<DiskUsage>,
  overrides: { limitMb?: number; onSample?: () => void } = {},
): { poller: DiskPoller; calls: () => number } {
  let calls = 0;
  const instance = new DiskPoller({
    dir: "/unused",
    limitMb: overrides.limitMb ?? 5,
    pollMs: 5,
    onOverLimit: (found) => over.push(found),
    sample: () => {
      calls++;
      overrides.onSample?.();
      const next = samples[Math.min(calls - 1, samples.length - 1)];
      if (next === "throw") throw new Error("walk failed");
      return next ?? null;
    },
  });
  return { poller: instance, calls: () => calls };
}

test("poller: over the limit fires once, with the offending sample, and polling stops", async () => {
  const over: DiskUsage[] = [];
  const { poller: p, calls } = poller([usage(MIB), usage(6 * MIB)], over);
  p.start();
  await delay(80);
  assert.deepEqual(over, [usage(6 * MIB)]);
  const atFire = calls();
  await delay(60);
  assert.equal(calls(), atFire, "the poller kept sampling after it fired");
  assert.deepEqual(
    { samples: p.stats().samples, peakBytes: p.stats().peakBytes, bytesAtLimit: p.stats().bytesAtLimit },
    { samples: 2, peakBytes: 6 * MIB, bytesAtLimit: 6 * MIB },
  );
});

test("poller: exactly at the limit is within it", async () => {
  const over: DiskUsage[] = [];
  const { poller: p, calls } = poller([usage(5 * MIB)], over);
  p.start();
  await delay(60);
  p.stop();
  assert.ok(calls() >= 3);
  assert.deepEqual(over, []);
});

test("poller: a hit bound is over budget whatever the bytes", async () => {
  const over: DiskUsage[] = [];
  const { poller: p } = poller([usage(0, true)], over);
  p.start();
  await delay(40);
  assert.deepEqual(over, [usage(0, true)]);
  assert.equal(p.stats().boundHit, true);
});

test("poller: a sample that could not be taken (null, or a throw) is skipped, not a verdict", async () => {
  const over: DiskUsage[] = [];
  const { poller: p, calls } = poller([null, "throw", usage(MIB)], over);
  p.start();
  await delay(80);
  p.stop();
  assert.ok(calls() >= 3);
  assert.deepEqual(over, []);
  assert.equal(p.stats().samples, calls() - 2, "only the real measurements are counted");
});

test("poller: a directory that cannot be read three samples in a row is over budget, and says why", async () => {
  const over: DiskUsage[] = [];
  const { poller: p, calls } = poller(["throw"], over);
  p.start();
  await delay(80);
  assert.equal(over.length, 1, "a call that hides its files from the walk must not run unbounded");
  assert.equal(calls(), 3, "it takes exactly three failed samples to decide");
  assert.equal(p.stats().unreadable, true);
  assert.equal(p.stats().boundHit, false);
});

test("poller: a failed sample followed by a good one resets the count", async () => {
  const over: DiskUsage[] = [];
  const { poller: p } = poller(["throw", "throw", usage(MIB), "throw", "throw", usage(MIB)], over);
  p.start();
  await delay(120);
  p.stop();
  assert.deepEqual(over, []);
  assert.equal(p.stats().unreadable, false);
});

test("poller: stop() ends sampling, and the result of a sample still in flight is ignored", async () => {
  const over: DiskUsage[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const p = new DiskPoller({
    dir: "/unused",
    limitMb: 1,
    pollMs: 5,
    onOverLimit: (found) => over.push(found),
    sample: async () => {
      calls++;
      await gate;
      return usage(100 * MIB);
    },
  });
  p.start();
  await delay(40);
  assert.equal(calls, 1);
  p.stop();
  release();
  await delay(40);
  assert.deepEqual(over, [], "a verdict arrived after stop()");
  assert.equal(calls, 1);
});

test("poller: never samples twice at once (the next wake-up is scheduled after the sample settles)", async () => {
  let running = 0;
  let overlapped = false;
  const p = new DiskPoller({
    dir: "/unused",
    limitMb: 100,
    pollMs: 1,
    onOverLimit: () => {},
    sample: async () => {
      running++;
      if (running > 1) overlapped = true;
      await delay(15);
      running--;
      return usage(0);
    },
  });
  p.start();
  await delay(120);
  p.stop();
  assert.equal(overlapped, false);
});

test("poller: its timer does not keep the process alive and is gone after stop()", async () => {
  const timeouts = (): number => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const before = timeouts();
  const { poller: p } = poller([usage(0)], []);
  p.start();
  assert.equal(timeouts(), before, "a ref'd timer would hold the process open");
  p.stop();
  assert.equal(timeouts(), before);
});

test("poller: start() twice does not run two loops", async () => {
  const { poller: p, calls } = poller([usage(0)], []);
  p.start();
  p.start();
  await delay(52);
  p.stop();
  assert.ok(calls() <= 12, `${calls()} samples in 52 ms at 5 ms: two loops were running`);
});

test("poller: the default sampler measures the directory it was given", async () => {
  const dir = freshDir();
  const over: DiskUsage[] = [];
  const p = new DiskPoller({ dir, limitMb: 1, pollMs: 5, onOverLimit: (found) => over.push(found) });
  p.start();
  await delay(30);
  assert.equal(over.length, 0);
  writeData(join(dir, "big.bin"), 3 * MIB);
  await delay(80);
  assert.equal(over.length, 1);
  assert.ok(over[0] !== undefined && over[0].bytes >= 3 * MIB);
});

// ---- the per-call directory ---------------------------------------------------------------------

test("createCallDir makes a new private (0700) directory named ripstream-call-* under tempDir", () => {
  const parent = freshDir();
  const a = createCallDir(parent);
  const b = createCallDir(parent);
  assert.notEqual(a, b);
  for (const dir of [a, b]) {
    assert.equal(dir.startsWith(join(parent, CALL_DIR_PREFIX)), true, dir);
    assert.equal(statSync(dir).isDirectory(), true);
    if (process.platform !== "win32") assert.equal(statSync(dir).mode & 0o777, 0o700);
  }
});

test("removeCallDir removes a directory tree whose subdirectories the child made unreadable", async (t: TestContext) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("permission bits do not stop win32 or root");
  const dir = createCallDir(freshDir());
  mkdirSync(join(dir, "locked", "inner"), { recursive: true });
  writeData(join(dir, "locked", "inner", "f"), MIB);
  chmodSync(join(dir, "locked", "inner"), 0o000);
  chmodSync(join(dir, "locked"), 0o000);
  chmodSync(dir, 0o000);
  await removeCallDir(dir);
  assert.throws(() => statSync(dir), { code: "ENOENT" });
});

test("removeCallDir removes a directory with files in it and is quiet about one that is already gone", async () => {
  const dir = createCallDir(freshDir());
  mkdirSync(join(dir, "x", "y"), { recursive: true });
  writeData(join(dir, "x", "y", "f"), MIB);
  await removeCallDir(dir);
  assert.throws(() => statSync(dir), { code: "ENOENT" });
  await removeCallDir(dir);
});

test("requireTempDir accepts an absolute path to an existing directory", () => {
  const dir = freshDir();
  assert.equal(requireTempDir(dir), dir);
});

test("requireTempDir: a relative path, a non-string and an empty string are TypeErrors; the message names the value", () => {
  for (const bad of ["relative/dir", "", ".", 5, null, {}]) {
    assert.throws(
      () => requireTempDir(bad),
      (error: unknown) => error instanceof TypeError && /tempDir/.test(error.message),
      String(bad),
    );
  }
  assert.throws(() => requireTempDir("relative/dir"), /absolute path, got "relative\/dir"/);
});

test("requireTempDir: a missing directory and a file are RangeErrors", () => {
  const file = join(freshDir(), "f");
  writeFileSync(file, "x");
  for (const bad of [join(root, "does-not-exist"), file]) {
    assert.throws(
      () => requireTempDir(bad),
      (error: unknown) => error instanceof RangeError && /existing directory/.test(error.message) && error.message.includes(bad),
      bad,
    );
  }
});

test("requireTempDir: a NUL byte is refused", () => {
  assert.throws(() => requireTempDir(`${root}\0x`), TypeError);
});
