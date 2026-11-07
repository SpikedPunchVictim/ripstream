import assert from "node:assert/strict";
import { test } from "node:test";
import { createRipstreamServer } from "../src/index.ts";

async function withServer<T>(
  run: (base: string) => Promise<T>,
  options: Parameters<typeof createRipstreamServer>[0] = {},
): Promise<T> {
  const instance = createRipstreamServer(options);
  const port = await instance.listen();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await instance.close();
  }
}

test("serves detect, ripstream, meta and rmeta endpoints", async () => {
  await withServer(async (base) => {
    const text = new TextEncoder().encode("Hello server");
    let response = await fetch(`${base}/detect`, { method: "PUT", body: text });
    assert.equal(await response.text(), "text/plain\n");

    response = await fetch(`${base}/tika`, { method: "PUT", body: text });
    assert.match(await response.text(), /Hello server/);

    response = await fetch(`${base}/tika`, {
      method: "PUT",
      headers: { accept: "application/json" },
      body: text,
    });
    const json = (await response.json()) as { text: string };
    assert.match(json.text, /Hello server/);

    response = await fetch(`${base}/meta`, { method: "PUT", body: text });
    assert.ok((await response.json())["Content-Type"]);

    response = await fetch(`${base}/rmeta`, { method: "PUT", body: text });
    const records = (await response.json()) as Array<Record<string, unknown>>;
    assert.match(String(records[0]?.["X-TIKA:content"]), /Hello server/);

    assert.equal(await (await fetch(`${base}/health`)).text(), "ok");
  });
});

test("returns protocol status codes", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/detect`)).status, 405);
    const large = await fetch(`${base}/tika`, {
      method: "PUT",
      body: new Uint8Array(64),
    });
    assert.equal(large.status, 413);
  }, { maxBodyBytes: 32 });
});

test("bounds concurrency with queueing and timeouts", async () => {
  const { Ripstream, MediaType } = await import("@spikedpunch/ripstream-core");
  const slow = new Ripstream({
    detector: { async detect() { return MediaType.TEXT_PLAIN; } },
    parser: {
      getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
      async parse() {
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
    },
  });
  await withServer(async (base) => {
    const first = fetch(`${base}/tika`, { method: "PUT", body: "x" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await fetch(`${base}/tika`, { method: "PUT", body: "y" });
    assert.equal(second.status, 503);
    assert.equal((await first).status, 200);
  }, { ripstream: slow, maxConcurrent: 1, maxQueue: 0 });

  await withServer(async (base) => {
    const first = fetch(`${base}/tika`, { method: "PUT", body: "x" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await fetch(`${base}/tika`, { method: "PUT", body: "y" });
    assert.equal(second.status, 408);
    await first.catch(() => undefined);
  }, { ripstream: slow, maxConcurrent: 1, maxQueue: 1, requestTimeoutMs: 50 });
});

test("accepts multipart file uploads", async () => {
  await withServer(async (base) => {
    const form = new FormData();
    form.append("file", new Blob(["Multipart text"], { type: "text/plain" }), "upload.txt");
    const response = await fetch(`${base}/tika`, { method: "PUT", body: form });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Multipart text/);
  });
});

test("supports CORS, auth hooks, language and translation", async () => {
  const { IdentityTranslator } = await import("@spikedpunch/ripstream-core");
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`, {
      headers: { origin: "https://example.com" },
    });
    assert.equal(response.headers.get("access-control-allow-origin"), "https://example.com");
    const language = await fetch(`${base}/language`, {
      method: "PUT",
      body: "The parser extracts text and metadata from documents, and the test suite verifies each format across many different inputs.",
    });
    assert.equal(((await language.json()) as { language: string }).language, "eng");
    const translated = await fetch(`${base}/translate?target=fr`, {
      method: "PUT",
      body: "hello",
    });
    assert.equal(await translated.text(), "hello");
    assert.equal((await (await fetch(`${base}/status`)).json()).status, "ok");
  }, { corsOrigin: "https://example.com", translator: new IdentityTranslator() });

  await withServer(async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 401);
  }, { authenticate: () => false });
});

test("supports presets, per-request limits and unpack", async () => {
  await withServer(async (base) => {
    let response = await fetch(`${base}/tika?preset=meta`, { method: "PUT", body: "text" });
    assert.ok((await response.json())["Content-Type"]);

    response = await fetch(`${base}/tika?preset=meta&maxOutputChars=2`, {
      method: "PUT",
      body: "long text",
    });
    assert.equal(response.status, 422);

    response = await fetch(`${base}/unpack`, { method: "PUT", body: "unpack" });
    const records = (await response.json()) as Array<Record<string, unknown>>;
    assert.match(String(records[0]?.["X-TIKA:content"]), /unpack/);
  }, { presets: { meta: { handler: "meta" } } });
});

test("runs async jobs and pipes configs", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const input = mkdtempSync(join(tmpdir(), "ripstream-server-pipes-"));
  try {
    writeFileSync(join(input, "a.txt"), "pipes server");
    await withServer(async (base) => {
      const accepted = await fetch(`${base}/async`, { method: "POST", body: "async body" });
      assert.equal(accepted.status, 202);
      const { id } = (await accepted.json()) as { id: string };
      let status: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 50; attempt++) {
        status = (await (await fetch(`${base}/status/${id}`)).json()) as Record<string, unknown>;
        if (status.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(status.status, "done");

      const pipes = await fetch(`${base}/pipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: { type: "filesystem", path: "." },
          mode: "NO_PARSE",
        }),
      });
      assert.equal(pipes.status, 200);
      assert.equal(((await pipes.json()) as { count: number }).count, 1);
    }, { authenticate: () => true, pipes: { sourceRoot: input } });
  } finally {
    rmSync(input, { recursive: true, force: true });
  }
});

async function pipesFixture(): Promise<{ base: string; root: string; outside: string; cleanup: () => void }> {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = mkdtempSync(join(tmpdir(), "ripstream-pipes-sec-"));
  const root = join(base, "src");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, "a.txt"), "a");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(root, "link"));
  return { base, root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("/pipes is disabled without server-side pipes config", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/pipes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { type: "filesystem", path: "/etc" } }),
    });
    assert.equal(response.status, 404);
  }, { authenticate: () => true });
});

test("pipes option requires authenticate", () => {
  assert.throws(() => createRipstreamServer({ pipes: { sourceRoot: "." } }), /authenticate/);
});

test("/pipes rejects non-JSON content types and unauthenticated callers", async () => {
  const fx = await pipesFixture();
  try {
    await withServer(async (base) => {
      const textPlain = await fetch(`${base}/pipes`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ source: { type: "filesystem", path: "." } }),
      });
      assert.equal(textPlain.status, 415);
    }, { authenticate: () => true, pipes: { sourceRoot: fx.root } });
    await withServer(async (base) => {
      const denied = await fetch(`${base}/pipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { type: "filesystem", path: "." } }),
      });
      assert.equal(denied.status, 401);
    }, { authenticate: () => false, pipes: { sourceRoot: fx.root } });
  } finally {
    fx.cleanup();
  }
});

test("/pipes confines client paths to configured roots and ignores symlinks", async () => {
  const fx = await pipesFixture();
  try {
    await withServer(async (base) => {
      const post = (body: unknown): Promise<Response> =>
        fetch(`${base}/pipes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      for (const path of ["/etc", fx.outside, "..", "../outside", "link", "link/secret.txt"]) {
        const response = await post({ source: { type: "filesystem", path }, mode: "NO_PARSE" });
        assert.equal(response.status, 403, path);
      }
      // sinks are refused when no sinkRoot is configured
      assert.equal(
        (await post({ source: { type: "filesystem" }, sink: { type: "filesystem", path: "out" } })).status,
        403,
      );
      // http sources are refused unless allowed
      assert.equal(
        (await post({ source: { type: "http", urls: ["http://93.184.216.34/"] } })).status,
        403,
      );
      // symlinks inside the root are skipped rather than followed
      const ok = await post({ source: { type: "filesystem" }, mode: "NO_PARSE" });
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { count: number }).count, 1);
      assert.equal((await post("not an object")).status, 400);
    }, { authenticate: () => true, pipes: { sourceRoot: fx.root } });
  } finally {
    fx.cleanup();
  }
});

test("/pipes confines sink paths and caps concurrency/maxQueue", async () => {
  const { existsSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const fx = await pipesFixture();
  try {
    const sinkRoot = join(fx.base, "sinks");
    mkdirSync(sinkRoot);
    await withServer(async (base) => {
      const post = (body: unknown): Promise<Response> =>
        fetch(`${base}/pipes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const escape = await post({
        source: { type: "filesystem" },
        sink: { type: "filesystem", path: "../outside/out" },
      });
      assert.equal(escape.status, 403);
      const ok = await post({
        source: { type: "filesystem" },
        sink: { type: "filesystem", path: "run1" },
        concurrency: 100000,
        maxQueue: 100000,
      });
      assert.equal(ok.status, 200);
      const stats = (await ok.json()) as { stats: Record<string, unknown> };
      assert.ok(existsSync(join(sinkRoot, "run1")));
      assert.ok(stats.stats !== undefined);
      assert.equal((await post({ source: { type: "filesystem" }, concurrency: -1 })).status, 400);
    }, { authenticate: () => true, pipes: { sourceRoot: fx.root, sinkRoot, maxConcurrency: 2, maxQueue: 4 } });
  } finally {
    fx.cleanup();
  }
});

test("rejects invalid client limits and clamps to server maximum", async () => {
  await withServer(async (base) => {
    for (const bad of ["-1", "NaN", "abc", "1.5", "", "1e3", "Infinity"]) {
      const response = await fetch(`${base}/tika?maxOutputChars=${bad}`, { method: "PUT", body: "hello world" });
      assert.equal(response.status, 400, bad);
    }
    // client cannot raise above the server max
    let response = await fetch(`${base}/tika?maxOutputChars=1000000`, { method: "PUT", body: "x".repeat(200) });
    assert.equal(response.status, 422);
    // client may lower it; absent param falls back to server max
    response = await fetch(`${base}/tika`, { method: "PUT", body: "x".repeat(200) });
    assert.equal(response.status, 422);
    response = await fetch(`${base}/tika?maxOutputChars=100`, { method: "PUT", body: "hi" });
    assert.equal(response.status, 200);
  }, { maxLimits: { maxOutputChars: 50 } });
});

test("array corsOrigin echoes only a listed request origin", async () => {
  await withServer(async (base) => {
    let response = await fetch(`${base}/health`, { headers: { origin: "https://b.example" } });
    assert.equal(response.headers.get("access-control-allow-origin"), "https://b.example");
    assert.equal(response.headers.get("vary"), "Origin");
    response = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    response = await fetch(`${base}/health`);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }, { corsOrigin: ["https://a.example", "https://b.example"] });
});

test("multipart filename is used for type detection", async () => {
  let seen: string | undefined;
  const { Ripstream, MediaType } = await import("@spikedpunch/ripstream-core");
  const spy = new Ripstream({
    detector: {
      async detect(_input: unknown, metadata?: { get(name: string): string | null | undefined }) {
        seen = metadata?.get("resourceName") ?? undefined;
        return MediaType.TEXT_PLAIN;
      },
    } as never,
    parser: { getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]), async parse() {} },
  });
  await withServer(async (base) => {
    const form = new FormData();
    form.append("file", new Blob(["x"]), "report.pdf");
    await fetch(`${base}/detect`, { method: "PUT", body: form });
    assert.equal(seen, "report.pdf");
  }, { ripstream: spy });
});

test("async jobs hold the concurrency slot until parsing finishes", async () => {
  const { Ripstream, MediaType } = await import("@spikedpunch/ripstream-core");
  const slow = new Ripstream({
    detector: { async detect() { return MediaType.TEXT_PLAIN; } },
    parser: {
      getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
      async parse() { await new Promise((resolve) => setTimeout(resolve, 200)); },
    },
  });
  await withServer(async (base) => {
    const accepted = await fetch(`${base}/async`, { method: "POST", body: "x" });
    assert.equal(accepted.status, 202);
    const rejected = await fetch(`${base}/tika`, { method: "PUT", body: "y" });
    assert.equal(rejected.status, 503);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal((await fetch(`${base}/tika`, { method: "PUT", body: "y" })).status, 200);
  }, { ripstream: slow, maxConcurrent: 1, maxQueue: 0 });
});

test("async jobs are evicted by TTL and bounded by maxJobs", async () => {
  await withServer(async (base) => {
    const first = (await (await fetch(`${base}/async`, { method: "POST", body: "a" })).json()) as { id: string };
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await fetch(`${base}/status/${first.id}`)).status, 404);
  }, { jobTtlMs: 20 });

  await withServer(async (base) => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/async`, { method: "POST", body: "a" });
      assert.equal(r.status, 202);
      ids.push(((await r.json()) as { id: string }).id);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal((await fetch(`${base}/status/${ids[0]}`)).status, 404);
    assert.equal((await fetch(`${base}/status/${ids[3]}`)).status, 200);
  }, { maxJobs: 2 });
});
