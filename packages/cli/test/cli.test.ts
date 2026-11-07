import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, type CliIO } from "../src/main.ts";

function io(input = ""): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (value) => out.push(value),
    stderr: (value) => err.push(value),
    readStdin: async () => new TextEncoder().encode(input),
  };
}

test("parses files and stdin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-"));
  try {
    const file = join(directory, "a.txt");
    writeFileSync(file, "Hello CLI");
    let sink = io();
    assert.equal(await main([file], sink), 0);
    assert.match(sink.out.join(""), /Hello CLI/);

    sink = io("stdin text");
    assert.equal(await main(["-"], sink), 0);
    assert.match(sink.out.join(""), /stdin text/);

    sink = io();
    assert.equal(await main(["detect", file], sink), 0);
    assert.match(sink.out.join(""), /text\/plain/);

    sink = io();
    assert.equal(await main(["metadata", "--json", file], sink), 0);
    assert.match(sink.out.join(""), /Content-Type/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("returns usage and parse error exit codes", async () => {
  let sink = io();
  assert.equal(await main(["--nope"], sink), 2);
  assert.match(sink.err.join(""), /Unknown option/);
  sink = io();
  assert.equal(await main(["/definitely/missing.pdf"], sink), 4);
  assert.equal(await main(["version"], io()), 0);
  assert.equal(await main(["help"], io()), 0);
});

test("maps malformed documents to exit code 3", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-"));
  try {
    const file = join(directory, "broken.pdf");
    writeFileSync(file, "%PDF-1.4\nnot really a pdf");
    const sink = io();
    assert.equal(await main([file], sink), 3);
    assert.match(sink.err.join(""), /ripstream:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("help documents the exit code contract", async () => {
  const sink = io();
  assert.equal(await main(["--help"], sink), 0);
  assert.match(sink.out.join(""), /Exit codes:[\s\S]*3 {2}bad input data[\s\S]*4 {2}environment/);
});

test("serve rejects invalid ports with usage exit code", async () => {
  for (const port of ["abc", "-1", "70000", "1.5"]) {
    const sink = io();
    assert.equal(await main(["serve", "--port", port], sink), 2, port);
    assert.match(sink.err.join(""), /--port expects an integer/);
  }
});

test("jsonl output emits one JSON object per line", async () => {
  let sink = io("Hello JSONL");
  assert.equal(await main(["-o", "jsonl", "-"], sink), 0);
  const lines = sink.out.join("").split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.match(String(parsed["X-TIKA:content"]), /Hello JSONL/);
  assert.ok(Array.isArray(parsed["Content-Type"]));

  sink = io("Hello JSONL");
  assert.equal(await main(["-r", "-o", "jsonl", "-"], sink), 0);
  const recursive = sink.out.join("").split("\n").filter((line) => line !== "");
  assert.ok(recursive.length >= 1);
  const first = JSON.parse(recursive[0]!) as Record<string, unknown>;
  assert.match(String(first["X-TIKA:content"]), /Hello JSONL/);
  assert.ok("X-TIKA:embedded_depth" in first);
});

test("detects language from stdin", async () => {
  const sink = io(
    "The parser extracts text and metadata from documents, and the test suite verifies each format across many different inputs.",
  );
  assert.equal(await main(["language"], sink), 0);
  assert.equal(sink.out.join("").trim(), "eng");
});

test("serve command starts an HTTP server", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["packages/cli/bin/ripstream.js", "serve", "--port", "0"], {
    cwd: new URL("../../..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("serve did not start")), 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk);
        if (match !== null) {
          clearTimeout(timer);
          resolve(chunk);
        }
      });
      child.on("error", reject);
    });
    const port = /:(\d+)/.exec(line)?.[1];
    assert.ok(port !== undefined);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(await response.text(), "ok");
  } finally {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.on("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
});
