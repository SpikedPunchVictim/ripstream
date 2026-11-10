import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** A configuration file that serves /status, which Tika (and so `ripstream serve`) leaves off unless it is listed. */
const STATUS_CONFIG = (() => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-serve-status-"));
  const file = join(directory, "status.json");
  writeFileSync(file, JSON.stringify({ server: { endpoints: ["status", "tika"] } }));
  return file;
})();

async function withConfig<T>(config: unknown, run: (file: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-serve-config-"));
  const file = join(directory, "config.json");
  writeFileSync(file, JSON.stringify(config));
  try {
    return await run(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Starts `serve` with exactly these arguments (no --port added) and waits until it listens. */
async function startRaw(argv: readonly string[], deps: CliDeps = { env: {} }): Promise<{ sink: ReturnType<typeof io>; base: string; host: string; exit: Promise<number> }> {
  const sink = io();
  const exit = main(["serve", ...argv], sink, deps);
  await until(() => /http:\/\/[\d.]+:\d+/.test(sink.out.join("")), "the server to listen");
  const [, host, port] = /http:\/\/([\d.]+):(\d+)/.exec(sink.out.join(""))!;
  return { sink, host: host!, base: `http://${host}:${port}`, exit };
}

async function stop(running: { exit: Promise<number> }): Promise<number> {
  process.emit("SIGTERM");
  return running.exit;
}

test("serve isolates by default: strict, with the default output ceiling, and says so", async () => {
  const fake = fakeIsolation();
  const running = await startServe(["--config", STATUS_CONFIG], { env: {}, createIsolation: fake.createIsolation });
  try {
    assert.deepEqual(fake.created.map((options) => options.config), [{ mode: "strict" }]);
    assert.match(running.sink.out.join(""), /isolation strict \(default\); memory pool 8192 MiB/);

    const status = (await (await fetch(`${running.base}/status`)).json()) as { isolation: { mode: string }; gate: unknown };
    assert.equal(status.isolation.mode, "strict");
    // Sized by the dearer reservation (records, 3000): floor(8192 / 3000) = 2 running + the pool's 4 queued;
    // the server holds the next 100 itself, as it does without isolation.
    assert.deepEqual(status.gate, { maxConcurrent: 6, maxQueue: 100 });

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
  const running = await startServe(["--isolation", "off", "--config", STATUS_CONFIG], { env: {}, createIsolation: fake.createIsolation });
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

// ---- the `server` section and Tika's serve flags (tikajs-68os.8.9) --------------------------------------------------

test("without endpoints serve answers Tika's default set: /status and /async are off", async () => {
  const running = await startServe(["--isolation", "off"], { env: {} });
  try {
    for (const [method, path] of [["GET", "/status"], ["POST", "/async"]] as const) {
      assert.equal((await fetch(`${running.base}${path}`, { method })).status, 404, path);
    }
    for (const path of ["/health", "/version"]) assert.equal((await fetch(`${running.base}${path}`)).status, 200, path);
    assert.equal((await fetch(`${running.base}/detect`, { method: "PUT", body: "x" })).status, 200);
  } finally {
    assert.equal(await stop(running), 0);
  }
});

test("a server section sets what serve listens on and serves; a flag beats the file", async () => {
  await withConfig(
    {
      server: {
        port: 0,
        host: "127.0.0.1",
        endpoints: ["detect", "status"],
        cors: "https://example.com",
        maxRequestSizeBytes: 8,
        requestLogLevel: "info",
      },
    },
    async (file) => {
      const running = await startRaw(["--isolation", "off", "--config", file]);
      try {
        assert.equal(running.host, "127.0.0.1");
        assert.equal((await fetch(`${running.base}/status`)).status, 200);
        assert.equal((await fetch(`${running.base}/tika`, { method: "PUT", body: "x" })).status, 404, "endpoints is exactly the list");
        const detected = await fetch(`${running.base}/detect`, { method: "PUT", body: "short" });
        assert.equal(detected.status, 200);
        assert.equal(detected.headers.get("access-control-allow-origin"), "https://example.com");
        assert.equal((await fetch(`${running.base}/detect`, { method: "PUT", body: "far too long" })).status, 413);
        await until(() => /PUT \/detect/.test(running.sink.err.join("")), "the request log");
        assert.match(running.sink.err.join(""), /GET \/status/);
      } finally {
        assert.equal(await stop(running), 0);
      }
    },
  );
  // The file names a port nothing may use; the flag outranks it, as -p does in Tika.
  await withConfig({ server: { port: 1 } }, async (file) => {
    const running = await startRaw(["--isolation", "off", "--config", file, "--port", "0"]);
    try {
      assert.equal((await fetch(`${running.base}/health`)).status, 200);
    } finally {
      assert.equal(await stop(running), 0);
    }
  });
});

test("Tika's spellings: serve -h is the host, -p the port, -? help; * is every interface", async () => {
  const running = await startRaw(["--isolation", "off", "-h", "*", "-p", "0"]);
  try {
    assert.equal(running.host, "0.0.0.0");
    assert.equal((await fetch(`http://127.0.0.1:${new URL(running.base).port}/health`)).status, 200);
  } finally {
    assert.equal(await stop(running), 0);
  }
  for (const argv of [["serve", "-?"], ["-?"], ["serve", "--help"], ["parse", "-h"], ["-h"]]) {
    const sink = io();
    assert.equal(await main(argv, sink, { env: {} }), 0, argv.join(" "));
    assert.match(sink.out.join(""), /^Usage: ripstream/, argv.join(" "));
  }
  // Away from serve -p is still the password, and -h still help.
  const sink = io();
  assert.equal(await main(["serve", "-h"], sink, { env: {} }), 2);
  assert.match(sink.err.join(""), /-h expects a value, the host.*--help/);
});

test("a server section ripstream cannot apply is a usage error naming the setting, and nothing starts", async () => {
  await withConfig({ isolation: { mode: "off" }, server: { id: "a", allowPipes: true } }, async (file) => {
    const sink = io();
    assert.equal(await main(["serve", "--port", "0", "--config", file], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /server\.id is not supported/);
    assert.match(sink.err.join(""), /server\.allowPipes is not supported/);
    assert.equal(sink.out.join(""), "", "the server never started");
  });
});

test("serve answers with the text up to the output limit, unless the file says throwOnWriteLimit", async () => {
  const long = "word ".repeat(100);
  await withConfig({ isolation: { mode: "off" } }, async (file) => {
    const running = await startServe(["--config", file, "--max-output-chars", "10"], { env: {} });
    try {
      const response = await fetch(`${running.base}/tika`, { method: "PUT", body: long });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-ripstream-write-limit-reached"), "true");
      assert.equal((await response.text()).length, 10);
    } finally {
      assert.equal(await stop(running), 0);
    }
  });
  const strict = { isolation: { mode: "off" }, "parse-context": { "output-limits": { throwOnWriteLimit: true } } };
  await withConfig(strict, async (file) => {
    const running = await startServe(["--config", file, "--max-output-chars", "10"], { env: {} });
    try {
      assert.equal((await fetch(`${running.base}/tika`, { method: "PUT", body: long })).status, 422);
    } finally {
      assert.equal(await stop(running), 0);
    }
  });
});

test("a parse-context section gives requests that name no limit its limits; a request's own limit wins", async () => {
  const section = { isolation: { mode: "off" }, "parse-context": { "output-limits": { writeLimit: 20, throwOnWriteLimit: true } } };
  await withConfig(section, async (file) => {
    const running = await startServe(["--config", file], { env: {} });
    try {
      const long = "word ".repeat(100);
      assert.equal((await fetch(`${running.base}/tika`, { method: "PUT", body: long })).status, 422);
      assert.equal((await fetch(`${running.base}/tika?maxOutputChars=100000`, { method: "PUT", body: long })).status, 200);
    } finally {
      assert.equal(await stop(running), 0);
    }
  });
  // A default above the ceiling would be silently clamped: refuse it instead.
  await withConfig(section, async (file) => {
    const sink = io();
    assert.equal(await main(["serve", "--port", "0", "--config", file, "--max-output-chars", "10"], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /defaultLimits\.maxOutputChars \(20\) is above maxLimits\.maxOutputChars \(10\)/);
    assert.equal(sink.out.join(""), "");
  });
});

test("serve describes the standard media types at /mime-types, with the custom-mimetypes file merged in", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-serve-mime-"));
  try {
    const types = join(directory, "custom-mimetypes.xml");
    writeFileSync(
      types,
      `<?xml version="1.0" encoding="UTF-8"?>\n<mime-info>\n<mime-type type="application/x-acme-report">\n<_comment>Acme report</_comment>\n<sub-class-of type="application/xml"/>\n<glob pattern="*.acme"/>\n</mime-type>\n</mime-info>\n`,
    );
    await withConfig({ "custom-mimetypes": types }, async (file) => {
      const running = await startServe(["--isolation", "off", "--config", file], { env: {} });
      try {
        const ask = (path: string): Promise<Response> => fetch(`${running.base}${path}`, { headers: { accept: "application/json" } });
        const plain = (await (await ask("/mime-types/text/plain")).json()) as { type: string; extensions: string[]; defaultExtension: string };
        assert.equal(plain.type, "text/plain");
        assert.equal(plain.defaultExtension, ".txt");
        assert.ok(plain.extensions.includes(".text"));

        const custom = (await (await ask("/mime-types/application/x-acme-report")).json()) as Record<string, unknown>;
        assert.equal(custom.supertype, "application/xml");
        assert.equal(custom.description, "Acme report");
        assert.deepEqual(custom.extensions, [".acme"]);

        const all = (await (await ask("/mime-types")).json()) as Record<string, unknown>;
        assert.ok(Object.keys(all).length > 1000, "the whole registry");
      } finally {
        assert.equal(await stop(running), 0);
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
