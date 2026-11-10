import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  AbortError,
  DEFAULT_LIMITS,
  IsolationError,
  LimitExceededError,
  ParseTimeoutError,
  type IsolationConfig,
} from "@spikedpunch/ripstream-core";
import { containmentFor, type Containment } from "../src/containment.ts";
import {
  createNodeIsolator,
  missingStrictContainment,
  type NodeIsolator,
  type NodeIsolatorOptions,
} from "../src/isolator.ts";
import { deriveLimits } from "../src/limits.ts";
import { MemoryPool } from "../src/pool.ts";
import type { ProbeOptions, ProbeResult } from "../src/probe.ts";
import { DEFAULT_IN_PROCESS_MAX_BYTES } from "../src/routing.ts";
import { parentResultMb } from "../src/runner.ts";
import { fakeSpawn } from "./fixtures/fake-child.ts";
import { fakeRipstream, IN_PROCESS_TEXT, type FakeRipstream } from "./fixtures/fake-ripstream.ts";
import { CHILD, DISK_CHILD } from "./fixtures/helpers.ts";

const HEADER_CHILD = fileURLToPath(new URL("./fixtures/header-child.ts", import.meta.url));
const MIB = 1024 * 1024;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

type MutableConfig = { -readonly [K in keyof IsolationConfig]: IsolationConfig[K] };
const STRICT: IsolationConfig = { mode: "strict", perChildMb: 512, maxTaskMillis: 10_000 };

const created: NodeIsolator[] = [];
const scratch = await mkdtemp(join(tmpdir(), "ripstream-isolator-"));
after(async () => {
  await Promise.allSettled(created.map((isolator) => isolator.dispose()));
  await rm(scratch, { recursive: true, force: true });
});

async function until(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const roomyPool = (): MemoryPool => new MemoryPool({ poolMb: 16_384, overshootMb: 0, maxQueue: 4 });

interface Setup {
  readonly options: NodeIsolatorOptions;
  readonly ripstream: FakeRipstream;
  readonly logs: Array<{ level: string; message: string }>;
  readonly probeCalls: ProbeOptions[];
  /** Children started and settled. */
  runs(): number;
  create(): Promise<NodeIsolator>;
}

/** Strict isolator over fixtures/child.ts (echo) with a roomy shared pool and a probe that says "available". */
function setup(overrides: Partial<NodeIsolatorOptions> = {}): Setup {
  const ripstream = (overrides.ripstream as FakeRipstream | undefined) ?? fakeRipstream();
  const logs: Setup["logs"] = [];
  const probeCalls: ProbeOptions[] = [];
  let runs = 0;
  const platform = overrides.platform ?? process.platform;
  const options: NodeIsolatorOptions = {
    config: STRICT,
    childModule: CHILD,
    childArgs: ["echo"],
    pool: roomyPool(),
    tempDir: scratch, // fake children are never reaped, so their call directories must not land in the shared temp dir
    log: (level, message) => logs.push({ level, message }),
    probe: async (probeOptions = {}): Promise<ProbeResult> => {
      probeCalls.push(probeOptions);
      return { available: true, containment: containmentFor(platform) };
    },
    ...overrides,
    ripstream,
    runner: { onRunSettled: () => void runs++, ...overrides.runner },
  };
  return {
    options,
    ripstream,
    logs,
    probeCalls,
    runs: () => runs,
    async create() {
      const isolator = await createNodeIsolator(options);
      created.push(isolator);
      return isolator;
    },
  };
}

function isIsolationError(reason: IsolationError["reason"]): (error: unknown) => boolean {
  return (error) => error instanceof IsolationError && error.reason === reason;
}

// ---------------------------------------------------------------- mode off

test("off: a passthrough that never probes, never routes and never spawns", async () => {
  const h = setup({ config: { mode: "off" }, childModule: "not-an-absolute-path-and-never-used" });
  const isolator = await h.create();
  const result = await isolator.isolate({ input: bytes("hi"), filename: "a.zip" });
  assert.deepEqual(result, { kind: "text", metadata: { "Content-Type": ["text/plain"] }, text: IN_PROCESS_TEXT });
  assert.equal(h.probeCalls.length, 0);
  assert.equal(h.ripstream.detectCalls.length, 0);
  assert.equal(h.runs(), 0);
  assert.equal(h.ripstream.parseCalls[0]?.options.filename, "a.zip");
});

test("off: passes the caller's limits to the parse unchanged and answers records in plain form", async () => {
  const h = setup({ config: { mode: "off", maxTaskMillis: 7000 } });
  const isolator = await h.create();
  const result = await isolator.isolate({ input: bytes("hi"), output: "records", maxOutputChars: -1, maxEmbeddedResources: 5 });
  assert.equal(result.kind, "records");
  assert.deepEqual(result.records, [
    {
      metadata: { "Content-Type": ["text/plain"] },
      content: IN_PROCESS_TEXT,
      embeddedResourcePath: "/doc",
      depth: 0,
      mediaType: "text/plain",
      exception: null,
    },
  ]);
  assert.deepEqual(h.ripstream.parseRecursiveCalls[0]?.options.limits, {
    maxParseMillis: 7000,
    maxOutputChars: -1,
    maxEmbeddedResources: 5,
  });
});

test("off: status says so and has no containment, pool or limits", async () => {
  const status = (await setup({ config: { mode: "off" } }).create()).status();
  assert.equal(status.mode, "off");
  assert.equal(status.configuredMode, "off");
  assert.equal(status.degraded, false);
  assert.equal(status.degradedReason, null);
  assert.equal(status.containment, null);
  assert.equal(status.pool, null);
  assert.equal(status.limits, null);
  assert.equal(status.unreapedChildren, 0);
});

test("off: maxInputBytes is still enforced", async () => {
  const isolator = await setup({ config: { mode: "off", maxInputBytes: 10 } }).create();
  await assert.rejects(isolator.isolate({ input: bytes("12345678901") }), LimitExceededError);
});

// ---------------------------------------------------------------- construction: probe and degradation

test("strict: probes once, however many requests follow, and remembers the containment", async () => {
  const h = setup();
  const isolator = await h.create();
  assert.equal(h.probeCalls.length, 1);
  await isolator.isolate({ input: bytes("one") });
  await isolator.isolate({ input: bytes("two") });
  assert.equal(h.probeCalls.length, 1);
  assert.deepEqual(isolator.status().containment, containmentFor(process.platform));
});

test("the probe is given the derived cpu and heap limits, so refusals show up at construction", async () => {
  const h = setup({ nodePath: process.execPath });
  await h.create();
  const derived = deriveLimits(STRICT);
  assert.equal(h.probeCalls[0]?.cpuSecs, derived.cpuSecs);
  assert.equal(h.probeCalls[0]?.heapMb, derived.heapMb);
  assert.equal(h.probeCalls[0]?.nodePath, process.execPath);
  assert.equal(h.probeCalls[0]?.platform, process.platform);
});

test("strict: an unavailable probe rejects construction with unavailable, naming the reason", async () => {
  const h = setup({ probe: async () => ({ available: false, reason: "ulimit -t is refused here" }) });
  await assert.rejects(
    h.create(),
    (error: unknown) =>
      error instanceof IsolationError && error.reason === "unavailable" && error.message.includes("ulimit -t is refused here"),
  );
});

test("lenient: an unavailable probe gives a degraded in-process isolator, with a warning", async () => {
  const h = setup({
    config: { ...STRICT, mode: "lenient" },
    probe: async () => ({ available: false, reason: "no wrapper shell" }),
  });
  const isolator = await h.create();
  assert.equal(h.logs.filter((entry) => entry.level === "warn" && entry.message.includes("no wrapper shell")).length, 1);

  const status = isolator.status();
  assert.equal(status.degraded, true);
  assert.equal(status.degradedReason, "no wrapper shell");
  assert.equal(status.mode, "off", "the mode in force");
  assert.equal(status.configuredMode, "lenient");
  assert.equal(status.containment, null);
  assert.equal(status.pool, null);
});

test("lenient degraded: everything is parsed in-process, whatever its type, and nothing is spawned or detected", async () => {
  const h = setup({
    config: { ...STRICT, mode: "lenient" },
    probe: async () => ({ available: false, reason: "no wrapper shell" }),
    ripstream: fakeRipstream({ type: "application/zip" }),
  });
  const isolator = await h.create();
  const result = await isolator.isolate({ input: bytes("PK") });
  assert.equal(result.kind, "text");
  assert.equal(h.ripstream.parseCount(), 1);
  assert.equal(h.ripstream.detectCalls.length, 0);
  assert.equal(h.runs(), 0);
});

test("lenient with a working probe isolates like strict", async () => {
  const h = setup({ config: { ...STRICT, mode: "lenient" } });
  const isolator = await h.create();
  assert.equal(isolator.status().degraded, false);
  assert.equal(isolator.status().mode, "lenient");
  assert.deepEqual(await isolator.isolate({ input: bytes("in a child") }), {
    kind: "text",
    metadata: { filename: [""], path: [""], output: ["text"] },
    text: "in a child",
  });
  assert.equal(h.runs(), 1);
  assert.equal(h.ripstream.parseCount(), 0);
});

// ---------------------------------------------------------------- strict containment

const PLATFORM_FULL = (platform: NodeJS.Platform): Containment => containmentFor(platform);
const WITHOUT = (platform: NodeJS.Platform, change: Partial<Record<keyof Containment, unknown>>): Containment =>
  ({ ...containmentFor(platform), ...change }) as Containment;

test("missingStrictContainment: which layers a platform must enforce", () => {
  const cases: Array<{ name: string; platform: NodeJS.Platform; containment: Containment; missing: string[] }> = [
    { name: "linux, everything", platform: "linux", containment: PLATFORM_FULL("linux"), missing: [] },
    { name: "linux, no address-space cap", platform: "linux", containment: WITHOUT("linux", { addressSpaceCap: false }), missing: ["addressSpaceCap"] },
    { name: "linux, no cpu limit", platform: "linux", containment: WITHOUT("linux", { cpuLimit: false }), missing: ["cpuLimit"] },
    { name: "linux, no rss poll", platform: "linux", containment: WITHOUT("linux", { rssPoll: "none" }), missing: ["rssPoll"] },
    {
      name: "linux, several",
      platform: "linux",
      containment: WITHOUT("linux", { addressSpaceCap: false, cpuLimit: false }),
      missing: ["addressSpaceCap", "cpuLimit"],
    },
    { name: "darwin, as it is (weaker ps poll, no address-space cap)", platform: "darwin", containment: PLATFORM_FULL("darwin"), missing: [] },
    { name: "darwin, no rss poll", platform: "darwin", containment: WITHOUT("darwin", { rssPoll: "none" }), missing: ["rssPoll"] },
    { name: "win32, as it is (no rss poll)", platform: "win32", containment: PLATFORM_FULL("win32"), missing: ["rssPoll"] },
    { name: "no process isolation", platform: "darwin", containment: WITHOUT("darwin", { processIsolation: false }), missing: ["processIsolation"] },
    { name: "no heap limit", platform: "darwin", containment: WITHOUT("darwin", { heapLimit: false }), missing: ["heapLimit"] },
    { name: "no wall clock", platform: "darwin", containment: WITHOUT("darwin", { wallClock: false }), missing: ["wallClock"] },
  ];
  for (const { name, platform, containment, missing } of cases) {
    assert.deepEqual(missingStrictContainment(containment, platform), missing, name);
  }
});

test("requireStrictContainment: insufficient containment rejects construction with unavailable, naming the layers", async () => {
  const h = setup({
    config: { ...STRICT, requireStrictContainment: true },
    platform: "linux",
    probe: async () => ({ available: true, containment: WITHOUT("linux", { addressSpaceCap: false, cpuLimit: false }) }),
  });
  await assert.rejects(
    h.create(),
    (error: unknown) =>
      error instanceof IsolationError &&
      error.reason === "unavailable" &&
      error.message.includes("addressSpaceCap") &&
      error.message.includes("cpuLimit") &&
      !error.message.includes("rssPoll"),
  );
});

test("requireStrictContainment: sufficient containment constructs", async () => {
  const h = setup({ config: { ...STRICT, requireStrictContainment: true }, platform: "darwin" });
  const isolator = await h.create();
  assert.equal(isolator.status().requireStrictContainment, true);
});

test("without requireStrictContainment, weaker containment is accepted and reported", async () => {
  const weak = WITHOUT("linux", { addressSpaceCap: false });
  const h = setup({ platform: "linux", probe: async () => ({ available: true, containment: weak }) });
  const isolator = await h.create();
  assert.deepEqual(isolator.status().containment, weak);
});

// ---------------------------------------------------------------- construction: config and options

test("the config is snapshotted: changing it afterwards changes nothing", async () => {
  const config: MutableConfig = { mode: "strict", perChildMb: 512, maxTaskMillis: 10_000, maxInputBytes: 1000 };
  const isolator = await setup({ config }).create();
  config.maxInputBytes = 10;
  config.mode = "off";
  config.perChildMb = 99;
  assert.equal((await isolator.isolate({ input: bytes("x".repeat(500)) })).kind, "text");
  const status = isolator.status();
  assert.equal(status.mode, "strict");
  assert.equal(status.maxInputBytes, 1000);
  assert.equal(status.limits?.perChildMb, 512);
});

test("each config value is read once: a getter cannot show validation one value and the isolator another", async () => {
  let reads = 0;
  const config = {
    mode: "strict",
    perChildMb: 512,
    get maxInputBytes() {
      return reads++ === 0 ? 1000 : 10;
    },
  } as IsolationConfig;
  const isolator = await setup({ config }).create();
  assert.equal(isolator.status().maxInputBytes, 1000);
});

test("an invalid config rejects construction with RangeError and says why", async () => {
  const bad: Array<{ config: unknown; message: RegExp }> = [
    { config: { mode: "paranoid" }, message: /mode/ },
    { config: { mode: "strict", bogus: 1 }, message: /unknown key "bogus"/ },
    { config: { mode: "strict", maxInputBytes: 0 }, message: /maxInputBytes/ },
    { config: { mode: "strict", perChildMb: 512, heapMb: 512 }, message: /heap/i },
    { config: { mode: "off", perChildMb: 512, heapMb: 512 }, message: /heap/i },
    { config: null, message: /object/ },
  ];
  for (const { config, message } of bad) {
    await assert.rejects(
      setup({ config: config as IsolationConfig }).create(),
      (error: unknown) => (error instanceof RangeError || error instanceof TypeError) && message.test(error.message),
      JSON.stringify(config),
    );
  }
});

test("childModule must be an absolute path (not checked for off)", async () => {
  await assert.rejects(setup({ childModule: "child.ts" }).create(), /absolute path/);
  await assert.rejects(setup({ childModule: "" }).create(), /absolute path/);
});

test("pool: a given pool is shared and survives dispose; its settings win over the config, with a warning", async () => {
  const pool = roomyPool();
  const h = setup({ pool, config: { ...STRICT, memoryPoolMb: 5000, maxQueue: 3 } });
  const first = await h.create();
  const second = await setup({ pool }).create();
  assert.ok(h.logs.some((entry) => entry.level === "warn" && /shared memory pool/.test(entry.message)));
  assert.deepEqual(first.status().pool, pool.stats());
  assert.equal(first.status().pool?.poolMb, 16_384);

  await first.dispose();
  (await pool.acquire(10)).release(); // not disposed
  assert.equal((await second.isolate({ input: bytes("still works") })).kind, "text");
});

test("pool: a given pool too small for one child is a wiring bug (RangeError)", async () => {
  const pool = new MemoryPool({ poolMb: 600, overshootMb: 0, maxQueue: 0 });
  await assert.rejects(setup({ pool, config: { mode: "strict" } }).create(), /cannot hold one child/);
});

test("pool: a given pool whose overshoot leaves no room for one child is a wiring bug (RangeError)", async () => {
  // 1900 MiB holds a child (1536) and its result without overshoot, but every reservation also carries 1024 MiB.
  const pool = new MemoryPool({ poolMb: 1900, overshootMb: 1024, maxQueue: 0 });
  await assert.rejects(setup({ pool, config: { mode: "strict" } }).create(), /cannot hold one child.*1024 MiB overshoot/);
});

test("pool: a pool that fits the default text request but not the default records request says so in status and refuses records as a limit", async () => {
  const pool = new MemoryPool({ poolMb: 1800, overshootMb: 0, maxQueue: 0 });
  const h = setup({ pool, config: { mode: "strict" } });
  const isolator = await h.create();
  const reservation = isolator.status().defaultReservationMb;
  assert.ok(reservation !== null && reservation.text <= 1800 && reservation.records > 1800, JSON.stringify(reservation));
  assert.equal((await isolator.isolate({ input: bytes("fits") })).kind, "text");
  await assert.rejects(
    isolator.isolate({ input: bytes("a"), output: "records" }),
    (error: unknown) => error instanceof LimitExceededError && /Lower the caps or enlarge the pool/.test(error.message),
  );
  assert.equal(h.runs(), 1, "only the text request reached a child");
});

test("pool: with 1024 MiB of overshoot per reservation, a records request that only overshoot makes too big is still a LimitExceededError", async () => {
  // Defaults: text needs 2708 MiB and records 3056 MiB of this pool (both include the 1024 MiB overshoot). 2900 MiB
  // fits the first only. If the isolator's own check forgot the overshoot it would let a records request through
  // to the pool, which can never satisfy it and would call it "unavailable" (503) instead of the caller's limit.
  const pool = new MemoryPool({ poolMb: 2900, overshootMb: 1024, maxQueue: 0 });
  const isolator = await setup({ pool, config: { mode: "strict" } }).create();
  const reservation = isolator.status().defaultReservationMb;
  assert.ok(reservation !== null && reservation.text <= 2900 && reservation.records > 2900, JSON.stringify(reservation));
  assert.equal((await isolator.isolate({ input: bytes("fits") })).kind, "text");
  await assert.rejects(isolator.isolate({ input: bytes("a"), output: "records" }), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError, String(error));
    assert.match(error.message, /Lower the caps or enlarge the pool/);
    assert.doesNotMatch(error.message, /never be satisfied/);
    return true;
  });
});

test("pool: an owned pool is built from config.memoryPoolMb and reported", async () => {
  const h = setup({ config: { mode: "strict", perChildMb: 256, memoryPoolMb: 1500, maxQueue: 2 } });
  delete (h.options as { pool?: MemoryPool }).pool;
  const isolator = await createNodeIsolator(h.options);
  created.push(isolator);
  assert.equal(isolator.status().pool?.poolMb, 1500);
  assert.equal((await isolator.isolate({ input: bytes("owned") })).kind, "text");
});

test("pool: an owned pool that cannot hold one child makes isolation unavailable (strict rejects, lenient degrades)", async () => {
  const small: IsolationConfig = { mode: "strict", perChildMb: 1024, memoryPoolMb: 1100 };
  const strict = setup({ config: small });
  delete (strict.options as { pool?: MemoryPool }).pool;
  await assert.rejects(createNodeIsolator(strict.options), isIsolationError("unavailable"));

  const lenient = setup({ config: { ...small, mode: "lenient" } });
  delete (lenient.options as { pool?: MemoryPool }).pool;
  const isolator = await createNodeIsolator(lenient.options);
  created.push(isolator);
  assert.equal(isolator.status().degraded, true);
  assert.match(isolator.status().degradedReason ?? "", /cannot hold one child/);
  assert.ok(lenient.logs.some((entry) => entry.level === "warn"));
  assert.equal(lenient.probeCalls.length, 0, "no point probing when nothing could run");
});

test("with the real probe, a strict isolator constructs on this platform and runs a child", async () => {
  const h = setup();
  delete (h.options as { probe?: unknown }).probe;
  const isolator = await createNodeIsolator(h.options);
  created.push(isolator);
  assert.deepEqual(isolator.status().containment, containmentFor(process.platform));
  assert.equal((await isolator.isolate({ input: bytes("real") })).kind, "text");
});

// ---------------------------------------------------------------- routing

test("a type that is not allowlisted runs in a child, never in-process", async () => {
  const h = setup({ ripstream: fakeRipstream({ type: "application/zip" }) });
  const isolator = await h.create();
  const result = await isolator.isolate({ input: bytes("zipped"), filename: "doc.zip" });
  assert.deepEqual(result, { kind: "text", metadata: { filename: ["doc.zip"], path: [""], output: ["text"] }, text: "zipped" });
  assert.equal(h.ripstream.parseCount(), 0);
  assert.equal(h.runs(), 1);
});

test("an allowlisted type is parsed in-process, with the caller's limits and signal, and no child", async () => {
  const h = setup({ config: { ...STRICT, maxTaskMillis: 5000 }, ripstream: fakeRipstream({ type: "text/plain" }) });
  const isolator = await h.create();
  const controller = new AbortController();
  const result = await isolator.isolate(
    { input: bytes("plain"), filename: "a.txt", maxOutputChars: 777, maxEmbeddedResources: 3 },
    { signal: controller.signal },
  );
  assert.deepEqual(result, { kind: "text", metadata: { "Content-Type": ["text/plain"] }, text: IN_PROCESS_TEXT });
  assert.equal(h.runs(), 0);
  const call = h.ripstream.parseCalls[0];
  assert.deepEqual(call?.options.limits, { maxParseMillis: 5000, maxOutputChars: 777, maxEmbeddedResources: 3 });
  assert.equal(call?.options.filename, "a.txt");
  assert.equal(call?.options.signal, controller.signal);
});

test("an allowlisted type with output records is parsed in-process with parseRecursive", async () => {
  const h = setup({ ripstream: fakeRipstream({ type: "text/csv" }) });
  const result = await (await h.create()).isolate({ input: bytes("a,b"), output: "records" });
  assert.equal(result.kind, "records");
  assert.equal(h.ripstream.parseRecursiveCalls.length, 1);
  assert.equal(h.ripstream.parseCalls.length, 0);
});

test("the in-process parse uses inProcessRipstream, never the detecting one", async () => {
  const detector = fakeRipstream({ type: "text/plain" });
  const restricted = fakeRipstream({ type: "text/plain" });
  const h = setup({ ripstream: detector, inProcessRipstream: restricted });
  await (await h.create()).isolate({ input: bytes("plain") });
  assert.equal(detector.parseCount(), 0);
  assert.equal(restricted.parseCount(), 1);
  assert.equal(restricted.detectCalls.length, 0);
});

test("an in-process failure is the answer: it is not retried in a child", async () => {
  const failure = new LimitExceededError("too much text");
  const h = setup({
    ripstream: fakeRipstream({
      type: "text/plain",
      parse: () => Promise.reject(failure),
    }),
  });
  await assert.rejects((await h.create()).isolate({ input: bytes("plain") }), (error: unknown) => error === failure);
  assert.equal(h.runs(), 0);
});

test("fail closed: a detector that throws, or hangs past the timeout, sends the request to a child", async () => {
  const throwing = setup({ ripstream: fakeRipstream({ detect: () => Promise.reject(new Error("boom")) }) });
  assert.equal((await (await throwing.create()).isolate({ input: bytes("a") })).kind, "text");
  assert.equal(throwing.runs(), 1);
  assert.equal(throwing.ripstream.parseCount(), 0);

  const hanging = setup({ ripstream: fakeRipstream({ detect: () => new Promise(() => {}) }), detectTimeoutMs: 40 });
  assert.equal((await (await hanging.create()).isolate({ input: bytes("b") })).kind, "text");
  assert.equal(hanging.runs(), 1);
  assert.equal(hanging.ripstream.parseCount(), 0);
});

test("an allowlisted type above inProcessMaxBytes runs in a child", async () => {
  const h = setup({ ripstream: fakeRipstream({ type: "text/plain" }), inProcessMaxBytes: 4 });
  await (await h.create()).isolate({ input: bytes("12345") });
  assert.equal(h.runs(), 1);
  assert.equal(h.ripstream.parseCount(), 0);
  assert.equal(h.ripstream.detectCalls.length, 0);
});

test("inProcessTypes replaces the allowlist and is copied at construction", async () => {
  const types = new Set(["application/zip"]);
  const h = setup({ ripstream: fakeRipstream({ type: "application/zip" }), inProcessTypes: types });
  const isolator = await h.create();
  types.clear();
  types.add("text/plain");
  await isolator.isolate({ input: bytes("zip") });
  assert.equal(h.runs(), 0);
  assert.equal(h.ripstream.parseCount(), 1);
  assert.deepEqual(isolator.status().inProcessTypes, ["application/zip"]);
});

test("{ path } input is isolated by path: the child is told the path, no bytes cross", async () => {
  const path = join(scratch, "input.zip");
  await writeFile(path, "file content");
  const h = setup();
  const result = await (await h.create()).isolate({ input: { path }, filename: "input.zip" });
  assert.equal(result.kind, "text");
  assert.deepEqual(result.metadata.path, [path]);
});

test("records requested from a child come back as records", async () => {
  const h = setup({ childArgs: ["records"] });
  const result = await (await h.create()).isolate({ input: bytes("x"), output: "records" });
  assert.equal(result.kind, "records");
  assert.deepEqual(
    result.records.map((record) => record.content),
    ["outer", "inner"],
  );
});

// ---------------------------------------------------------------- limits

test("maxInputBytes is enforced before anything is detected, read for routing or spawned", async () => {
  const h = setup({ config: { ...STRICT, maxInputBytes: 10 } });
  const isolator = await h.create();
  await assert.rejects(isolator.isolate({ input: bytes("12345678901") }), LimitExceededError);
  assert.equal((await isolator.isolate({ input: bytes("1234567890") })).kind, "text", "exactly the limit is accepted");

  const path = join(scratch, "too-big.bin");
  await writeFile(path, "12345678901");
  await assert.rejects(isolator.isolate({ input: { path } }), LimitExceededError);
  assert.equal(h.ripstream.detectCalls.length, 1, "only the accepted request was ever detected");
  assert.equal(h.runs(), 1);
});

test("the default maxInputBytes is 100 MiB", async () => {
  assert.equal((await setup().create()).status().maxInputBytes, 100 * MIB);
});

test("an unreadable { path } is the caller's error and nothing is spawned", async () => {
  const h = setup();
  await assert.rejects(
    (await h.create()).isolate({ input: { path: join(scratch, "missing.bin") } }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  assert.equal(h.runs(), 0);
  assert.equal(h.ripstream.detectCalls.length, 0);
});

test("maxOutputChars -1 (unbounded) and absurd caps are refused as limits, for every route", async () => {
  const h = setup({ ripstream: fakeRipstream({ type: "text/plain" }) });
  const isolator = await h.create();
  await assert.rejects(isolator.isolate({ input: bytes("a"), maxOutputChars: -1 }), RangeError);
  await assert.rejects(isolator.isolate({ input: bytes("a"), maxOutputChars: 10 ** 9 }), LimitExceededError);
  assert.equal(h.ripstream.parseCount(), 0);
  assert.equal(h.runs(), 0);
});

test("a cap that would never fit the memory pool is a limit error, not an outage", async () => {
  const pool = new MemoryPool({ poolMb: 3000, overshootMb: 0, maxQueue: 0 });
  const h = setup({ pool, config: { mode: "strict" } });
  const isolator = await h.create();
  assert.doesNotThrow(() => deriveLimits({ mode: "strict" }, { maxOutputChars: 80_000_000 }));
  await assert.rejects(isolator.isolate({ input: bytes("a"), maxOutputChars: 80_000_000 }), LimitExceededError);
  assert.equal(h.runs(), 0);
  assert.equal((await isolator.isolate({ input: bytes("fits") })).kind, "text", "the default cap fits");
});

test("defaultMaxOutputChars: status, the reservation and a request without a cap are all sized for it", async () => {
  const h = setup({ childModule: HEADER_CHILD, childArgs: ["report"], defaultMaxOutputChars: 4_000_000 });
  const isolator = await h.create();
  const plain = await setup().create();
  const status = isolator.status();
  assert.equal(status.limits?.maxOutputChars, 4_000_000);
  assert.equal(plain.status().limits?.maxOutputChars, DEFAULT_LIMITS.maxOutputChars);
  assert.ok((status.defaultReservationMb?.text ?? 0) > (plain.status().defaultReservationMb?.text ?? 0), JSON.stringify(status.defaultReservationMb));

  const result = await isolator.isolate({ input: bytes("x") });
  assert.equal(result.kind, "text");
  const report = JSON.parse((result as { text: string }).text) as { header: { maxOutputChars: number } };
  assert.equal(report.header.maxOutputChars, 4_000_000);
  // A request that names its own cap keeps it.
  const own = await isolator.isolate({ input: bytes("x"), maxOutputChars: 1000 });
  assert.equal((JSON.parse((own as { text: string }).text) as { header: { maxOutputChars: number } }).header.maxOutputChars, 1000);
});

test("defaultMaxOutputChars: a request without a cap that parses in-process gets it too", async () => {
  const h = setup({ ripstream: fakeRipstream({ type: "text/plain" }), defaultMaxOutputChars: 4_000_000 });
  const isolator = await h.create();
  await isolator.isolate({ input: bytes("x") });
  assert.equal(h.ripstream.parseCalls[0]?.options.limits?.maxOutputChars, 4_000_000);
});

test("defaultMaxOutputChars: an output cap the pool cannot hold fails at construction, not on every request", async () => {
  // 3000 MiB holds the default request (2708) but not one sized for 50 million characters.
  const small: IsolationConfig = { mode: "strict", memoryPoolMb: 3000 };
  const strict = setup({ config: small, defaultMaxOutputChars: 50_000_000 });
  delete (strict.options as { pool?: MemoryPool }).pool;
  await assert.rejects(createNodeIsolator(strict.options), (error: unknown) => {
    assert.ok(error instanceof IsolationError && error.reason === "unavailable", String(error));
    assert.match(error.message, /cannot hold one child/);
    return true;
  });

  const lenient = setup({ config: { ...small, mode: "lenient" }, defaultMaxOutputChars: 50_000_000 });
  delete (lenient.options as { pool?: MemoryPool }).pool;
  const isolator = await createNodeIsolator(lenient.options);
  created.push(isolator);
  assert.equal(isolator.status().degraded, true);

  const wired = setup({ pool: new MemoryPool({ poolMb: 3000, overshootMb: 1024, maxQueue: 0 }), defaultMaxOutputChars: 50_000_000 });
  await assert.rejects(createNodeIsolator(wired.options), /cannot hold one child/);
});

test("defaultMaxOutputChars must be a finite non-negative integer", async () => {
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(setup({ defaultMaxOutputChars: value }).create(), RangeError, String(value));
  }
});

test("defaultMaxOutputChars above what a result may carry is a RangeError at construction, not a limit error", async () => {
  // A configuration mistake of whoever builds the isolator, not a document that exceeded a limit.
  await assert.rejects(setup({ defaultMaxOutputChars: 100_000_000 }).create(), (error: unknown) => {
    assert.ok(error instanceof RangeError, String(error));
    assert.match(error.message, /defaultMaxOutputChars 100000000.*above the isolation ceiling/);
    return true;
  });
});

test("defaultMaxOutputChars that fits a text result but not a records result is rejected at construction too", async () => {
  // Between roughly 86.7 and 88.1 million characters a text result fits under the ceiling and a records result does
  // not. status() derives both, so this used to build fine and then throw from every status() call.
  await assert.rejects(setup({ defaultMaxOutputChars: 87_000_000 }).create(), (error: unknown) => {
    assert.ok(error instanceof RangeError, String(error));
    assert.match(error.message, /defaultMaxOutputChars 87000000/);
    return true;
  });
});

test("defaultMaxOutputChars is validated and applied when nothing is isolated, too", async () => {
  for (const value of [-1, 1.5, Number.NaN]) {
    await assert.rejects(setup({ config: { mode: "off" }, defaultMaxOutputChars: value }).create(), RangeError, String(value));
  }
  const off = setup({ config: { mode: "off" }, ripstream: fakeRipstream({ type: "text/plain" }), defaultMaxOutputChars: 4_000_000 });
  await (await off.create()).isolate({ input: bytes("x") });
  assert.equal(off.ripstream.parseCalls[0]?.options.limits?.maxOutputChars, 4_000_000);

  const lenient = setup({
    config: { mode: "lenient", memoryPoolMb: 100 },
    ripstream: fakeRipstream({ type: "text/plain" }),
    defaultMaxOutputChars: 4_000_000,
  });
  delete (lenient.options as { pool?: MemoryPool }).pool;
  const degraded = await lenient.create();
  assert.equal(degraded.status().degraded, true);
  await degraded.isolate({ input: bytes("x") });
  assert.equal(lenient.ripstream.parseCalls[0]?.options.limits?.maxOutputChars, 4_000_000);
});

test("a pool that holds a text child but not a records child warns at construction", async () => {
  // text 2708 MiB, records 3056 MiB: 2900 runs /tika but would refuse every recursive request sent to a child.
  const between = setup({ config: { mode: "strict" }, pool: new MemoryPool({ poolMb: 2900, maxQueue: 0 }) });
  const isolator = await between.create();
  const warnings = between.logs.filter((entry) => entry.level === "warn");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? "", /2900 MiB/);
  assert.match(warnings[0]?.message ?? "", /3056 MiB/);
  assert.match(warnings[0]?.message ?? "", /recursive/i);
  assert.equal(isolator.status().degraded, false); // still isolating; only recursive requests are affected

  const roomy = setup({ config: { mode: "strict" }, pool: new MemoryPool({ poolMb: 8000, maxQueue: 0 }) });
  await roomy.create();
  assert.deepEqual(roomy.logs.filter((entry) => entry.level === "warn"), []);
});

test("the child gets the derived heap, the effective caps and a parse timer below the kill deadline", async () => {
  const h = setup({ childModule: HEADER_CHILD, childArgs: ["report"], config: { mode: "strict", maxTaskMillis: 20_000 } });
  const isolator = await h.create();
  const config: IsolationConfig = { mode: "strict", maxTaskMillis: 20_000 };

  const text = async (request: Parameters<NodeIsolator["isolate"]>[0]) => {
    const result = await isolator.isolate(request);
    assert.equal(result.kind, "text");
    return JSON.parse((result as { text: string }).text) as {
      header: { output: string; maxOutputChars: number; maxEmbeddedResources: number; maxParseMillis: number; byteLength: number };
      execArgv: string[];
    };
  };

  const defaults = deriveLimits(config);
  const first = await text({ input: bytes("x") });
  assert.equal(first.header.output, "text");
  assert.equal(first.header.maxOutputChars, DEFAULT_LIMITS.maxOutputChars);
  assert.equal(first.header.maxEmbeddedResources, DEFAULT_LIMITS.maxEmbeddedResources);
  assert.equal(first.header.maxParseMillis, defaults.maxParseMillis);
  assert.ok(first.header.maxParseMillis < 20_000);
  assert.ok(first.execArgv.includes(`--max-old-space-size=${defaults.heapMb}`), first.execArgv.join(" "));

  const bigger = deriveLimits(config, { maxOutputChars: 5_000_000 });
  assert.ok(bigger.heapMb > defaults.heapMb, "the heap grows with the output cap");
  const second = await text({ input: bytes("x"), maxOutputChars: 5_000_000, maxEmbeddedResources: 7 });
  assert.equal(second.header.maxOutputChars, 5_000_000);
  assert.equal(second.header.maxEmbeddedResources, 7);
  assert.ok(second.execArgv.includes(`--max-old-space-size=${bigger.heapMb}`), second.execArgv.join(" "));
});

test("the child is told the request's depth and parse timer, and the components of the isolator", async () => {
  const components = {
    parsers: [{ name: "default-parser", marker: true, exclude: ["pdf-parser"], mimeInclude: [], mimeExclude: [] }],
    detectors: [{ name: "default-detector", marker: true, exclude: [], mimeInclude: [], mimeExclude: [] }],
  };
  const h = setup({ childModule: HEADER_CHILD, childArgs: ["report"], config: { mode: "strict", maxTaskMillis: 20_000 }, components });
  const isolator = await h.create();
  const header = async (request: Parameters<NodeIsolator["isolate"]>[0]) =>
    (JSON.parse(((await isolator.isolate(request)) as { text: string }).text) as { header: Record<string, unknown> }).header;

  const plain = await header({ input: bytes("x") });
  assert.equal(plain.maxNodeDepth, undefined);
  assert.equal(plain.maxParseMillis, deriveLimits({ mode: "strict", maxTaskMillis: 20_000 }).maxParseMillis);
  assert.deepEqual(plain.components, components);

  const named = await header({ input: bytes("x"), maxNodeDepth: 3, maxParseMillis: 5000 });
  assert.equal(named.maxNodeDepth, 3);
  assert.equal(named.maxParseMillis, 5000);
  assert.deepEqual(named.components, components);
});

test("components too large for the request header are refused when the isolator is built, not on every request", async () => {
  const huge = { parsers: [{ name: "default-parser", marker: true, exclude: [], mimeInclude: Array.from({ length: 2000 }, (_, i) => `application/x-type-${i}`), mimeExclude: [] }] };
  await assert.rejects(
    setup({ components: huge }).create(),
    (error: unknown) => error instanceof RangeError && /components/.test(error.message) && /header/.test(error.message),
  );
  // Off mode sends no header, so there is nothing to bound.
  await setup({ config: { mode: "off" }, components: huge }).create();
});

test("an isolator with no components sends none", async () => {
  const h = setup({ childModule: HEADER_CHILD, childArgs: ["report"] });
  const result = await (await h.create()).isolate({ input: bytes("x") });
  assert.equal("components" in (JSON.parse((result as { text: string }).text) as { header: object }).header, false);
});

test("a maxParseMillis above what the isolation allows is refused for every route, in-process included", async () => {
  const config = { mode: "strict", maxTaskMillis: 10_000 } as const;
  const allowed = deriveLimits(config).maxParseMillis;
  const child = await setup({ config, ripstream: fakeRipstream({ type: "application/zip" }) }).create();
  const inProcess = await setup({ config, ripstream: fakeRipstream({ type: "text/plain" }) }).create();
  for (const isolator of [child, inProcess]) {
    await assert.rejects(
      isolator.isolate({ input: bytes("x"), maxParseMillis: allowed + 1 }),
      (error: unknown) => error instanceof RangeError && /maxTaskMillis/.test(error.message),
    );
    await isolator.isolate({ input: bytes("x"), maxParseMillis: allowed });
  }
});

test("an allowlisted type is parsed in-process with the request's depth and parse timer", async () => {
  const h = setup({ config: { ...STRICT, maxTaskMillis: 5000 }, ripstream: fakeRipstream({ type: "text/plain" }) });
  await (await h.create()).isolate({ input: bytes("plain"), maxNodeDepth: 2, maxParseMillis: 1500 });
  assert.deepEqual(h.ripstream.parseCalls[0]?.options.limits, { maxParseMillis: 1500, maxNodeDepth: 2 });
});

test("off: the request's depth and parse timer reach the parse unchanged", async () => {
  const h = setup({ config: { mode: "off", maxTaskMillis: 7000 } });
  await (await h.create()).isolate({ input: bytes("hi"), maxNodeDepth: 4, maxParseMillis: 99_000 });
  assert.deepEqual(h.ripstream.parseCalls[0]?.options.limits, { maxParseMillis: 99_000, maxNodeDepth: 4 });
});

test("a request with an invalid maxNodeDepth is refused", async () => {
  const isolator = await setup({ ripstream: fakeRipstream({ type: "application/zip" }) }).create();
  for (const bad of [-1, 1.5, Number.NaN]) {
    await assert.rejects(isolator.isolate({ input: bytes("x"), maxNodeDepth: bad }), /maxNodeDepth/, String(bad));
  }
});

test("a configured heapMb is used as given", async () => {
  const h = setup({ childModule: HEADER_CHILD, childArgs: ["report"], config: { mode: "strict", perChildMb: 1024, heapMb: 300 } });
  const result = await (await h.create()).isolate({ input: bytes("x"), maxOutputChars: 5_000_000 });
  const report = JSON.parse((result as { text: string }).text) as { execArgv: string[] };
  assert.ok(report.execArgv.includes("--max-old-space-size=300"), report.execArgv.join(" "));
});

test("records output reaches the child as records", async () => {
  const h = setup({ childModule: HEADER_CHILD, childArgs: ["report"] });
  const result = await (await h.create()).isolate({ input: bytes("x"), output: "records" });
  assert.equal(result.kind, "records");
  const record = result.records[0];
  assert.equal((JSON.parse(record?.content ?? "{}") as { header: { output: string } }).header.output, "records");
});

// ---------------------------------------------------------------- no per-call fallback

test("no per-call fallback: a child that keeps failing never makes the parent parse the bytes", async () => {
  const attempts = [
    { mode: "strict" as const, childModule: CHILD, childArgs: ["exit-without-terminal"], reason: "crash" as const },
    // Dies before it is ready: "unavailable", still an error of this call.
    { mode: "lenient" as const, childModule: join(scratch, "does-not-exist.ts"), childArgs: [], reason: "unavailable" as const },
  ];
  for (const attempt of attempts) {
    const h = setup({
      config: { ...STRICT, mode: attempt.mode },
      childModule: attempt.childModule,
      childArgs: attempt.childArgs,
      ripstream: fakeRipstream({ type: "application/zip" }),
    });
    const isolator = await h.create();
    for (let i = 0; i < 3; i++) {
      await assert.rejects(isolator.isolate({ input: bytes("hostile") }), isIsolationError(attempt.reason), `${attempt.mode} attempt ${i}`);
    }
    assert.equal(h.ripstream.parseCount(), 0, `${attempt.mode}: ripstream.parse was called`);
    assert.equal(h.runs(), 3);
    assert.equal(isolator.status().unreapedChildren, 0);
  }
});

test("no per-call fallback: a spawn that throws is the error of that call", async () => {
  const failure = new Error("spawn EAGAIN");
  const h = setup({
    ripstream: fakeRipstream({ type: "application/zip" }),
    runner: {
      spawnFn: () => {
        throw failure;
      },
    },
  });
  const isolator = await h.create();
  await assert.rejects(isolator.isolate({ input: bytes("hostile") }));
  await assert.rejects(isolator.isolate({ input: bytes("hostile") }));
  assert.equal(h.ripstream.parseCount(), 0);
});

test("no per-call fallback: a full queue is queue_full, not an in-process parse", async () => {
  const need = 512 + parentResultMb(deriveLimits(STRICT).maxResultBytes, "text");
  const pool = new MemoryPool({ poolMb: need + 100, overshootMb: 0, maxQueue: 0 });
  const hanging = setup({ pool, childArgs: ["hang"] });
  const other = setup({ pool, ripstream: fakeRipstream({ type: "application/zip" }) });
  const holder = await hanging.create();
  const isolator = await other.create();

  const controller = new AbortController();
  const held = holder.isolate({ input: bytes("held") }, { signal: controller.signal });
  await until(() => pool.stats().running === 1, "the first child to hold the pool");
  await assert.rejects(isolator.isolate({ input: bytes("shed") }), isIsolationError("queue_full"));
  assert.equal(other.ripstream.parseCount(), 0);

  controller.abort();
  await assert.rejects(held, AbortError);
});

test("a shared pool is contended across isolators: one waits for the other, a third is shed", async () => {
  const need = 512 + parentResultMb(deriveLimits(STRICT).maxResultBytes, "text");
  const pool = new MemoryPool({ poolMb: need + 100, overshootMb: 0, maxQueue: 1 });
  const holder = await setup({ pool, childArgs: ["hang"] }).create();
  const waiting = await setup({ pool }).create();

  const controller = new AbortController();
  const held = holder.isolate({ input: bytes("held") }, { signal: controller.signal });
  await until(() => pool.stats().running === 1, "the first child to hold the pool");
  const queued = waiting.isolate({ input: bytes("queued") });
  await until(() => pool.stats().queued === 1, "the second request to queue");
  await assert.rejects(waiting.isolate({ input: bytes("shed") }), isIsolationError("queue_full"));

  controller.abort();
  await assert.rejects(held, AbortError);
  assert.equal(((await queued) as { text: string }).text, "queued");
});

// ---------------------------------------------------------------- abort, timeout, dispose

test("a signal that is already aborted ends the call before anything happens", async () => {
  const h = setup();
  const isolator = await h.create();
  await assert.rejects(isolator.isolate({ input: bytes("a") }, { signal: AbortSignal.abort() }), AbortError);
  await assert.rejects(
    isolator.isolate({ input: bytes("a") }, { signal: AbortSignal.abort(new DOMException("too slow", "TimeoutError")) }),
    ParseTimeoutError,
  );
  const timeout = new ParseTimeoutError("deadline");
  await assert.rejects(
    isolator.isolate({ input: bytes("a") }, { signal: AbortSignal.abort(timeout) }),
    (error: unknown) => error === timeout,
  );
  assert.equal(h.ripstream.detectCalls.length, 0);
  assert.equal(h.runs(), 0);
});

test("aborting while a child runs is AbortError, and a timeout signal is ParseTimeoutError", async () => {
  const h = setup({ childArgs: ["hang"] });
  const isolator = await h.create();
  const controller = new AbortController();
  const aborted = isolator.isolate({ input: bytes("a") }, { signal: controller.signal });
  await until(() => h.options.pool?.stats().running === 1, "the child to start");
  controller.abort();
  await assert.rejects(aborted, AbortError);

  await assert.rejects(isolator.isolate({ input: bytes("a") }, { signal: AbortSignal.timeout(300) }), ParseTimeoutError);
  await until(() => h.options.pool?.stats().running === 0, "the pool to be returned");
});

test("aborting an in-process parse is AbortError, whatever the parser threw", async () => {
  const h = setup({
    ripstream: fakeRipstream({
      type: "text/plain",
      parse: (_source, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("parser noticed")), { once: true });
        }),
    }),
  });
  const controller = new AbortController();
  const pending = (await h.create()).isolate({ input: bytes("a") }, { signal: controller.signal });
  await until(() => h.ripstream.parseCalls.length === 1, "the parse to start");
  controller.abort();
  await assert.rejects(pending, AbortError);
});

test("the wall-clock budget ends a stuck child with ParseTimeoutError", async () => {
  const h = setup({ childArgs: ["hang"], config: { ...STRICT, maxTaskMillis: 500 } });
  const isolator = await h.create();
  await assert.rejects(isolator.isolate({ input: bytes("a") }), ParseTimeoutError);
  assert.equal(h.ripstream.parseCount(), 0);
});

test("dispose is idempotent, concurrent-safe and the isolator is unavailable afterwards", async () => {
  const h = setup();
  const isolator = await h.create();
  await isolator.isolate({ input: bytes("a") });
  await Promise.all([isolator.dispose(), isolator.dispose()]);
  await isolator.dispose();
  assert.equal(isolator.status().disposed, true);
  await assert.rejects(isolator.isolate({ input: bytes("b") }), isIsolationError("unavailable"));
  assert.equal(h.ripstream.parseCount(), 0, "disposed does not mean 'parse it here'");
});

test("dispose kills a running child, rejects its caller and returns the pool", async () => {
  const pool = roomyPool();
  const h = setup({ pool, childArgs: ["hang"] });
  const isolator = await h.create();
  const running = isolator.isolate({ input: bytes("a") });
  await until(() => pool.stats().running === 1, "the child to start");
  await isolator.dispose();
  await assert.rejects(running, IsolationError);
  assert.equal(pool.stats().running, 0);
  assert.equal(isolator.status().unreapedChildren, 0);
});

test("dispose of an off isolator is idempotent and later calls are refused", async () => {
  const isolator = await setup({ config: { mode: "off" } }).create();
  await isolator.dispose();
  await isolator.dispose();
  await assert.rejects(isolator.isolate({ input: bytes("a") }), isIsolationError("unavailable"));
});

// ---------------------------------------------------------------- request validation and status

test("a malformed request is a TypeError, before anything else", async () => {
  const h = setup();
  const isolator = await h.create();
  for (const request of [
    null,
    {},
    { input: "text" },
    { input: { path: "" } },
    { input: bytes("a"), output: "xml" },
    { input: bytes("a"), filename: 5 },
  ]) {
    await assert.rejects(isolator.isolate(request as never), TypeError, JSON.stringify(request));
  }
  assert.equal(h.ripstream.detectCalls.length, 0);
});

test("status is plain JSON and describes what is in force", async () => {
  const pool = roomyPool();
  const h = setup({ pool, config: { ...STRICT, requireStrictContainment: true }, platform: "darwin" });
  const isolator = await h.create();
  const status = isolator.status();
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
  assert.equal(status.mode, "strict");
  assert.equal(status.configuredMode, "strict");
  assert.equal(status.degraded, false);
  assert.equal(status.degradedReason, null);
  assert.equal(status.disposed, false);
  assert.equal(status.requireStrictContainment, true);
  assert.deepEqual(status.containment, containmentFor("darwin"));
  assert.deepEqual(status.pool, pool.stats());
  assert.equal(status.unreapedChildren, 0);
  assert.deepEqual(status.limits, deriveLimits(STRICT));
  assert.equal(status.inProcessMaxBytes, DEFAULT_IN_PROCESS_MAX_BYTES);
  assert.ok(status.inProcessTypes.includes("text/plain"));
  assert.ok(!status.inProcessTypes.includes("application/pdf"));
});

test("status is a copy: changing it changes nothing", async () => {
  const isolator = await setup().create();
  const status = isolator.status() as { containment: { rssPoll: string } | null; limits: { heapMb: number } | null };
  if (status.containment !== null) status.containment.rssPoll = "none";
  if (status.limits !== null) status.limits.heapMb = 1;
  assert.deepEqual(isolator.status().containment, containmentFor(process.platform));
  assert.equal(isolator.status().limits?.heapMb, deriveLimits(STRICT).heapMb);
});

// ---------------------------------------------------------------- disk (L6)

const diskScratch = (): string => mkdtempSync(join(scratch, "disk-"));

test("status().limits reports the disk budget: 1024 MiB by default, the configured one when set", async () => {
  assert.equal((await setup().create()).status().limits?.maxDiskMb, 1024);
  const isolator = await setup({ config: { ...STRICT, maxDiskMb: 7 } }).create();
  assert.equal(isolator.status().limits?.maxDiskMb, 7);
});

test("config.maxDiskMb must be a positive integer of MiB; the error names the key", async () => {
  for (const bad of [0, -5, 1.5, Number.NaN]) {
    await assert.rejects(setup({ config: { ...STRICT, maxDiskMb: bad } }).create(), /maxDiskMb/, String(bad));
  }
});

test("tempDir: an absolute path to an existing directory, handed to the probe too; anything else fails construction", async () => {
  await assert.rejects(setup({ tempDir: "relative/dir" }).create(), (error: unknown) => {
    return error instanceof TypeError && /tempDir must be an absolute path/.test(error.message);
  });
  await assert.rejects(setup({ tempDir: join(scratch, "missing") }).create(), (error: unknown) => {
    return error instanceof RangeError && /tempDir must be an existing directory/.test(error.message);
  });
  const tempDir = diskScratch();
  const h = setup({ tempDir });
  await h.create();
  assert.equal(h.probeCalls[0]?.tempDir, tempDir);
});

test("a document that makes the child write past the disk budget is a LimitExceededError naming it, and nothing is left behind", async () => {
  const tempDir = diskScratch();
  const h = setup({
    childModule: DISK_CHILD,
    childArgs: ["spool", "64", "hang"],
    tempDir,
    config: { ...STRICT, maxDiskMb: 5 },
    runner: { diskPollMs: 20 },
  });
  const isolator = await h.create();
  await assert.rejects(isolator.isolate({ input: bytes("hostile") }), (error: unknown) => {
    return error instanceof LimitExceededError && /temporary disk budget of 5 MiB exceeded/.test(error.message);
  });
  await isolator.dispose();
  assert.deepEqual(readdirSync(tempDir), []);
  assert.equal(isolator.status().unreapedChildren, 0);
});

test(
  "a call directory that cannot be removed is logged as a warning and the call still answers",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const tempDir = diskScratch();
    const { spawnFn } = fakeSpawn({
      onInput: (child) => {
        // Removing an entry needs write access to the parent: take it away, then let the child finish normally.
        chmodSync(tempDir, 0o500);
        child.writeFd3('{"t":"meta","metadata":{}}\n{"t":"text","chunk":"fine"}\n{"t":"done"}\n');
        child.exit(0, null);
        child.close();
      },
    });
    const h = setup({ tempDir, runner: { spawnFn } });
    const isolator = await h.create();
    try {
      assert.deepEqual(await isolator.isolate({ input: bytes("x") }), { kind: "text", metadata: {}, text: "fine" });
      const warnings = h.logs.filter((entry) => entry.level === "warn" && /Could not remove the isolated parser's temporary directory/.test(entry.message));
      assert.equal(warnings.length, 1, JSON.stringify(h.logs));
    } finally {
      chmodSync(tempDir, 0o700);
    }
  },
);
