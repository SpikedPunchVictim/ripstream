import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IsolationError, LimitExceededError, MediaType, Metadata } from "@spikedpunch/ripstream-core";
import { main, type CliDeps, type CliIO } from "../src/main.ts";

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

test("maps isolation errors to environment or internal exit codes", async () => {
  const failing = (error: Error): CliIO => ({
    stdout: () => undefined,
    stderr: () => undefined,
    readStdin: async () => {
      throw error;
    },
  });
  assert.equal(await main(["-"], failing(new IsolationError("queue_full", "full"))), 4);
  assert.equal(await main(["-"], failing(new IsolationError("unavailable", "none"))), 4);
  assert.equal(await main(["-"], failing(new IsolationError("crash", "died"))), 1);
});

test("--isolation and --max-output-chars: bad values are usage errors that name the flag", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["--isolation", "paranoid", "-"], /--isolation.*strict, lenient or off/],
    [["--isolation"], /--isolation expects/],
    [["serve", "--isolation", "maybe"], /--isolation.*strict, lenient or off/],
    [["serve", "--max-output-chars", "abc"], /--max-output-chars.*integer/],
    [["serve", "--max-output-chars", "0"], /--max-output-chars.*positive/],
    [["--max-output-chars"], /--max-output-chars expects/],
  ];
  for (const [argv, pattern] of cases) {
    const sink = io("x");
    assert.equal(await main(argv, sink), 2, argv.join(" "));
    assert.match(sink.err.join(""), pattern, argv.join(" "));
  }
});

test("a bad RIPSTREAM_ISOLATION value is a usage error, not a silent default", async () => {
  const sink = io("x");
  assert.equal(await main(["serve"], sink, { env: { RIPSTREAM_ISOLATION: "yes" } }), 2);
  assert.match(sink.err.join(""), /RIPSTREAM_ISOLATION.*strict, lenient or off/);
});

test("a document password cannot cross the isolation boundary: the combination is refused up front", async () => {
  const sink = io("x");
  assert.equal(await main(["--isolation", "strict", "--password", "secret", "-"], sink), 2);
  assert.match(sink.err.join(""), /--password.*isolation/);
});

test("help documents the isolation flags and environment variables", async () => {
  const sink = io();
  assert.equal(await main(["--help"], sink), 0);
  const text = sink.out.join("");
  assert.match(text, /--isolation <mode>/);
  assert.match(text, /--max-output-chars <n>/);
  assert.match(text, /RIPSTREAM_ISOLATION/);
});

/** A stand-in for createStandardIsolation that records what the CLI asked of it. */
function fakeIsolation(overrides: { parse?: () => Promise<{ text: string; metadata: Metadata }> } = {}) {
  const log: { created: unknown[]; disposed: number; parsed: number; detected: number } = {
    created: [],
    disposed: 0,
    parsed: 0,
    detected: 0,
  };
  const createIsolation = (async (options: unknown) => {
    log.created.push(options);
    return {
      isolator: {
        dispose: async () => {
          log.disposed++;
        },
      },
      ripstream: {
        detect: async () => {
          log.detected++;
          return MediaType.TEXT_PLAIN;
        },
        parse: async () => {
          log.parsed++;
          return overrides.parse === undefined ? { text: "from the child", metadata: new Metadata() } : overrides.parse();
        },
        parseRecursive: async () => [],
      },
    };
  }) as unknown as NonNullable<CliDeps["createIsolation"]>;
  return { log, createIsolation };
}

test("one-shot parse is off by default: no isolation is built", async () => {
  const { log, createIsolation } = fakeIsolation();
  const sink = io("plain");
  assert.equal(await main(["-"], sink, { env: {}, createIsolation }), 0);
  assert.equal(log.created.length, 0);
  assert.match(sink.out.join(""), /plain/);
});

test("--isolation strict sends parse through the isolated ripstream and disposes it", async () => {
  const { log, createIsolation } = fakeIsolation();
  const sink = io("plain");
  assert.equal(await main(["--isolation", "strict", "-"], sink, { env: {}, createIsolation }), 0);
  assert.equal(sink.out.join(""), "from the child");
  assert.equal(log.parsed, 1);
  assert.equal(log.disposed, 1);
  assert.deepEqual((log.created[0] as { config: unknown }).config, { mode: "strict" });
});

test("RIPSTREAM_ISOLATION turns isolation on for metadata too; the flag overrides it", async () => {
  const on = fakeIsolation();
  assert.equal(await main(["metadata", "-"], io("x"), { env: { RIPSTREAM_ISOLATION: "lenient" }, createIsolation: on.createIsolation }), 0);
  assert.equal(on.log.parsed, 1);
  const off = fakeIsolation();
  assert.equal(
    await main(["--isolation", "off", "-"], io("x"), { env: { RIPSTREAM_ISOLATION: "strict" }, createIsolation: off.createIsolation }),
    0,
  );
  assert.equal(off.log.created.length, 0);
});

test("detect and language ignore isolation and output-ceiling settings, even bad ones", async () => {
  const env = { RIPSTREAM_ISOLATION: "paranoid", RIPSTREAM_ISOLATION_MAX_QUEUE: "lots", RIPSTREAM_MAX_OUTPUT_CHARS: "x" };
  assert.equal(await main(["detect", "-"], io("plain"), { env }), 0);
  assert.equal(await main(["language", "-"], io("plain text here"), { env }), 0);
  // ...but a command that parses still refuses them.
  const sink = io("plain");
  assert.equal(await main(["-"], sink, { env }), 2);
  assert.match(sink.err.join(""), /RIPSTREAM_ISOLATION/);
});

test("the output ceiling belongs to serve: other commands do not read RIPSTREAM_MAX_OUTPUT_CHARS", async () => {
  assert.equal(await main(["-"], io("plain"), { env: { RIPSTREAM_MAX_OUTPUT_CHARS: "x" } }), 0);
  assert.equal(await main(["--max-output-chars", "x", "-"], io("plain"), { env: {} }), 0);
});

test("a requireStrictContainment left in the environment does not break a one-shot parse", async () => {
  assert.equal(await main(["-"], io("plain"), { env: { RIPSTREAM_ISOLATION_REQUIRE_STRICT_CONTAINMENT: "true" } }), 0);
});

test("detect and language never build an isolation", async () => {
  const { log, createIsolation } = fakeIsolation();
  assert.equal(await main(["detect", "--isolation", "strict", "-"], io("plain"), { env: {}, createIsolation }), 0);
  assert.equal(await main(["language", "--isolation", "strict", "-"], io("plain text here"), { env: {}, createIsolation }), 0);
  assert.equal(log.created.length, 0);
});

test("the isolation is disposed when the parse fails", async () => {
  const { log, createIsolation } = fakeIsolation({
    parse: async () => {
      throw new LimitExceededError("too much text");
    },
  });
  const sink = io("x");
  assert.equal(await main(["--isolation", "strict", "-"], sink, { env: {}, createIsolation }), 3);
  assert.match(sink.err.join(""), /too much text/);
  assert.equal(log.disposed, 1);
});

test("strict isolation that cannot start is an environment failure, never an in-process parse", async () => {
  const createIsolation = (async () => {
    throw new IsolationError("unavailable", "strict isolation is unavailable: no cgroup");
  }) as unknown as NonNullable<CliDeps["createIsolation"]>;
  const sink = io("plain");
  assert.equal(await main(["--isolation", "strict", "-"], sink, { env: {}, createIsolation }), 4);
  assert.match(sink.err.join(""), /strict isolation is unavailable/);
  assert.equal(sink.out.join(""), "");
});

test("isolation warnings reach stderr with a WARN prefix", async () => {
  const createIsolation = (async (options: { log: (level: "info" | "warn", message: string) => void }) => {
    options.log("info", "quiet detail");
    options.log("warn", "falling back to in-process");
    return fakeIsolation().createIsolation(options as never);
  }) as unknown as NonNullable<CliDeps["createIsolation"]>;
  const sink = io("x");
  assert.equal(await main(["--isolation", "lenient", "-"], sink, { env: {}, createIsolation }), 0);
  assert.match(sink.err.join(""), /ripstream: WARN: falling back to in-process/);
  assert.doesNotMatch(sink.err.join(""), /quiet detail/);
});
