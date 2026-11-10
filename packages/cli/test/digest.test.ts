import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, type CliIO } from "../src/main.ts";

/*
 * A digester factory in --config (tikajs-68os.9.1) through the commands that read one, with the real parsers and, where the
 * command isolates, the real children: Apache Tika's own test_recursive_embedded.docx (vendored unmodified in
 * packages/bundle-standard/test/fixtures/tika) has the MD5 Tika's DigestConfigTest hard-codes.
 */

const DOCX_PATH = fileURLToPath(new URL("../../bundle-standard/test/fixtures/tika/test_recursive_embedded.docx", import.meta.url));
const DOCX_MD5 = "59f626e09a8c16ab6dbc2800c685f772";
const MD5 = { "commons-digester-factory": { digests: [{ algorithm: "MD5" }] } };

function io(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (value) => out.push(value), stderr: (value) => err.push(value), readStdin: async () => new Uint8Array() };
}

async function withConfig<T>(config: unknown, run: (file: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-digest-"));
  const file = join(directory, "config.json");
  writeFileSync(file, JSON.stringify(config));
  try {
    return await run(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("metadata under strict isolation: the child's parse has Tika's MD5", async () => {
  await withConfig({ "parse-context": MD5 }, async (file) => {
    const sink = io();
    assert.equal(await main(["metadata", "--json", "--config", file, "--isolation", "strict", DOCX_PATH], sink, { env: {} }), 0, sink.err.join(""));
    assert.equal((JSON.parse(sink.out.join("")) as Record<string, unknown>)["tk:digest:MD5"], DOCX_MD5);
  });
});

test("--recursive: every record has a digest, and the container's is Tika's", async () => {
  await withConfig({ "parse-context": MD5, isolation: { mode: "off" } }, async (file) => {
    const sink = io();
    assert.equal(await main(["--recursive", "-o", "jsonl", "--config", file, DOCX_PATH], sink, { env: {} }), 0, sink.err.join(""));
    const records = sink.out.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(records.length > 1, "the document has embedded documents");
    for (const record of records) assert.match(String(record["tk:digest:MD5"]), /^[0-9a-f]{32}$/);
    assert.equal(records[0]?.["tk:digest:MD5"], DOCX_MD5);
  });
});

test("serve (strict by default): /meta and /rmeta carry the digests", async () => {
  await withConfig({ "parse-context": MD5, server: { endpoints: ["meta", "rmeta"] } }, async (file) => {
    const sink = io();
    const exit = main(["serve", "--port", "0", "--config", file], sink, { env: {} });
    for (let attempt = 0; attempt < 500 && !/http:\/\/127\.0\.0\.1:\d+/.test(sink.out.join("")); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    const base = `http://127.0.0.1:${/http:\/\/127\.0\.0\.1:(\d+)/.exec(sink.out.join(""))?.[1]}`;
    try {
      const body = readFileSync(DOCX_PATH);
      const headers = { "Content-Type": "application/octet-stream", Accept: "application/json" };
      const meta = await fetch(`${base}/meta`, { method: "PUT", body, headers });
      assert.equal(meta.status, 200);
      assert.equal(((await meta.json()) as Record<string, unknown>)["tk:digest:MD5"], DOCX_MD5);
      const rmeta = await fetch(`${base}/rmeta`, { method: "PUT", body, headers });
      assert.equal(rmeta.status, 200);
      const records = (await rmeta.json()) as Array<Record<string, unknown>>;
      assert.ok(records.length > 1);
      assert.equal(records[0]?.["tk:digest:MD5"], DOCX_MD5);
      for (const record of records) assert.match(String(record["tk:digest:MD5"]), /^[0-9a-f]{32}$/);
    } finally {
      process.emit("SIGTERM");
      assert.equal(await exit, 0);
    }
  });
});
