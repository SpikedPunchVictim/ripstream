import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { IsolationError, MediaType, Metadata, createIsolatedRipstream } from "@spikedpunch/ripstream-core";
import { MemoryPool, createNodeIsolator, type IsolatorRipstream, type NodeIsolator } from "@spikedpunch/ripstream-isolation-node";
import { main, type CliDeps, type CliIO } from "../src/main.ts";

type CreateIsolation = NonNullable<CliDeps["createIsolation"]>;

function io(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (value) => out.push(value),
    stderr: (value) => err.push(value),
    readStdin: async () => new Uint8Array(),
  };
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts `serve --port 0` in this process and resolves with its base URL once it is listening. */
async function startServe(
  argv: readonly string[],
  deps: CliDeps,
): Promise<{ sink: ReturnType<typeof io>; base: string; exit: Promise<number> }> {
  const sink = io();
  const exit = main(["serve", "--port", "0", ...argv], sink, deps);
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(sink.out.join("")), "the server to listen");
  const port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(sink.out.join(""))?.[1];
  return { sink, base: `http://127.0.0.1:${port}`, exit };
}

interface FakeIsolation {
  readonly created: Array<{ config: unknown; defaultMaxOutputChars?: number }>;
  readonly parseLimits: unknown[];
  disposed: number;
  readonly createIsolation: CreateIsolation;
}

/** A stand-in for createStandardIsolation: a healthy strict handle whose parse records the limits it got. */
function fakeIsolation(): FakeIsolation {
  const fake: FakeIsolation = {
    created: [],
    parseLimits: [],
    disposed: 0,
    createIsolation: (async (options: { config: unknown; defaultMaxOutputChars?: number }) => {
      fake.created.push(options);
      return {
        isolator: {
          dispose: async () => {
            fake.disposed++;
          },
          status: () => ({
            mode: "strict",
            degraded: false,
            pool: { poolMb: 8192, maxQueue: 4 },
            defaultReservationMb: { text: 2000, records: 3000 },
            containment: { fake: true },
          }),
        },
        ripstream: {
          detect: async () => MediaType.TEXT_PLAIN,
          parse: async (_source: unknown, parseOptions?: { limits?: unknown }) => {
            fake.parseLimits.push(parseOptions?.limits);
            return { text: "isolated", metadata: new Metadata() };
          },
          parseRecursive: async () => [],
        },
      };
    }) as unknown as CreateIsolation,
  };
  return fake;
}

async function stop(running: { exit: Promise<number> }): Promise<number> {
  process.emit("SIGTERM");
  return running.exit;
}

test("serve isolates by default: strict, with the default output ceiling, and says so", async () => {
  const fake = fakeIsolation();
  const running = await startServe([], { env: {}, createIsolation: fake.createIsolation });
  try {
    assert.deepEqual(fake.created.map((options) => options.config), [{ mode: "strict" }]);
    assert.match(running.sink.out.join(""), /isolation strict \(default\); memory pool 8192 MiB/);

    const status = (await (await fetch(`${running.base}/status`)).json()) as { isolation: { mode: string }; gate: unknown };
    assert.equal(status.isolation.mode, "strict");
    // Sized by the dearer reservation (records, 3000): floor(8192 / 3000) = 2 running + the pool's 4 queued;
    // the server queues none of its own.
    assert.deepEqual(status.gate, { maxConcurrent: 6, maxQueue: 0 });

    assert.equal(await (await fetch(`${running.base}/tika`, { method: "PUT", body: "x" })).text(), "isolated");
    await fetch(`${running.base}/tika?maxOutputChars=999999999`, { method: "PUT", body: "x" });
    assert.deepEqual(fake.parseLimits, [{ maxOutputChars: 100_000 }, { maxOutputChars: 100_000 }]);
    // The isolation is built for the ceiling it will be asked to serve, so its pool check and /status match.
    assert.deepEqual(fake.created.map((options) => options.defaultMaxOutputChars), [100_000]);
  } finally {
    assert.equal(await stop(running), 0);
  }
  assert.equal(fake.disposed, 1);
});

test("--max-output-chars and RIPSTREAM_MAX_OUTPUT_CHARS set the ceiling", async () => {
  const flagged = fakeIsolation();
  const first = await startServe(["--max-output-chars", "500"], { env: { RIPSTREAM_MAX_OUTPUT_CHARS: "900" }, createIsolation: flagged.createIsolation });
  try {
    await fetch(`${first.base}/tika`, { method: "PUT", body: "x" });
  } finally {
    await stop(first);
  }
  assert.deepEqual(flagged.parseLimits, [{ maxOutputChars: 500 }]);
  assert.deepEqual(flagged.created.map((options) => options.defaultMaxOutputChars), [500]);

  const fromEnv = fakeIsolation();
  const second = await startServe([], { env: { RIPSTREAM_MAX_OUTPUT_CHARS: "900" }, createIsolation: fromEnv.createIsolation });
  try {
    await fetch(`${second.base}/tika`, { method: "PUT", body: "x" });
  } finally {
    await stop(second);
  }
  assert.deepEqual(fromEnv.parseLimits, [{ maxOutputChars: 900 }]);
  assert.deepEqual(fromEnv.created.map((options) => options.defaultMaxOutputChars), [900]);
});

test("--isolation off serves in-process and is loud about it", async () => {
  const fake = fakeIsolation();
  const running = await startServe(["--isolation", "off"], { env: {}, createIsolation: fake.createIsolation });
  try {
    assert.equal(fake.created.length, 0);
    assert.match(running.sink.out.join(""), /isolation off \(flag\): documents are parsed in this process/);
    assert.match(running.sink.err.join(""), /ripstream: WARN: Parse isolation is off for this server/);
    const status = (await (await fetch(`${running.base}/status`)).json()) as { isolation: unknown };
    assert.deepEqual(status.isolation, { mode: "off", degraded: false });
    assert.equal((await (await fetch(`${running.base}/tika`, { method: "PUT", body: "plain" })).text()).trim(), "plain");
  } finally {
    assert.equal(await stop(running), 0);
  }
});

test("RIPSTREAM_ISOLATION=lenient warns at startup; the flag outranks it", async () => {
  const lenient = fakeIsolation();
  const first = await startServe([], { env: { RIPSTREAM_ISOLATION: "lenient" }, createIsolation: lenient.createIsolation });
  try {
    assert.deepEqual(lenient.created.map((options) => options.config), [{ mode: "lenient" }]);
    assert.match(first.sink.out.join(""), /isolation lenient \(env\)/);
  } finally {
    await stop(first);
  }
  const strict = fakeIsolation();
  const second = await startServe(["--isolation", "strict"], { env: { RIPSTREAM_ISOLATION: "off" }, createIsolation: strict.createIsolation });
  try {
    assert.deepEqual(strict.created.map((options) => options.config), [{ mode: "strict" }]);
  } finally {
    await stop(second);
  }
});

test("strict isolation that cannot start: exit 4, an error on stderr, nothing listening", async () => {
  const createIsolation = (async () => {
    throw new IsolationError("unavailable", "strict isolation is unavailable here: memory pool needs 2708 MiB");
  }) as unknown as CreateIsolation;
  const sink = io();
  assert.equal(await main(["serve", "--port", "0"], sink, { env: {}, createIsolation }), 4);
  assert.match(sink.err.join(""), /ripstream: strict isolation is unavailable here/);
  assert.equal(sink.out.join(""), "");
});

test("a server that cannot listen: exit 4 with the reason, and the isolation is still disposed", async () => {
  const fake = fakeIsolation();
  const holder = await startServe([], { env: {}, createIsolation: fakeIsolation().createIsolation });
  try {
    const port = /:(\d+)\b/.exec(holder.base.slice("http://".length))?.[1];
    const sink = io();
    assert.equal(await main(["serve", "--port", String(port)], sink, { env: {}, createIsolation: fake.createIsolation }), 4);
    assert.match(sink.err.join(""), new RegExp(`ripstream: cannot listen on 127\\.0\\.0\\.1:${port}: .*EADDRINUSE`));
    assert.equal(fake.disposed, 1);
  } finally {
    await stop(holder);
  }
});

test("settings the isolation rejects are usage errors, not crashes (exit 2)", async () => {
  const createIsolation = (async () => {
    throw new RangeError("maxOutputChars 1000000000000 is above what a child can hold");
  }) as unknown as CreateIsolation;
  const sink = io();
  assert.equal(await main(["serve", "--port", "0", "--max-output-chars", "1000000000000"], sink, { env: {}, createIsolation }), 2);
  assert.match(sink.err.join(""), /ripstream: .*maxOutputChars 1000000000000/);
  assert.equal(sink.out.join(""), "");
});

// ---- a real child, killed with the server --------------------------------------------------------

const HOSTILE_CHILD = fileURLToPath(new URL("../../server/test/fixtures/hostile-child.ts", import.meta.url));

const detectOnly: IsolatorRipstream = {
  detect: async () => MediaType.OCTET_STREAM,
  parse: async () => {
    throw new Error("detection only");
  },
  parseRecursive: async () => {
    throw new Error("detection only");
  },
};

// Test files run in parallel and the server's tests start fixture children too: tell ours apart by an argument no
// other run has. The child ignores it.
const CHILD_MARKER = `serve-test-${randomUUID()}`;

/** Pids of this test's live fixture children. /proc where there is one (slim images have no pgrep), pgrep elsewhere. */
function hostileChildren(): number[] {
  if (existsSync("/proc/self/cmdline")) {
    return readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)
      .filter((entry) => {
        try {
          return readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(CHILD_MARKER);
        } catch {
          return false; // the process ended while we looked
        }
      })
      .map(Number);
  }
  try {
    const out = execFileSync("pgrep", ["-f", CHILD_MARKER], { encoding: "utf8" });
    return out.split("\n").filter((line) => line !== "").map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

test("SIGTERM stops the server and kills the child that is still parsing", async () => {
  const pool = new MemoryPool({ poolMb: 8192, maxQueue: 4 });
  let isolator: NodeIsolator | undefined;
  const createIsolation = (async () => {
    isolator = await createNodeIsolator({
      config: { mode: "strict", memoryPoolMb: 8192, perChildMb: 1024, maxTaskMillis: 60_000 },
      ripstream: detectOnly,
      childModule: HOSTILE_CHILD,
      childArgs: [CHILD_MARKER],
      pool,
      inProcessTypes: new Set(),
      log: () => undefined,
    });
    return { isolator, ripstream: createIsolatedRipstream({ isolator, detector: detectOnly }) };
  }) as unknown as CreateIsolation;

  const running = await startServe([], { env: {}, createIsolation });
  try {
    const ok = await fetch(`${running.base}/tika?filename=ok.txt`, { method: "PUT", body: "x" });
    assert.equal(await ok.text(), "fine");

    const hanging = fetch(`${running.base}/tika?filename=hang.bin`, { method: "PUT", body: "x" }).then(
      (response) => response.status,
      () => "connection closed",
    );
    await until(() => hostileChildren().length > 0, "the hanging child to start");

    assert.equal(await stop(running), 0);
    assert.notEqual(isolator, undefined);
    assert.equal(isolator?.status().disposed, true);
    assert.equal(isolator?.status().unreapedChildren, 0);
    assert.deepEqual(hostileChildren(), [], "the child outlived the server");
    await hanging; // the client of the killed request got an answer or a closed connection, never a hang
  } finally {
    pool.dispose();
  }
});
