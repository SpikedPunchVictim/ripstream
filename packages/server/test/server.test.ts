import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { test } from "node:test";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { crc32 } from "node:zlib";
import { bearerTokenAuthenticator, createRipstreamServer } from "../src/index.ts";
import { readZip } from "./fixtures/zip.ts";

async function withServer<T>(
  run: (base: string) => Promise<T>,
  options: Parameters<typeof createRipstreamServer>[0] = {},
): Promise<T> {
  // The server has no default engine; these tests exercise the HTTP layer over the in-process pipeline.
  const instance = createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, ...options });
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

    // The older { text, metadata } object is `?handler=json`; Tika's /tika answers text, so Accept: json is a 406.
    response = await fetch(`${base}/tika?handler=json`, { method: "PUT", body: text });
    const json = (await response.json()) as { text: string };
    assert.match(json.text, /Hello server/);
    response = await fetch(`${base}/tika`, { method: "PUT", headers: { accept: "application/json" }, body: text });
    assert.equal(response.status, 406);

    response = await fetch(`${base}/meta`, { method: "PUT", body: text });
    assert.ok((await response.json())["Content-Type"]);

    response = await fetch(`${base}/rmeta`, { method: "PUT", body: text });
    const records = (await response.json()) as Array<Record<string, unknown>>;
    assert.match(String(records[0]?.["tk:content"]), /Hello server/);

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
    assert.equal(await language.text(), "en");
    const detail = await fetch(`${base}/language`, {
      method: "PUT",
      headers: { accept: "application/json" },
      body: "The parser extracts text and metadata from documents, and the test suite verifies each format across many different inputs.",
    });
    assert.equal(((await detail.json()) as { language: string }).language, "eng");
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
    assert.equal(response.status, 200, "reaching the output limit is not a failure");
    assert.equal((await response.json())["tk:exception:write-limit-reached"], "true");

    // /unpack answers Tika's data package: a zip whose rmeta.json is what /rmeta answers (tests: unpack.test.ts).
    response = await fetch(`${base}/unpack`, { method: "PUT", body: "unpack" });
    assert.equal(response.headers.get("content-type"), "application/zip");
    const entries = readZip(new Uint8Array(await response.arrayBuffer()));
    assert.deepEqual(entries.map((entry) => entry.name), ["datapackage.json", "rmeta.json"]);
    const records = JSON.parse(entries[1]?.data.toString("utf8") ?? "") as Array<Record<string, unknown>>;
    assert.match(String(records[0]?.["tk:content"]), /unpack/);
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
  assert.throws(
    () => createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, pipes: { sourceRoot: "." } }),
    /authenticate/,
  );
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
    // client cannot raise above the server max: the text is cut at it
    let response = await fetch(`${base}/tika?maxOutputChars=1000000`, { method: "PUT", body: "x".repeat(200) });
    assert.equal(response.status, 200);
    assert.equal((await response.text()).length, 50);
    // client may lower it; absent param falls back to server max
    response = await fetch(`${base}/tika`, { method: "PUT", body: "x".repeat(200) });
    assert.equal((await response.text()).length, 50);
    response = await fetch(`${base}/tika?maxOutputChars=10`, { method: "PUT", body: "x".repeat(200) });
    assert.equal((await response.text()).length, 10);
    response = await fetch(`${base}/tika?maxOutputChars=100`, { method: "PUT", body: "hi" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-ripstream-write-limit-reached"), null, "text that fits is not flagged");
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

test("multipart parts keep every byte value", async () => {
  const received: number[] = [];
  const { Ripstream, MediaType } = await import("@spikedpunch/ripstream-core");
  const spy = new Ripstream({
    detector: { async detect() { return MediaType.TEXT_PLAIN; } } as never,
    parser: {
      getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
      async parse(stream: AsyncIterable<Uint8Array>) {
        for await (const chunk of stream) received.push(...chunk);
      },
    },
  });
  // TextDecoder("latin1") is windows-1252: it maps 0x80-0x9F to other code points, so those bytes were corrupted.
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  await withServer(async (base) => {
    const form = new FormData();
    form.append("file", new Blob([bytes]), "all-bytes.bin");
    const response = await fetch(`${base}/tika`, { method: "PUT", body: form });
    assert.equal(response.status, 200);
  }, { ripstream: spy });
  assert.deepEqual(received, [...bytes]);
});

test("multipart filename is used for type detection", async () => {
  let seen: string | undefined;
  const { Ripstream, MediaType } = await import("@spikedpunch/ripstream-core");
  const spy = new Ripstream({
    detector: {
      async detect(_input: unknown, metadata?: { get(name: string): string | null | undefined }) {
        seen = metadata?.get("tk:resource-name") ?? undefined;
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

/** A zip of stored (uncompressed) entries: enough to give /rmeta a container with embedded documents. */
function storedZip(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(entries).length, true);
  end.setUint16(10, Object.keys(entries).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

test("/rmeta and /meta use Tika 4.x's tk:* keys and its value shape (tikajs-68os.7.3)", async () => {
  await withServer(async (base) => {
    const zip = storedZip({ "inner.txt": "inside text" });
    const response = await fetch(`${base}/rmeta`, { method: "PUT", body: zip, headers: { "content-disposition": 'attachment; filename="box.zip"' } });
    assert.equal(response.status, 200);
    const records = (await response.json()) as Array<Record<string, unknown>>;
    const [container, inner] = records;
    assert.equal(records.length, 2);
    // container: Tika's framework keys, scalar unless repeated, and none of the 3.x spellings
    assert.equal(container?.["tk:embedded-depth"], "0");
    assert.equal(container?.["tk:embedded-resource-path"], undefined);
    assert.equal(container?.["tk:content-handler-type"], "TEXT");
    assert.equal(container?.["Content-Type"], "application/zip");
    assert.equal(container?.["tk:content-type-magic-detected"], "application/zip");
    assert.equal(container?.["tk:resource-name"], "box.zip");
    assert.equal(typeof container?.["tk:parse-time-millis"], "string");
    assert.ok(Array.isArray(container?.["tk:parsed-by-full-set"]));
    assert.ok(container?.["tk:parsed-by"] !== undefined);
    assert.deepEqual(Object.keys(container ?? {}).filter((key) => /^X-TIKA:|^resourceName$/.test(key)), []);
    // embedded document
    assert.equal(inner?.["tk:embedded-depth"], "1");
    assert.equal(inner?.["tk:embedded-id"], "1");
    assert.equal(inner?.["tk:embedded-id-path"], "/1");
    assert.equal(inner?.["tk:embedded-resource-path"], "/inner.txt");
    assert.equal(inner?.["tk:final-embedded-resource-path"], "/inner.txt");
    assert.match(String(inner?.["tk:content"]), /inside text/);

    const meta = (await (await fetch(`${base}/meta`, { method: "PUT", body: zip })).json()) as Record<string, unknown>;
    assert.equal(meta["Content-Type"], "application/zip", "a key with one value is a string");
  });
});

// ---- failure semantics (tikajs-68os.7.2): Tika's, case by case; not verified against a live Tika 4.2.0 ----------

const NOT_A_ZIP = new TextEncoder().encode("PK\u0003\u0004 definitely not a zip file");
const NOISE = Uint8Array.from({ length: 4096 }, (_, i) => (i * 131 + 17) & 0xff);
const asDocx = { "content-disposition": 'attachment; filename="fake.docx"' };

test("a document that cannot be read: the JSON routes answer 200 with the exception in the metadata", async () => {
  await withServer(async (base) => {
    const rmeta = await fetch(`${base}/rmeta`, { method: "PUT", body: NOT_A_ZIP, headers: asDocx });
    assert.equal(rmeta.status, 200);
    const [container] = (await rmeta.json()) as Array<Record<string, unknown>>;
    assert.match(String(container?.["tk:exception:container-exception"]), /^MalformedDocumentError: /);
    assert.equal(container?.["tk:embedded-depth"], "0");

    const meta = await fetch(`${base}/meta`, { method: "PUT", body: NOT_A_ZIP, headers: asDocx });
    assert.equal(meta.status, 200);
    assert.match(String(((await meta.json()) as Record<string, unknown>)["tk:exception:container-exception"]), /^MalformedDocumentError: /);

    const json = await fetch(`${base}/tika?handler=json`, { method: "PUT", body: NOT_A_ZIP, headers: asDocx });
    assert.equal(json.status, 200);
    const body = (await json.json()) as { text: string; metadata: Record<string, unknown> };
    assert.match(String(body.metadata["tk:exception:container-exception"]), /^MalformedDocumentError: /);
  });
});

test("a document that cannot be read: /tika answers 422 with the text extracted so far and names the failure in a header", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/tika`, { method: "PUT", body: NOT_A_ZIP, headers: asDocx });
    assert.equal(response.status, 422);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(response.headers.get("x-ripstream-error") ?? "", /^MalformedDocumentError: /);
    assert.equal(await response.text(), "", "nothing was extracted before the failure");
  });
});

test("an input of zero bytes: /tika is 422, /meta and /rmeta are 200 with the failure, /unpack is 422", async () => {
  await withServer(async (base) => {
    const tika = await fetch(`${base}/tika`, { method: "PUT", body: new Uint8Array(0) });
    assert.equal(tika.status, 422);
    assert.equal(await tika.text(), "");
    assert.match(tika.headers.get("x-ripstream-error") ?? "", /^ZeroByteFileError: /);

    const meta = await fetch(`${base}/meta`, { method: "PUT", body: new Uint8Array(0) });
    assert.equal(meta.status, 200);
    const fields = (await meta.json()) as Record<string, unknown>;
    assert.equal(fields["tk:exception:container-exception"], "ZeroByteFileError: InputStream must have > 0 bytes");
    assert.equal(fields["Content-Type"], "application/octet-stream", "an empty document still reports what it was detected as");

    const rmeta = await fetch(`${base}/rmeta`, { method: "PUT", body: new Uint8Array(0) });
    assert.equal(rmeta.status, 200);
    const [container] = (await rmeta.json()) as Array<Record<string, unknown>>;
    assert.match(String(container?.["tk:exception:container-exception"]), /^ZeroByteFileError: /);

    assert.equal((await fetch(`${base}/unpack`, { method: "PUT", body: new Uint8Array(0) })).status, 422);
  });
});

test("a format no parser takes is an empty answer, not an error", async () => {
  await withServer(async (base) => {
    const tika = await fetch(`${base}/tika`, { method: "PUT", body: NOISE });
    assert.equal(tika.status, 200);
    assert.equal(await tika.text(), "");

    const rmeta = await fetch(`${base}/rmeta`, { method: "PUT", body: NOISE });
    assert.equal(rmeta.status, 200);
    const records = (await rmeta.json()) as Array<Record<string, unknown>>;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.["tk:exception:container-exception"], undefined);
    assert.equal(records[0]?.["tk:parsed-by"], "EmptyParser");

    assert.equal((await fetch(`${base}/meta`, { method: "PUT", body: NOISE })).status, 200);
  });
});

test("reaching the output limit is an answer: the text up to it, flagged in the metadata and, for text, in a header", async () => {
  await withServer(async (base) => {
    const text = await fetch(`${base}/tika?maxOutputChars=5`, { method: "PUT", body: "long text here" });
    assert.equal(text.status, 200);
    assert.equal(text.headers.get("x-ripstream-write-limit-reached"), "true");
    assert.equal(await text.text(), "long ");

    const json = await fetch(`${base}/tika?maxOutputChars=5&handler=json`, { method: "PUT", body: "long text here" });
    const body = (await json.json()) as { text: string; metadata: Record<string, unknown> };
    assert.equal(body.text, "long ");
    assert.equal(body.metadata["tk:exception:write-limit-reached"], "true");

    // /meta is metadata only (Tika's ignore handler): it writes no output, so it has no output limit to reach.
    const meta = await fetch(`${base}/meta?maxOutputChars=5`, { method: "PUT", body: "long text here" });
    assert.equal(meta.status, 200);
    assert.equal(((await meta.json()) as Record<string, unknown>)["tk:exception:write-limit-reached"], undefined);

    const rmeta = await fetch(`${base}/rmeta?maxOutputChars=5`, { method: "PUT", body: "long text here" });
    assert.equal(rmeta.status, 200);
    const [container] = (await rmeta.json()) as Array<Record<string, unknown>>;
    assert.equal(container?.["tk:exception:write-limit-reached"], "true");
    assert.equal(String(container?.["tk:content"]).trim().length > 0, true);
    assert.equal(container?.["tk:exception:container-exception"], undefined, "a cut is not a failure");
  });
});

test("onOutputLimit throw: reaching the output limit is a 422 with its message, on every parse route", async () => {
  await withServer(async (base) => {
    for (const route of ["/tika", "/rmeta", "/unpack"]) {
      const response = await fetch(`${base}${route}?maxOutputChars=5`, { method: "PUT", body: "long text here" });
      assert.equal(response.status, 422, route);
      assert.match(await response.text(), /exceeds 5 characters/, route);
    }
    const fits = await fetch(`${base}/tika?maxOutputChars=50`, { method: "PUT", body: "long text here" });
    assert.equal(fits.status, 200);
    const meta = await fetch(`${base}/meta?maxOutputChars=5`, { method: "PUT", body: "long text here" });
    assert.equal(meta.status, 200, "/meta writes no output, so it has no limit to throw on");
  }, { onOutputLimit: "throw" });
});

test("a document cut at the output limit keeps the records parsed before it, the zip's container flagged", async () => {
  await withServer(async (base) => {
    const zip = storedZip({ "a.txt": "first document text", "b.txt": "second document text" });
    const response = await fetch(`${base}/rmeta?maxOutputChars=25`, { method: "PUT", body: zip, headers: { "content-disposition": 'attachment; filename="box.zip"' } });
    assert.equal(response.status, 200);
    const records = (await response.json()) as Array<Record<string, unknown>>;
    assert.equal(records[0]?.["tk:exception:write-limit-reached"], "true");
    assert.ok(records.some((record) => record["tk:exception:write-limit-reached"] === "true" && record["tk:embedded-depth"] === "1"));
  });
});

test("every other limit stays an error: an embedded-resource limit is still 422 with its message in the body", async () => {
  await withServer(async (base) => {
    const zip = storedZip({ "a.txt": "one", "b.txt": "two" });
    const response = await fetch(`${base}/rmeta?maxEmbeddedResources=1`, { method: "PUT", body: zip, headers: { "content-disposition": 'attachment; filename="box.zip"' } });
    assert.equal(response.status, 422);
    assert.equal(response.headers.get("x-ripstream-error"), null);
    assert.match(await response.text(), /embedded/i);
  });
});

test("the bearer-token authenticator accepts only the exact token", () => {
  const authenticate = bearerTokenAuthenticator("s3cret");
  const request = (authorization?: string): IncomingMessage => ({ headers: authorization === undefined ? {} : { authorization } }) as IncomingMessage;
  assert.equal(authenticate(request("Bearer s3cret")), true);
  assert.equal(authenticate(request("Bearer wrong")), false);
  assert.equal(authenticate(request("bearer s3cret")), false);
  assert.equal(authenticate(request("s3cret")), false);
  assert.equal(authenticate(request()), false);
  assert.throws(() => bearerTokenAuthenticator(""), RangeError);
});
