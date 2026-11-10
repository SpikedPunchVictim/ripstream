import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { CheckpointStore, HttpStatusError, isTransientError, withRetry } from "../src/index.ts";

test("retries and persists checkpoints", async () => {
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts++;
    if (attempts < 3) throw new Error("transient");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);

  const directory = mkdtempSync(join(tmpdir(), "ripstream-checkpoint-"));
  try {
    const path = join(directory, "checkpoint.json");
    const store = await CheckpointStore.open(path);
    assert.equal(store.has("a"), false);
    await store.mark("a");
    const reopened = await CheckpointStore.open(path);
    assert.equal(reopened.has("a"), true);
    assert.match(readFileSync(path, "utf8"), /"a"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CheckpointStore.open on a missing file yields a fresh store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-checkpoint-"));
  try {
    const store = await CheckpointStore.open(join(directory, "missing.json"));
    assert.equal(store.size, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CheckpointStore.open rejects a corrupt non-empty checkpoint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-checkpoint-"));
  try {
    const path = join(directory, "checkpoint.json");
    writeFileSync(path, '["a", "b"');
    await assert.rejects(CheckpointStore.open(path), /Corrupt checkpoint file/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function inScratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-checkpoint-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("CheckpointStore appends one JSON string a line, in the order mark was called, however many are in flight", () =>
  inScratch(async (directory) => {
    const path = join(directory, "checkpoint.jsonl");
    const store = await CheckpointStore.open(path);
    await Promise.all(["a", "b", "line\nbreak", "c"].map((id) => store.mark(id)));
    assert.equal(readFileSync(path, "utf8"), '"a"\n"b"\n"line\\nbreak"\n"c"\n');
    assert.deepEqual(readdirSync(directory), ["checkpoint.jsonl"]);
    const reopened = await CheckpointStore.open(path);
    assert.equal(reopened.size, 4);
    assert.equal(reopened.has("line\nbreak"), true);
  }));

test("CheckpointStore.mark of an id that is there writes nothing", () =>
  inScratch(async (directory) => {
    const path = join(directory, "checkpoint.jsonl");
    const store = await CheckpointStore.open(path);
    await store.mark("a");
    await store.mark("a");
    assert.equal(readFileSync(path, "utf8"), '"a"\n');
  }));

test("CheckpointStore.mark makes the directory it is in", () =>
  inScratch(async (directory) => {
    const path = join(directory, "deeper", "still", "checkpoint.jsonl");
    await (await CheckpointStore.open(path)).mark("a");
    assert.equal((await CheckpointStore.open(path)).has("a"), true);
  }));

test("CheckpointStore.open drops a last line that was cut by a kill, and the next mark starts a line of its own", () =>
  inScratch(async (directory) => {
    const path = join(directory, "checkpoint.jsonl");
    // The process died in the middle of appending "documents/c.pdf".
    writeFileSync(path, '"documents/a.pdf"\n"documents/b.pdf"\n"documents/c.p');
    const store = await CheckpointStore.open(path);
    assert.equal(store.size, 2);
    assert.equal(store.has("documents/c.pdf"), false, "an id that may not have been recorded is run again");
    await store.mark("documents/d.pdf");
    assert.equal(readFileSync(path, "utf8"), '"documents/a.pdf"\n"documents/b.pdf"\n"documents/d.pdf"\n');
    assert.equal((await CheckpointStore.open(path)).size, 3);
  }));

test("CheckpointStore.open refuses a line in the middle that is not a JSON string, with its number", () =>
  inScratch(async (directory) => {
    const path = join(directory, "checkpoint.jsonl");
    writeFileSync(path, '"a"\nnot json\n"c"\n');
    await assert.rejects(CheckpointStore.open(path), /Corrupt checkpoint file .*line 2 is not JSON/);
    writeFileSync(path, '"a"\n42\n');
    await assert.rejects(CheckpointStore.open(path), /line 2 is not a JSON string/);
  }));

test("CheckpointStore.open refuses the JSON array an earlier version wrote, and says what it is", () =>
  inScratch(async (directory) => {
    const path = join(directory, "checkpoint.json");
    writeFileSync(path, '[\n  "a",\n  "b"\n]\n');
    await assert.rejects(CheckpointStore.open(path), /Corrupt checkpoint file .*JSON array, which an earlier version wrote/);
    writeFileSync(path, '["a", "b"]');
    await assert.rejects(CheckpointStore.open(path), /Corrupt checkpoint file .*JSON array, which an earlier version wrote/);
  }));

test("CheckpointStore.mark that cannot write rejects and leaves has() false; a later mark still works", () =>
  inScratch(async (directory) => {
    const blocker = join(directory, "a-file");
    writeFileSync(blocker, "");
    const store = new CheckpointStore(join(blocker, "checkpoint.jsonl"));
    await assert.rejects(store.mark("a"), /ENOTDIR|EEXIST/);
    assert.equal(store.has("a"), false);
    assert.equal(store.size, 0);
    // The chain of appends is not left rejected: the store recovers when the path does.
    rmSync(blocker);
    await store.mark("b");
    assert.equal(store.has("b"), true);
  }));

test("CheckpointStore.mark whose append fails (the path is a directory) is not recorded as done", () =>
  inScratch(async (directory) => {
    const store = new CheckpointStore(directory);
    await assert.rejects(store.mark("a"), /EISDIR/);
    assert.equal(store.has("a"), false, "an id that is not in the file is not done");
    assert.equal(store.size, 0);
  }));

test("withRetry: a failure retryIf refuses is thrown at once, the one it accepts is tried again", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error("permanent"); }, { attempts: 5, baseDelayMs: 1, retryIf: () => false }),
    /permanent/,
  );
  assert.equal(calls, 1);
  calls = 0;
  const result = await withRetry(
    async () => { if (++calls < 3) throw new Error("transient"); return "ok"; },
    { attempts: 5, baseDelayMs: 1, retryIf: (error) => (error as Error).message === "transient" },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry: the failure thrown after the last try is the last one", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { throw new Error(`try ${++calls}`); }, { attempts: 3, baseDelayMs: 1 }), /try 3/);
});

test("withRetry waits between half of the backoff and all of it, doubling to the cap", async (t) => {
  const waits: number[] = [];
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms: number) => { waits.push(ms); callback(); return 0 as unknown as NodeJS.Timeout; }) as unknown as typeof setTimeout);
  t.mock.method(Math, "random", () => 1);
  await assert.rejects(withRetry(async () => { throw new Error("x"); }, { attempts: 6, baseDelayMs: 10, maxDelayMs: 50 }));
  assert.deepEqual(waits, [10, 20, 40, 50, 50]);
  waits.length = 0;
  t.mock.method(Math, "random", () => 0);
  await assert.rejects(withRetry(async () => { throw new Error("x"); }, { attempts: 4, baseDelayMs: 10, maxDelayMs: 50 }));
  assert.deepEqual(waits, [5, 10, 20]);
});

test("withRetry: aborting ends the wait and throws the failure so far, without another try", async () => {
  const controller = new AbortController();
  let calls = 0;
  const started = performance.now();
  const outcome = withRetry(async () => { calls++; throw new Error(`try ${calls}`); }, { attempts: 5, baseDelayMs: 60_000, maxDelayMs: 60_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(outcome, /try 1/);
  assert.equal(calls, 1);
  assert.ok(performance.now() - started < 5_000, "the backoff did not hold the abort up");
  await assert.rejects(withRetry(async () => { calls++; throw new Error("late"); }, { signal: controller.signal }), /late/);
  assert.equal(calls, 2, "already aborted: one try and no more");
});

test("isTransientError: connections and statuses that may pass, and what will not", () => {
  const coded = (code: string): Error => Object.assign(new Error(code), { code });
  for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "EBUSY", "UND_ERR_SOCKET"]) {
    assert.equal(isTransientError(coded(code)), true, code);
  }
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isTransientError(new HttpStatusError(status, "https://example.test/x")), true, String(status));
  }
  // undici: a reset is `TypeError: fetch failed`, caused by the socket error.
  assert.equal(isTransientError(new TypeError("fetch failed", { cause: coded("ECONNRESET") })), true);
  for (const code of ["ENOENT", "EACCES", "EEXIST", "ENOTFOUND", "EISDIR"]) assert.equal(isTransientError(coded(code)), false, code);
  for (const status of [400, 401, 403, 404, 410, 501]) {
    assert.equal(isTransientError(new HttpStatusError(status, "https://example.test/x")), false, String(status));
  }
  assert.equal(isTransientError(new Error("Output already exists")), false);
  assert.equal(isTransientError("ECONNRESET"), false, "not an error");
  assert.equal(isTransientError(undefined), false);
  assert.equal(new HttpStatusError(503, "https://example.test/x").message, "Fetch failed: 503 https://example.test/x");
});
