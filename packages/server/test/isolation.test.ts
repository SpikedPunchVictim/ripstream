import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createIsolatedRipstream,
  IsolationError,
  LimitExceededError,
  MediaType,
  Metadata,
  type InputSource,
  type ParseOptions,
  type ParseRecord,
} from "@spikedpunch/ripstream-core";
import { createNodeIsolator, MemoryPool, type IsolatorRipstream } from "@spikedpunch/ripstream-isolation-node";
import {
  createRipstreamServer,
  type RipstreamServerOptions,
  type ServerIsolation,
  type ServerIsolationStatus,
  type ServerRipstream,
} from "../src/index.ts";

// ---- fakes ---------------------------------------------------------------------------------------

type Method = "detect" | "parse" | "parseRecursive";

interface Call {
  readonly method: Method;
  readonly filename: string | undefined;
  readonly limits: unknown;
  readonly bytes: number | undefined;
}

interface FakeEngine extends ServerRipstream {
  readonly calls: Call[];
}

/** Which failure the fake engine throws for a filename: how the tests make an isolated engine fail. */
const FAILURES: Readonly<Record<string, () => Error>> = {
  "queue_full.txt": () => new IsolationError("queue_full", "The memory pool queue is full"),
  "unavailable.txt": () => new IsolationError("unavailable", "Isolation is unavailable"),
  "crash.txt": () => new IsolationError("crash", "The child crashed"),
  "limit.txt": () => new LimitExceededError("Output exceeds the cap"),
};

/** An engine that records what the server asked of it. `onCall` runs first and may hold the call open. */
function fakeEngine(onCall: (call: Call) => Promise<void> | void = () => undefined): FakeEngine {
  const calls: Call[] = [];
  const enter = async (method: Method, source: InputSource | null, options: ParseOptions | undefined): Promise<void> => {
    const call: Call = {
      method,
      filename: options?.filename,
      limits: options?.limits,
      bytes: source instanceof Uint8Array ? source.length : undefined,
    };
    calls.push(call);
    await onCall(call);
    const fail = FAILURES[options?.filename ?? ""];
    if (fail !== undefined) throw fail();
  };
  const metadata = (): Metadata => {
    const value = new Metadata();
    value.set("Content-Type", "text/plain");
    return value;
  };
  return {
    calls,
    async detect(source, options) {
      await enter("detect", source, options);
      return MediaType.TEXT_PLAIN;
    },
    async parse(source, options) {
      await enter("parse", source, options);
      return { metadata: metadata(), text: "fake text" };
    },
    async parseRecursive(source, options) {
      await enter("parseRecursive", source, options);
      const record: ParseRecord = {
        metadata: metadata(),
        content: "fake text",
        embeddedResourcePath: "/",
        depth: 0,
        mediaType: MediaType.TEXT_PLAIN,
        exception: null,
      };
      return [record];
    },
  };
}

/** What a real NodeIsolatorStatus carries beyond the structural type: `/status` must pass it through untouched. */
interface FakeStatus extends ServerIsolationStatus {
  readonly degradedReason: string | null;
  readonly unreapedChildren: number;
}

const ACTIVE: FakeStatus = {
  mode: "strict",
  degraded: false,
  degradedReason: null,
  pool: { poolMb: 4096, maxQueue: 4 },
  defaultReservationMb: { text: 1024, records: 2048 },
  unreapedChildren: 0,
};

function fakeIsolation(overrides: Partial<FakeStatus> = {}): ServerIsolation {
  const status: FakeStatus = { ...ACTIVE, ...overrides };
  return { status: () => status };
}

function collectLog(): {
  readonly log: (level: "info" | "warn", message: string) => void;
  readonly warnings: string[];
} {
  const warnings: string[] = [];
  return {
    warnings,
    log: (level, message) => {
      if (level === "warn") warnings.push(message);
    },
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withServer<T>(options: RipstreamServerOptions, run: (base: string) => Promise<T>): Promise<T> {
  const instance = createRipstreamServer({ log: () => undefined, ...options });
  const port = await instance.listen();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await instance.close();
  }
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the condition");
}

interface StatusBody {
  status: string;
  active: number;
  queued: number;
  gate: { maxConcurrent: number; maxQueue: number };
  isolation: unknown;
}

async function readStatus(base: string): Promise<StatusBody> {
  return (await (await fetch(`${base}/status`)).json()) as StatusBody;
}

/** A PUT that announces 1 MiB but sends 7 bytes and never finishes: it can only be answered if the server did not wait for the body. */
function sendUnfinishedBody(base: string): Promise<{ status: number; retryAfter: string | undefined; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: url.hostname, port: url.port, method: "PUT", path: "/tika", headers: { "content-length": "1048576" } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            retryAfter: response.headers["retry-after"],
            body: Buffer.concat(chunks).toString("utf8"),
          });
          outgoing.destroy();
        });
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.write("partial");
  });
}

// ---- 1. fail closed ------------------------------------------------------------------------------

test("fails closed: no ripstream, no server", () => {
  for (const make of [() => createRipstreamServer(), () => createRipstreamServer({}), () => createRipstreamServer({ log: () => undefined })]) {
    assert.throws(make, (error: Error) => {
      assert.match(error.message, /createStandardIsolation/);
      assert.match(error.message, /@spikedpunch\/ripstream-bundle-standard\/isolation/);
      assert.match(error.message, /createRipstream\(\)/);
      assert.match(error.message, /isolation/i);
      return true;
    });
  }
});

test("the pipes option still requires authenticate", () => {
  assert.throws(() => createRipstreamServer({ ripstream: fakeEngine(), pipes: { sourceRoot: "." } }), /authenticate/);
});

// ---- 3. startup warnings -------------------------------------------------------------------------

test("warns once, at construction, that isolation is off when no isolation handle is given", async () => {
  const { log, warnings } = collectLog();
  await withServer({ ripstream: fakeEngine(), log }, async (base) => {
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /isolation is off/i);
    assert.match(warnings[0] ?? "", /server process/);
    for (let i = 0; i < 3; i++) await fetch(`${base}/tika`, { method: "PUT", body: "x" });
    await fetch(`${base}/status`);
    assert.equal(warnings.length, 1, "no warning per request");
  });
});

test("the default log writes warnings to console.warn", (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  createRipstreamServer({ ripstream: fakeEngine() });
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /isolation is off/i);
});

test("a healthy strict isolation handle warns about nothing", async () => {
  const { log, warnings } = collectLog();
  await withServer({ ripstream: fakeEngine(), isolation: fakeIsolation(), maxLimits: { maxOutputChars: 1000 }, log }, async (base) => {
    await fetch(`${base}/tika`, { method: "PUT", body: "x" });
    assert.deepEqual(warnings, []);
  });
});

test("warns once when the isolation mode is lenient or off", () => {
  const lenient = collectLog();
  createRipstreamServer({
    ripstream: fakeEngine(),
    isolation: fakeIsolation({ mode: "lenient" }),
    maxLimits: { maxOutputChars: 1000 },
    log: lenient.log,
  });
  assert.equal(lenient.warnings.length, 1);
  assert.match(lenient.warnings[0] ?? "", /lenient/);

  const off = collectLog();
  createRipstreamServer({
    ripstream: fakeEngine(),
    isolation: fakeIsolation({ mode: "off", pool: null, defaultReservationMb: null }),
    log: off.log,
  });
  assert.equal(off.warnings.length, 1);
  assert.match(off.warnings[0] ?? "", /"off"/);
});

test("warns once with the reason when the isolation handle is degraded", () => {
  const strictButDegraded = collectLog();
  createRipstreamServer({
    ripstream: fakeEngine(),
    isolation: fakeIsolation({ degraded: true, degradedReason: "the probe child could not start" }),
    maxLimits: { maxOutputChars: 1000 },
    log: strictButDegraded.log,
  });
  assert.equal(strictButDegraded.warnings.length, 1);
  assert.match(strictButDegraded.warnings[0] ?? "", /degraded/i);
  assert.match(strictButDegraded.warnings[0] ?? "", /the probe child could not start/);

  // What a lenient NodeIsolator that found no isolation reports: mode "off" AND degraded; each condition warns once.
  const lenientDegraded = collectLog();
  createRipstreamServer({
    ripstream: fakeEngine(),
    isolation: fakeIsolation({ mode: "off", degraded: true, degradedReason: "no cgroup", pool: null, defaultReservationMb: null }),
    log: lenientDegraded.log,
  });
  assert.equal(lenientDegraded.warnings.length, 2);
  assert.equal(lenientDegraded.warnings.filter((w) => w.includes("no cgroup")).length, 1);
});

test("a degraded handle without a reason string still warns", () => {
  const { log, warnings } = collectLog();
  const status = { ...ACTIVE, degraded: true } as Record<string, unknown>;
  delete status.degradedReason;
  createRipstreamServer({
    ripstream: fakeEngine(),
    isolation: { status: () => status as unknown as ServerIsolationStatus },
    maxLimits: { maxOutputChars: 1000 },
    log,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /degraded/i);
});

// ---- 4. the output ceiling -----------------------------------------------------------------------

test("an active isolation handle requires a maxOutputChars ceiling", () => {
  const make = (maxLimits?: RipstreamServerOptions["maxLimits"]) => () =>
    createRipstreamServer({
      ripstream: fakeEngine(),
      isolation: fakeIsolation(),
      log: () => undefined,
      ...(maxLimits === undefined ? {} : { maxLimits }),
    });
  assert.throws(make(), /maxLimits\.maxOutputChars/);
  assert.throws(make({ maxEmbeddedResources: 5 }), /maxLimits\.maxOutputChars/);
  assert.doesNotThrow(make({ maxOutputChars: 1000 }));
});

test("warns when the ceiling is above what the isolator was built to cap", () => {
  const warned = (limits: { maxOutputChars: number } | undefined, ceiling: number): string[] => {
    const { log, warnings } = collectLog();
    createRipstreamServer({
      ripstream: fakeEngine(),
      isolation: fakeIsolation(limits === undefined ? {} : { limits }),
      maxLimits: { maxOutputChars: ceiling },
      log,
    });
    return warnings;
  };
  const above = warned({ maxOutputChars: 500 }, 1000);
  assert.equal(above.length, 1);
  assert.match(above[0] ?? "", /maxOutputChars/);
  assert.match(above[0] ?? "", /1000/);
  assert.match(above[0] ?? "", /500/);
  assert.deepEqual(warned({ maxOutputChars: 1000 }, 1000), []);
  assert.deepEqual(warned({ maxOutputChars: 5000 }, 1000), []);
  assert.deepEqual(warned(undefined, 1000), []); // a status that does not say what it caps cannot be checked
});

test("a degraded or off handle (no pool) does not need the ceiling", () => {
  assert.doesNotThrow(() =>
    createRipstreamServer({
      ripstream: fakeEngine(),
      isolation: fakeIsolation({ mode: "off", degraded: true, degradedReason: "x", pool: null, defaultReservationMb: null }),
      log: () => undefined,
    }),
  );
});

test("an isolated request always carries a finite, clamped maxOutputChars", async () => {
  const engine = fakeEngine();
  await withServer({ ripstream: engine, isolation: fakeIsolation(), maxLimits: { maxOutputChars: 500 } }, async (base) => {
    await fetch(`${base}/tika`, { method: "PUT", body: "x" });
    await fetch(`${base}/tika?maxOutputChars=100000`, { method: "PUT", body: "x" });
    await fetch(`${base}/tika?maxOutputChars=10`, { method: "PUT", body: "x" });
    assert.deepEqual(
      engine.calls.map((call) => call.limits),
      [{ maxOutputChars: 500 }, { maxOutputChars: 500 }, { maxOutputChars: 10 }],
    );
  });
});

// ---- 5. preset limits ----------------------------------------------------------------------------

test("when isolating, a preset may only carry the limits that cross the boundary", () => {
  const make = (limits: Record<string, number>) => () =>
    createRipstreamServer({
      ripstream: fakeEngine(),
      isolation: fakeIsolation(),
      maxLimits: { maxOutputChars: 1000 },
      presets: { fine: { limits: { maxOutputChars: 10 } }, quick: { limits } },
      log: () => undefined,
    });
  assert.doesNotThrow(make({ maxOutputChars: 10, maxEmbeddedResources: 2 }));
  assert.throws(make({ maxParseMillis: 5 }), /preset "quick".*maxParseMillis/);
  assert.throws(make({ maxOutputChars: 10, maxZipEntries: 5 }), /preset "quick".*maxZipEntries/);
});

test("without isolation a preset may carry any limit", () => {
  assert.doesNotThrow(() =>
    createRipstreamServer({
      ripstream: fakeEngine(),
      presets: { quick: { limits: { maxParseMillis: 5 } } },
      log: () => undefined,
    }),
  );
});

test("when isolating, a preset limit must be a non-negative integer", () => {
  const make = (limits: Record<string, number>) => () =>
    createRipstreamServer({
      ripstream: fakeEngine(),
      isolation: fakeIsolation(),
      maxLimits: { maxOutputChars: 1000 },
      presets: { quick: { limits } },
      log: () => undefined,
    });
  assert.doesNotThrow(make({ maxOutputChars: 0, maxEmbeddedResources: 0 }));
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(make({ maxOutputChars: bad }), /preset "quick".*maxOutputChars/);
    assert.throws(make({ maxEmbeddedResources: bad }), /preset "quick".*maxEmbeddedResources/);
  }
});

test("the preset rules apply whenever an isolation handle is given, even one that isolates nothing", () => {
  const off = fakeIsolation({ mode: "off", pool: null, defaultReservationMb: null });
  assert.throws(
    () =>
      createRipstreamServer({
        ripstream: fakeEngine(),
        isolation: off,
        presets: { quick: { limits: { maxParseMillis: 5 } } },
        log: () => undefined,
      }),
    /preset "quick".*maxParseMillis/,
  );
  // ...but the output ceiling is only required when something is actually isolated.
  assert.doesNotThrow(() => createRipstreamServer({ ripstream: fakeEngine(), isolation: off, log: () => undefined }));
});

test("maxConcurrent must be a positive integer and maxQueue a non-negative one", () => {
  const make = (extra: Pick<RipstreamServerOptions, "maxConcurrent" | "maxQueue">) => () =>
    createRipstreamServer({ ripstream: fakeEngine(), log: () => undefined, ...extra });
  assert.doesNotThrow(make({ maxConcurrent: 1, maxQueue: 0 }));
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(make({ maxConcurrent: bad }), /maxConcurrent/);
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(make({ maxQueue: bad }), /maxQueue/);
});

// ---- 6. one gate ---------------------------------------------------------------------------------

test("the gate is derived from the memory pool when the caller sets neither number", async () => {
  // The dearer reservation (records, 2048) sizes it: floor(4096 / 2048) + 4 = 6 running-or-pool-queued requests;
  // nothing waits in the server.
  await withServer({ ripstream: fakeEngine(), isolation: fakeIsolation(), maxLimits: { maxOutputChars: 1000 } }, async (base) => {
    assert.deepEqual((await readStatus(base)).gate, { maxConcurrent: 6, maxQueue: 0 });
  });
});

test("the derived gate rounds the pool down and never falls below one running request", async () => {
  const gate = async (pool: { poolMb: number; maxQueue: number }, text: number): Promise<unknown> =>
    withServer(
      {
        ripstream: fakeEngine(),
        isolation: fakeIsolation({ pool, defaultReservationMb: { text, records: text * 2 } }),
        maxLimits: { maxOutputChars: 1000 },
      },
      async (base) => (await readStatus(base)).gate,
    );
  assert.deepEqual(await gate({ poolMb: 5000, maxQueue: 0 }, 1024), { maxConcurrent: 2, maxQueue: 0 });
  assert.deepEqual(await gate({ poolMb: 512, maxQueue: 2 }, 1024), { maxConcurrent: 3, maxQueue: 0 });
});

test("explicit gate options win, each independently of the other", async () => {
  const gate = async (extra: Pick<RipstreamServerOptions, "maxConcurrent" | "maxQueue">): Promise<unknown> =>
    withServer(
      { ripstream: fakeEngine(), isolation: fakeIsolation(), maxLimits: { maxOutputChars: 1000 }, ...extra },
      async (base) => (await readStatus(base)).gate,
    );
  assert.deepEqual(await gate({ maxConcurrent: 3 }), { maxConcurrent: 3, maxQueue: 0 });
  assert.deepEqual(await gate({ maxQueue: 5 }), { maxConcurrent: 6, maxQueue: 5 });
  assert.deepEqual(await gate({ maxConcurrent: 3, maxQueue: 5 }), { maxConcurrent: 3, maxQueue: 5 });
});

test("the old gate defaults apply without isolation, or when the reservation is unknown", async () => {
  await withServer({ ripstream: fakeEngine() }, async (base) => {
    assert.deepEqual((await readStatus(base)).gate, { maxConcurrent: 100, maxQueue: 100 });
  });
  await withServer(
    { ripstream: fakeEngine(), isolation: fakeIsolation({ defaultReservationMb: null }), maxLimits: { maxOutputChars: 1000 } },
    async (base) => {
      assert.deepEqual((await readStatus(base)).gate, { maxConcurrent: 100, maxQueue: 100 });
    },
  );
});

test("a pool status without maxQueue is treated as an empty pool queue", async () => {
  // NodeIsolatorStatus.pool is PoolStats today, which has no maxQueue: never derive NaN from it.
  const status = { ...ACTIVE, pool: { poolMb: 4096 } } as unknown as ServerIsolationStatus;
  await withServer(
    { ripstream: fakeEngine(), isolation: { status: () => status }, maxLimits: { maxOutputChars: 1000 } },
    async (base) => {
      assert.deepEqual((await readStatus(base)).gate, { maxConcurrent: 2, maxQueue: 0 });
    },
  );
});

test("the gate is sized by the dearer of the text and records reservations", async () => {
  const gate = async (defaultReservationMb: { text: number; records: number }): Promise<unknown> =>
    withServer(
      {
        ripstream: fakeEngine(),
        isolation: fakeIsolation({ pool: { poolMb: 12_000, maxQueue: 1 }, defaultReservationMb }),
        maxLimits: { maxOutputChars: 1000 },
      },
      async (base) => (await readStatus(base)).gate,
    );
  assert.deepEqual(await gate({ text: 2000, records: 3000 }), { maxConcurrent: 5, maxQueue: 0 }); // 12000 / 3000 + 1
  assert.deepEqual(await gate({ text: 3000, records: 2000 }), { maxConcurrent: 5, maxQueue: 0 }); // never the smaller one
});

test("a full derived gate refuses with 503 before the body is read, and says when to retry", async () => {
  const release = deferred();
  const started = deferred();
  const engine = fakeEngine(async (call) => {
    if (call.method !== "parse") return;
    started.resolve();
    await release.promise;
  });
  // floor(1024 / 1024) + 0 = one request at a time, none waiting.
  const isolation = fakeIsolation({ pool: { poolMb: 1024, maxQueue: 0 } });
  await withServer({ ripstream: engine, isolation, maxLimits: { maxOutputChars: 1000 } }, async (base) => {
    const first = fetch(`${base}/tika`, { method: "PUT", body: "first" });
    await started.promise;
    assert.equal(engine.calls.length, 1);

    const refused = await sendUnfinishedBody(base);
    assert.equal(refused.status, 503);
    assert.equal(refused.retryAfter, "1");
    assert.match(refused.body, /Server queue is full/);
    assert.equal(engine.calls.length, 1, "the refused request never reached the engine");

    release.resolve();
    const done = await first;
    assert.equal(done.status, 200);
    assert.equal(await done.text(), "fake text");
  });
});

test("the server's own full queue (old explicit gate) also says Retry-After: 1", async () => {
  const release = deferred();
  const started = deferred();
  const engine = fakeEngine(async () => {
    started.resolve();
    await release.promise;
  });
  await withServer({ ripstream: engine, maxConcurrent: 1, maxQueue: 0 }, async (base) => {
    const first = fetch(`${base}/tika`, { method: "PUT", body: "first" });
    await started.promise;
    const second = await fetch(`${base}/tika`, { method: "PUT", body: "second" });
    assert.equal(second.status, 503);
    assert.equal(second.headers.get("retry-after"), "1");
    release.resolve();
    assert.equal((await first).status, 200);
  });
});

// ---- 7. Retry-After ------------------------------------------------------------------------------

test("isolation failures map to their status and Retry-After on every parsing endpoint", async () => {
  await withServer({ ripstream: fakeEngine(), isolation: fakeIsolation(), maxLimits: { maxOutputChars: 1000 } }, async (base) => {
    const cases: Array<readonly [string, number, string | null]> = [
      ["queue_full.txt", 503, "1"],
      ["unavailable.txt", 503, "5"],
      ["crash.txt", 500, null],
      ["limit.txt", 422, null],
    ];
    for (const path of ["/tika", "/meta", "/rmeta", "/unpack", "/detect"]) {
      for (const [filename, status, retryAfter] of cases) {
        const response = await fetch(`${base}${path}?filename=${filename}`, { method: "PUT", body: "x" });
        assert.equal(response.status, status, `${path} ${filename}`);
        assert.equal(response.headers.get("retry-after"), retryAfter, `${path} ${filename}`);
        await response.arrayBuffer();
      }
    }
  });
});

test("a JSON error response carries Retry-After and the isolation error code", async () => {
  await withServer({ ripstream: fakeEngine(), isolation: fakeIsolation(), maxLimits: { maxOutputChars: 1000 } }, async (base) => {
    const response = await fetch(`${base}/tika?filename=queue_full.txt`, {
      method: "PUT",
      headers: { accept: "application/json" },
      body: "x",
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(await response.json(), { error: "The memory pool queue is full", code: "ISOLATION_FAILED" });
  });
});

// ---- 8. /status ----------------------------------------------------------------------------------

test("/status reports the gate and passes the isolation status through unchanged", async () => {
  await withServer(
    { ripstream: fakeEngine(), isolation: fakeIsolation(), maxLimits: { maxOutputChars: 1000 }, maxConcurrent: 6, maxQueue: 2 },
    async (base) => {
      assert.deepEqual(await readStatus(base), {
        status: "ok",
        active: 0,
        queued: 0,
        gate: { maxConcurrent: 6, maxQueue: 2 },
        isolation: ACTIVE,
      });
    },
  );
});

test("/status without an isolation handle says isolation is off", async () => {
  await withServer({ ripstream: fakeEngine() }, async (base) => {
    assert.deepEqual(await readStatus(base), {
      status: "ok",
      active: 0,
      queued: 0,
      gate: { maxConcurrent: 100, maxQueue: 100 },
      isolation: { mode: "off", degraded: false },
    });
  });
});

test("/status counts running and waiting requests, and is never gated", async () => {
  const release = deferred();
  const engine = fakeEngine(async (call) => {
    if (call.method === "parse") await release.promise;
  });
  await withServer({ ripstream: engine, maxConcurrent: 1, maxQueue: 1 }, async (base) => {
    const first = fetch(`${base}/tika`, { method: "PUT", body: "first" });
    await waitFor(async () => (await readStatus(base)).active === 1);
    const second = fetch(`${base}/tika`, { method: "PUT", body: "second" });
    await waitFor(async () => (await readStatus(base)).queued === 1);
    const busy = await readStatus(base);
    assert.equal(busy.active, 1);
    assert.equal(busy.queued, 1);
    release.resolve();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    await waitFor(async () => (await readStatus(base)).active === 0);
    assert.equal((await readStatus(base)).queued, 0);
  });
});

// ---- 9. /pipes -----------------------------------------------------------------------------------

test("/pipes parses through the injected engine, not a pipeline of its own", async () => {
  const root = mkdtempSync(join(tmpdir(), "ripstream-server-isolation-pipes-"));
  try {
    writeFileSync(join(root, "a.txt"), "pipes body");
    const engine = fakeEngine();
    await withServer(
      { ripstream: engine, isolation: fakeIsolation(), maxLimits: { maxOutputChars: 1000 }, authenticate: () => true, pipes: { sourceRoot: root } },
      async (base) => {
        const post = (mode: string): Promise<Response> =>
          fetch(`${base}/pipes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ source: { type: "filesystem", path: "." }, mode }),
          });

        const content = await post("CONTENT_ONLY");
        assert.equal(content.status, 200);
        assert.equal(((await content.json()) as { count: number }).count, 1);
        const rmeta = await post("RMETA");
        assert.equal(rmeta.status, 200);

        assert.deepEqual(
          engine.calls.map((call) => [call.method, call.bytes]),
          [
            ["parse", "pipes body".length],
            ["parseRecursive", "pipes body".length],
          ],
        );
        assert.match(engine.calls[0]?.filename ?? "", /a\.txt$/);
        // The server's output ceiling is the default of a pipes parse too: it does not get the isolator's own.
        assert.deepEqual(
          engine.calls.map((call) => call.limits),
          [{ maxOutputChars: 1000 }, { maxOutputChars: 1000 }],
        );
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/async parses under the server's output ceiling too", async () => {
  const engine = fakeEngine();
  await withServer({ ripstream: engine, isolation: fakeIsolation(), maxLimits: { maxOutputChars: 500, maxEmbeddedResources: 7 } }, async (base) => {
    const accepted = await fetch(`${base}/async?filename=a.txt`, { method: "POST", body: "x" });
    assert.equal(accepted.status, 202);
    await waitFor(async () => engine.calls.length === 1);
    assert.deepEqual(engine.calls[0]?.limits, { maxOutputChars: 500, maxEmbeddedResources: 7 });
  });
});

test("without a ceiling /async and /pipes pass no limits, as before", async () => {
  const engine = fakeEngine();
  await withServer({ ripstream: engine }, async (base) => {
    await fetch(`${base}/async`, { method: "POST", body: "x" });
    await waitFor(async () => engine.calls.length === 1);
    assert.equal(engine.calls[0]?.limits, undefined);
  });
});

// ---- 10. request parameters cannot change isolation ----------------------------------------------

test("request parameters cannot change the isolation settings or the engine used", async () => {
  const engine = fakeEngine();
  const hostile = [
    "isolation=off",
    "mode=off",
    "perChildMb=1",
    "memoryPoolMb=1",
    "maxTaskMillis=1",
    "heapMb=1",
    "maxQueue=0",
    "maxConcurrent=1",
    "requireStrictContainment=false",
    "inProcess=true",
    "handler=not-a-handler",
  ].join("&");
  await withServer(
    { ripstream: engine, isolation: fakeIsolation(), maxLimits: { maxOutputChars: 500 } },
    async (base) => {
      const before = await readStatus(base);
      for (const path of ["/tika", "/meta", "/rmeta", "/unpack", "/detect"]) {
        const plain = await fetch(`${base}${path}?filename=a.txt`, { method: "PUT", body: "hello" });
        const plainBody = await plain.text();
        const plainCall = engine.calls.at(-1);

        const extra = await fetch(`${base}${path}?filename=a.txt&${hostile}`, { method: "PUT", body: "hello" });
        const extraBody = await extra.text();
        const extraCall = engine.calls.at(-1);

        assert.equal(extra.status, plain.status, path);
        assert.equal(extraBody, plainBody, path);
        assert.notEqual(extraCall, plainCall, `${path}: the second request reached the engine`);
        assert.deepEqual(extraCall, plainCall, `${path}: the engine saw the same request`);
      }
      assert.deepEqual(await readStatus(base), before);
    },
  );
});

// ---- end to end: hostile documents, real children --------------------------------------------------

const HOSTILE_CHILD = fileURLToPath(new URL("./fixtures/hostile-child.ts", import.meta.url));

/** Detection only: it answers text/plain for everything, so with no in-process types every request is isolated. */
const detectOnly: IsolatorRipstream = {
  detect: async () => MediaType.TEXT_PLAIN,
  parse: () => Promise.reject(new Error("the parent must never parse: every request is isolated")),
  parseRecursive: () => Promise.reject(new Error("the parent must never parse: every request is isolated")),
};

test("end to end: a hostile document takes down only its own request", { timeout: 30_000 }, async () => {
  const pool = new MemoryPool({ poolMb: 16_384, maxQueue: 8 });
  const isolator = await createNodeIsolator({
    config: { mode: "strict", memoryPoolMb: 8192, perChildMb: 1024, maxTaskMillis: 5000 },
    ripstream: detectOnly,
    childModule: HOSTILE_CHILD,
    pool,
    inProcessTypes: new Set(),
    log: () => undefined,
  });
  const { log, warnings } = collectLog();
  try {
    // A platform that cannot isolate throws from createNodeIsolator above (strict) and fails this test; it never skips.
    const started = isolator.status();
    assert.equal(started.mode, "strict");
    assert.equal(started.degraded, false);
    assert.notEqual(started.pool, null);

    await withServer(
      {
        ripstream: createIsolatedRipstream({ isolator, detector: detectOnly }),
        isolation: isolator,
        maxLimits: { maxOutputChars: 100_000 },
        log,
      },
      async (base) => {
        const put = async (filename: string): Promise<{ status: number; body: string }> => {
          const response = await fetch(`${base}/tika?filename=${filename}`, { method: "PUT", body: "hostile bytes" });
          return { status: response.status, body: await response.text() };
        };

        const [ok, oom, hang, abort] = await Promise.all([put("ok.txt"), put("oom.bin"), put("hang.bin"), put("abort.bin")]);
        assert.deepEqual(ok, { status: 200, body: "fine" });
        assert.equal(oom.status, 422, `oom.bin: ${oom.body}`);
        assert.equal(hang.status, 408, `hang.bin: ${hang.body}`);
        assert.equal(abort.status, 500, `abort.bin: ${abort.body}`);

        // The server and the isolator are still healthy after the three deaths.
        assert.deepEqual(await put("ok.txt"), { status: 200, body: "fine" });
        const status = await readStatus(base);
        assert.equal(status.active, 0);
        assert.equal((status.isolation as { mode: string }).mode, "strict");
        assert.deepEqual(warnings, []);
      },
    );
    assert.equal(isolator.status().unreapedChildren, 0);
  } finally {
    await isolator.dispose();
    pool.dispose();
  }
});
