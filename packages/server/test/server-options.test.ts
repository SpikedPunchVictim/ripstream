import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import { MediaType, Metadata, type ParseOptions } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { createRipstreamServer, type ServerRipstream } from "../src/index.ts";

/*
 * The options `ripstream serve` fills from a `server` section: the endpoints served, the request log, the deadline
 * for reading a request and the idle timeout of a connection, and the limits a request gets when it names none.
 */

async function withServer<T>(
  run: (base: string, port: number) => Promise<T>,
  options: Parameters<typeof createRipstreamServer>[0] = {},
): Promise<T> {
  const instance = createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, ...options });
  const port = await instance.listen();
  try {
    return await run(`http://127.0.0.1:${port}`, port);
  } finally {
    await instance.close();
  }
}

const status = async (base: string, method: string, path: string, body?: string): Promise<number> =>
  (await fetch(`${base}${path}`, { method, ...(body === undefined || method === "GET" ? {} : { body }) })).status;

test("endpoints is exactly what is served; /health is always served and the others answer 404", async () => {
  await withServer(
    async (base) => {
      assert.equal(await status(base, "PUT", "/detect", "text"), 200);
      for (const path of ["/tika", "/meta", "/rmeta", "/unpack", "/language"]) assert.equal(await status(base, "PUT", path, "text"), 404, path);
      assert.equal(await status(base, "GET", "/version"), 404);
      assert.equal(await status(base, "GET", "/status"), 404);
      assert.equal(await status(base, "POST", "/async", "text"), 404);
      assert.equal(await status(base, "GET", "/status/abc"), 404);
      assert.equal(await status(base, "GET", "/health"), 200);
    },
    { endpoints: ["detect"] },
  );
});

test("without endpoints everything ripstream serves is served, which the programmatic server always did", async () => {
  await withServer(async (base) => {
    for (const [method, path] of [["PUT", "/tika"], ["GET", "/version"], ["GET", "/status"], ["POST", "/async"]] as const) {
      assert.notEqual(await status(base, method, path, "text"), 404, path);
    }
  });
});

test("status is its own endpoint, and the job lookup under /status/ belongs to async", async () => {
  await withServer(async (base) => {
    assert.equal(await status(base, "GET", "/status"), 200);
    assert.equal(await status(base, "PUT", "/detect", "text"), 404);
    assert.equal(await status(base, "GET", "/status/abc"), 404);
  }, { endpoints: ["status"] });

  await withServer(async (base) => {
    const accepted = await fetch(`${base}/async`, { method: "POST", body: "async body" });
    assert.equal(accepted.status, 202);
    const { id } = (await accepted.json()) as { id: string };
    assert.equal(await status(base, "GET", `/status/${id}`), 200);
    assert.equal(await status(base, "GET", "/status"), 404);
  }, { endpoints: ["async"] });
});

test("an endpoint the server does not serve is refused at construction", () => {
  assert.throws(() => createRipstreamServer({ ripstream: createRipstream(), endpoints: ["detect", "mime" as never] }), /unknown endpoint "mime"/);
});

test("requestLogLevel logs each request's method and URI at that level, and nothing when unset", async () => {
  for (const level of ["debug", "info"] as const) {
    const lines: Array<[string, string]> = [];
    await withServer(
      async (base) => {
        await fetch(`${base}/detect?filename=a.txt`, { method: "PUT", body: "x" });
        await fetch(`${base}/health`);
      },
      { requestLogLevel: level, log: (l, message) => lines.push([l, message]) },
    );
    assert.deepEqual(lines.filter(([, message]) => /^(PUT|GET) /.test(message)), [[level, "PUT /detect?filename=a.txt"], [level, "GET /health"]]);
  }
  const quiet: string[] = [];
  await withServer(async (base) => void (await fetch(`${base}/health`)), { log: (_l, message) => quiet.push(message) });
  assert.deepEqual(quiet.filter((message) => /^GET /.test(message)), []);
});

test("maxRequestReadMillis is the deadline for receiving a request; negative disables it", async () => {
  const timeout = (maxRequestReadMillis?: number): number =>
    createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, ...(maxRequestReadMillis === undefined ? {} : { maxRequestReadMillis }) }).server.requestTimeout;
  assert.equal(timeout(90_000), 90_000);
  assert.equal(timeout(-1), 0);
  assert.equal(timeout(), 60_000, "unset keeps the request timeout it always had");

  await withServer(async (_base, port) => {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let received = "";
      socket.on("data", (chunk) => (received += chunk.toString("latin1")));
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
      // The headers promise 100 bytes and 3 arrive: the rest never does.
      socket.write("PUT /tika HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nabc");
    });
    assert.match(reply, /^HTTP\/1\.1 408 /);
  }, { maxRequestReadMillis: 200 });
});

/** A client that sends part of a body and then nothing. Resolves with how long the server took to close it. */
function stalledClient(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = connect(port, "127.0.0.1");
    socket.on("close", () => resolve(Date.now() - started));
    socket.on("error", () => undefined);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("the server did not close the connection"));
    }, 5000).unref();
    socket.write("PUT /tika HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nabc");
  });
}

test("idleTimeoutMillis closes a connection that stops sending, but not one waiting on its parse", async () => {
  await withServer(async (_base, port) => {
    assert.ok((await stalledClient(port)) < 3000);
  }, { idleTimeoutMillis: 200 });

  const slow = {
    detect: async () => MediaType.TEXT_PLAIN,
    parse: async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return { text: "slow words", metadata: new Metadata() };
    },
    parseRecursive: async () => [],
  } as unknown as ServerRipstream;
  await withServer(async (base) => {
    const response = await fetch(`${base}/tika`, { method: "PUT", body: "x" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "slow words");
  }, { ripstream: slow, idleTimeoutMillis: 200 });
});

function limitsSeen(): { engine: ServerRipstream; seen: Array<Record<string, number> | undefined> } {
  const seen: Array<Record<string, number> | undefined> = [];
  const engine = {
    detect: async () => MediaType.TEXT_PLAIN,
    parse: async (_source: unknown, options?: ParseOptions) => {
      seen.push(options?.limits as Record<string, number> | undefined);
      return { text: "x", metadata: new Metadata() };
    },
    parseRecursive: async () => [],
  } as unknown as ServerRipstream;
  return { engine, seen };
}

test("defaultLimits are the limits of a request that names none; the request, then the ceiling, win", async () => {
  const { engine, seen } = limitsSeen();
  await withServer(
    async (base) => {
      await fetch(`${base}/tika`, { method: "PUT", body: "x" });
      await fetch(`${base}/tika?maxOutputChars=50`, { method: "PUT", body: "x" });
      await fetch(`${base}/tika?maxOutputChars=5000`, { method: "PUT", body: "x" });
    },
    { ripstream: engine, defaultLimits: { maxOutputChars: 100, maxEmbeddedResources: 7 }, maxLimits: { maxOutputChars: 1000 } },
  );
  assert.deepEqual(seen, [
    { maxOutputChars: 100, maxEmbeddedResources: 7 },
    { maxOutputChars: 50, maxEmbeddedResources: 7 },
    { maxOutputChars: 1000, maxEmbeddedResources: 7 },
  ]);
});

test("defaultLimits reach /async too, which takes no limit parameters", async () => {
  const { engine, seen } = limitsSeen();
  await withServer(
    async (base) => {
      const { id } = (await (await fetch(`${base}/async`, { method: "POST", body: "x" })).json()) as { id: string };
      for (let tries = 0; tries < 50 && seen.length === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await status(base, "GET", `/status/${id}`), 200);
    },
    { ripstream: engine, defaultLimits: { maxOutputChars: 100 }, maxLimits: { maxOutputChars: 1000 } },
  );
  assert.deepEqual(seen, [{ maxOutputChars: 100 }]);
});

test("a default above the ceiling is refused at construction", () => {
  assert.throws(
    () => createRipstreamServer({ ripstream: createRipstream(), defaultLimits: { maxOutputChars: 2000 }, maxLimits: { maxOutputChars: 1000 } }),
    (error) => error instanceof RangeError && /defaultLimits.maxOutputChars \(2000\) is above maxLimits.maxOutputChars \(1000\)/.test(error.message),
  );
});
