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

test("a misspelled RIPSTREAM_ variable is a usage error that names it and the nearest setting", async () => {
  const env = { RIPSTREAM_ISOLATION_MAXQUEUE: "4" };
  for (const argv of [["serve"], ["-"], ["metadata", "-"]]) {
    const sink = io("x");
    assert.equal(await main(argv, sink, { env }), 2, argv.join(" "));
    assert.match(sink.err.join(""), /RIPSTREAM_ISOLATION_MAXQUEUE.*did you mean RIPSTREAM_ISOLATION_MAX_QUEUE\?/, argv.join(" "));
  }
});

test("a misspelled RIPSTREAM_ variable does not stop detect or language, which read none", async () => {
  const env = { RIPSTREAM_ISOLATON: "strict" };
  assert.equal(await main(["detect", "-"], io("plain"), { env }), 0);
  assert.equal(await main(["language", "-"], io("plain text here"), { env }), 0);
});

test("RIPSTREAM_PDFJS_CORPUS, which only the test suite reads, does not stop a parse", async () => {
  assert.equal(await main(["-"], io("plain"), { env: { RIPSTREAM_PDFJS_CORPUS: "/corpus" } }), 0);
});

test("a flag that takes a value and is given none is a usage error, never a default", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["-c"], /-c expects a value/],
    [["--config"], /--config expects a value/],
    [["-p"], /-p expects a value/],
    [["--password"], /--password expects a value/],
    [["serve", "--port"], /--port expects a value/],
    [["serve", "--host"], /--host expects a value/],
    [["--output"], /--output expects/],
  ];
  for (const [argv, pattern] of cases) {
    const sink = io("x");
    assert.equal(await main(argv, sink, { env: {} }), 2, argv.join(" "));
    assert.match(sink.err.join(""), pattern, argv.join(" "));
  }
});

test("a flag that takes a value is not given another flag as its value", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["-c", "--json", "-"], /-c expects a value, got the option --json/],
    [["-p", "-m", "-"], /-p expects a value, got the option -m/],
    [["serve", "--host", "--port", "0"], /--host expects a value, got the option --port/],
    [["serve", "--port", "--host"], /--port expects a value, got the option --host/],
    [["--config", "--password", "x", "-"], /--config expects a value, got the option --password/],
  ];
  for (const [argv, pattern] of cases) {
    const sink = io("x");
    assert.equal(await main(argv, sink, { env: {} }), 2, argv.join(" "));
    assert.match(sink.err.join(""), pattern, argv.join(" "));
  }
});

test("--port takes digits only: an empty or padded value is not port 0", async () => {
  for (const value of ["", " ", "0x10", "1e3", "-1", "80.5", "99999"]) {
    const sink = io("x");
    assert.equal(await main(["serve", "--port", value], sink, { env: {} }), 2, JSON.stringify(value));
    assert.match(sink.err.join(""), /--port expects an integer between 0 and 65535/, JSON.stringify(value));
  }
});

test("--name=value means the same as --name value, for every long option that takes one", async () => {
  const run = async (argv: string[], input = "Hello"): Promise<{ code: number; out: string; err: string }> => {
    const sink = io(input);
    const code = await main(argv, sink, { env: {} });
    return { code, out: sink.out.join(""), err: sink.err.join("") };
  };
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-equals-"));
  try {
    // The directory name has an `=` in it: only the first one separates the name from the value.
    const config = join(directory, "a=b.json");
    writeFileSync(config, '{"version":1,"isolation":{"mode":"off"}}');
    for (const [spaced, joined] of [
      [["--output", "json", "-"], ["--output=json", "-"]],
      [["--output", "jsonl", "-"], ["--output=jsonl", "-"]],
      [["--config", config, "-"], [`--config=${config}`, "-"]],
      [["--isolation", "off", "-"], ["--isolation=off", "-"]],
      [["--password", "secret", "-"], ["--password=secret", "-"]],
    ] as Array<[string[], string[]]>) {
      const a = await run(spaced);
      const b = await run(joined);
      assert.equal(a.code, 0, spaced.join(" "));
      assert.deepEqual(b, a, joined.join(" "));
    }
    // The value is taken as written, even when it looks like a flag: --password=-m is a password, not a flag.
    assert.equal((await run(["--password=-m", "-"])).code, 0);
    // And a bad value is refused by the same check as before.
    const bad = await run(["--isolation=paranoid", "-"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /isolation/);
    const port = await run(["serve", "--port=abc"]);
    assert.equal(port.code, 2);
    assert.match(port.err, /--port expects an integer between 0 and 65535/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--name= with no value, a value on a flag that takes none, and -x=value are usage errors", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["--config=", "-"], /--config expects a value/],
    [["--output=", "-"], /--output expects text, json or jsonl/],
    [["serve", "--port="], /--port expects a value/],
    [["--json=yes", "-"], /--json does not take a value/],
    [["--help=x"], /--help does not take a value/],
    [["--bogus=1", "-"], /Unknown option: --bogus=1/],
    [["-c=x", "-"], /Unknown option: -c=x/],
  ];
  for (const [argv, pattern] of cases) {
    const sink = io("x");
    assert.equal(await main(argv, sink, { env: {} }), 2, argv.join(" "));
    assert.match(sink.err.join(""), pattern, argv.join(" "));
  }
});

test("a config file with a repeated key, or deep nesting, is a usage error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-config-"));
  try {
    const write = (name: string, text: string): string => {
      const path = join(directory, name);
      writeFileSync(path, text);
      return path;
    };
    const duplicate = write("duplicate.json", '{"isolation":{"mode":"strict","mode":"off"}}');
    let sink = io("x");
    assert.equal(await main(["--config", duplicate, "-"], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /duplicate key "mode"/);

    const deep = write("deep.json", `{"version":1,"x":${"[".repeat(100_000)}${"]".repeat(100_000)}}`);
    sink = io("x");
    assert.equal(await main(["--config", deep, "-"], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /deeper than 64 levels/);

    const fine = write("fine.json", '{"version":1,"isolation":{"mode":"off"}}');
    assert.equal(await main(["--config", fine, "-"], io("plain"), { env: {} }), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A `parsers` section is Tika's (tikajs-68os.8.6). `-c` used to take it and parse with every parser anyway.
function withConfig(config: unknown, run: (file: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-parsers-"));
  const file = join(directory, "config.json");
  writeFileSync(file, JSON.stringify(config));
  return run(file).finally(() => rmSync(directory, { recursive: true, force: true }));
}

const WITHOUT_PDF = { parsers: [{ "default-parser": { exclude: ["pdf-parser"] } }], isolation: { mode: "off" } };

test("a parsers section in --config is applied: an excluded parser's type is refused, the rest still parse", async () => {
  await withConfig(WITHOUT_PDF, async (file) => {
    const pdf = io("%PDF-1.4\n%%EOF\n");
    assert.equal(await main(["--config", file, "-"], pdf, { env: {} }), 3);
    assert.match(pdf.err.join(""), /application\/pdf/);
    const text = io("Hello parsers");
    assert.equal(await main(["--config", file, "-"], text, { env: {} }), 0);
    assert.match(text.out.join(""), /Hello parsers/);
  });
});

test("a parsers section with isolation on is a usage error that names the gap, not a silent full parse", async () => {
  await withConfig({ parsers: ["pdf-parser"] }, async (file) => {
    for (const args of [
      ["--config", file, "--isolation", "strict", "-"],
      ["metadata", "--config", file, "--isolation", "lenient", "-"],
    ]) {
      const { log, createIsolation } = fakeIsolation();
      const sink = io("x");
      assert.equal(await main(args, sink, { env: {}, createIsolation }), 2, args.join(" "));
      assert.match(sink.err.join(""), /parsers.*isolation|isolation.*parsers/s);
      assert.match(sink.err.join(""), /tikajs-68os\.8\.7/);
      assert.match(sink.err.join(""), /--isolation off/);
      assert.equal(log.created.length, 0, "no isolation is built for a refused invocation");
    }
    // serve isolates by default, so it refuses too, before it listens.
    const sink = io();
    assert.equal(await main(["serve", "--port", "0", "--config", file], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /tikajs-68os\.8\.7/);
    assert.equal(sink.out.join(""), "", "the server never started");
  });
});

test("a parsers section naming a parser ripstream does not implement is a usage error", async () => {
  await withConfig({ parsers: ["bpg-parser"], isolation: { mode: "off" } }, async (file) => {
    const sink = io("x");
    assert.equal(await main(["--config", file, "-"], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /parser "bpg-parser" is not implemented/);
  });
});

test("detect and language do not run a parser, so a parsers section changes nothing for them", async () => {
  await withConfig({ parsers: ["pdf-parser"] }, async (file) => {
    assert.equal(await main(["detect", "--config", file, "-"], io("plain"), { env: {} }), 0);
    assert.equal(await main(["language", "--config", file, "-"], io("plain text here"), { env: {} }), 0);
  });
});

test("a config with no parsers section still isolates", async () => {
  await withConfig({ isolation: { mode: "strict" } }, async (file) => {
    const { log, createIsolation } = fakeIsolation();
    assert.equal(await main(["--config", file, "-"], io("x"), { env: {}, createIsolation }), 0);
    assert.equal(log.created.length, 1);
  });
});

const NO_DETECTORS = { detectors: ["no-op-detector"], isolation: { mode: "off" } };

test("a detectors section in --config is applied to detect and to what a parse is offered", async () => {
  await withConfig(NO_DETECTORS, async (file) => {
    const detected = io("plain");
    assert.equal(await main(["detect", "--config", file, "-"], detected, { env: {} }), 0);
    assert.equal(detected.out.join("").trim(), "application/octet-stream");
    // The parser is offered what the configured detector says, so text with no detector is a type nothing parses.
    const refused = io("plain");
    assert.equal(await main(["metadata", "--config", file, "-"], refused, { env: {} }), 3);
    assert.match(refused.err.join(""), /application\/octet-stream/);
    assert.equal(await main(["metadata", "-"], io("plain"), { env: {} }), 0);
  });
  const plain = io("plain");
  assert.equal(await main(["detect", "-"], plain, { env: {} }), 0);
  assert.equal(plain.out.join("").trim(), "text/plain");
});

test("detect applies detectors even when isolation settings are set, since it never isolates", async () => {
  await withConfig({ detectors: ["no-op-detector"] }, async (file) => {
    const sink = io("plain");
    assert.equal(await main(["detect", "--config", file, "-"], sink, { env: { RIPSTREAM_ISOLATION: "strict" } }), 0);
    assert.equal(sink.out.join("").trim(), "application/octet-stream");
  });
});

test("a detectors section with isolation on is a usage error that names the gap", async () => {
  await withConfig({ detectors: ["mime-types"] }, async (file) => {
    const { log, createIsolation } = fakeIsolation();
    const sink = io("x");
    assert.equal(await main(["--config", file, "--isolation", "strict", "-"], sink, { env: {}, createIsolation }), 2);
    assert.match(sink.err.join(""), /sets "detectors"/);
    assert.match(sink.err.join(""), /tikajs-68os\.8\.7/);
    assert.equal(log.created.length, 0);
    const served = io();
    assert.equal(await main(["serve", "--port", "0", "--config", file], served, { env: {} }), 2);
    assert.equal(served.out.join(""), "", "the server never started");
  });
});

test("a detectors section naming a detector ripstream does not implement is a usage error", async () => {
  await withConfig({ detectors: ["siegfried-detector"], isolation: { mode: "off" } }, async (file) => {
    const sink = io("x");
    assert.equal(await main(["--config", file, "-"], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /detector "siegfried-detector" is not implemented/);
    // detect builds the same ripstream, so it refuses too.
    const detect = io("x");
    assert.equal(await main(["detect", "--config", file, "-"], detect, { env: {} }), 2);
  });
});

// A `parse-context` section sets limits (tikajs-68os.8.8); --maxEmbeddedDepth and --maxEmbeddedCount are tika-app's flags
// for the same two limits. What the section may say is tested in core/test/parse-context-config.test.ts.

/** A ustar archive with one text entry per name: enough for a parser that counts embedded documents. */
function tarOf(names: readonly string[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const name of names) {
    const body = new TextEncoder().encode(`text of ${name}`);
    const header = new Uint8Array(512);
    const put = (offset: number, text: string): void => header.set(new TextEncoder().encode(text), offset);
    put(0, name);
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, `${body.length.toString(8).padStart(11, "0")}\0`);
    put(136, "00000000000\0");
    put(148, "        ");
    put(156, "0");
    put(257, "ustar\0");
    put(263, "00");
    const sum = header.reduce((total, byte) => total + byte, 0);
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const result = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }
  return result;
}

function withTar(names: readonly string[], run: (tar: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-tar-"));
  const tar = join(directory, "three.tar");
  writeFileSync(tar, tarOf(names));
  return run(tar).finally(() => rmSync(directory, { recursive: true, force: true }));
}

const THREE = ["a.txt", "b.txt", "c.txt"];
const MAX_TWO = { "parse-context": { "embedded-limits": { maxCount: 2, throwOnMaxCount: true } } };

test("the tar the tests use parses, with three embedded documents", async () => {
  await withTar(THREE, async (tar) => {
    const sink = io();
    assert.equal(await main([tar], sink, { env: {} }), 0, sink.err.join(""));
    assert.match(sink.out.join(""), /text of c\.txt/);
  });
});

test("a parse-context section in --config limits parse, metadata and --recursive", async () => {
  await withTar(THREE, async (tar) => {
    await withConfig(MAX_TWO, async (file) => {
      for (const args of [["--config", file, tar], ["metadata", "--config", file, tar], ["--recursive", "--config", file, tar]]) {
        const sink = io();
        assert.equal(await main(args, sink, { env: {} }), 3, args.join(" "));
        assert.match(sink.err.join(""), /Embedded count 3 exceeds 2/, args.join(" "));
      }
    });
    await withConfig({ "parse-context": { "embedded-limits": { maxCount: 3, throwOnMaxCount: true } } }, async (file) => {
      assert.equal(await main(["--config", file, tar], io(), { env: {} }), 0);
    });
  });
});

test("--maxEmbeddedCount and --maxEmbeddedDepth set the same limits, in either spelling", async () => {
  await withTar(THREE, async (tar) => {
    for (const args of [["--maxEmbeddedCount=2", tar], ["--maxEmbeddedCount", "2", tar], ["metadata", "--maxEmbeddedCount=2", tar]]) {
      const sink = io();
      assert.equal(await main(args, sink, { env: {} }), 3, args.join(" "));
      assert.match(sink.err.join(""), /Embedded count 3 exceeds 2/, args.join(" "));
    }
    assert.equal(await main(["--maxEmbeddedCount=3", tar], io(), { env: {} }), 0);
    // A child of the container is at depth 1, so a depth of 0 refuses the first one.
    const depth = io();
    assert.equal(await main(["--maxEmbeddedDepth=0", tar], depth, { env: {} }), 3);
    assert.match(depth.err.join(""), /Embedded depth 1 exceeds 0/);
    assert.equal(await main(["--maxEmbeddedDepth=1", tar], io(), { env: {} }), 0);
  });
});

test("a flag beats the configuration's limit", async () => {
  await withTar(THREE, async (tar) => {
    await withConfig(MAX_TWO, async (file) => {
      assert.equal(await main(["--config", file, "--maxEmbeddedCount=10", tar], io(), { env: {} }), 0);
      assert.equal(await main(["--config", file, "--maxEmbeddedCount=1", tar], io(), { env: {} }), 3);
    });
  });
});

test("--maxEmbeddedCount and --maxEmbeddedDepth take a non-negative integer, nothing else", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["--maxEmbeddedCount=abc", "-"], /--maxEmbeddedCount expects a non-negative integer, got "abc"/],
    [["--maxEmbeddedCount=-1", "-"], /--maxEmbeddedCount expects a non-negative integer, got "-1"/],
    [["--maxEmbeddedCount=1.5", "-"], /--maxEmbeddedCount expects a non-negative integer/],
    [["--maxEmbeddedDepth= 3", "-"], /--maxEmbeddedDepth expects a non-negative integer/],
    [["--maxEmbeddedDepth=99999999999999999999", "-"], /--maxEmbeddedDepth expects a non-negative integer/],
    [["--maxEmbeddedCount=", "-"], /--maxEmbeddedCount expects a value/],
    [["--maxEmbeddedCount"], /--maxEmbeddedCount expects a value/],
    [["--maxEmbeddedDepth", "--json", "-"], /--maxEmbeddedDepth expects a value, got the option --json/],
  ];
  for (const [argv, pattern] of cases) {
    const sink = io("x");
    assert.equal(await main(argv, sink, { env: {} }), 2, argv.join(" "));
    assert.match(sink.err.join(""), pattern, argv.join(" "));
  }
});

test("--maxEmbeddedCount is a parse and metadata option: detect, language and serve refuse it", async () => {
  for (const command of ["detect", "language", "serve"]) {
    const sink = io("x");
    assert.equal(await main([command, "--maxEmbeddedCount=1", "-"], sink, { env: {} }), 2, command);
    assert.match(sink.err.join(""), /--maxEmbeddedCount applies to parse and metadata/, command);
    assert.equal(sink.out.join(""), "", `${command} did nothing`);
  }
});

test("limits with isolation on are a usage error that names the gap, as the other sections are", async () => {
  await withConfig(MAX_TWO, async (file) => {
    const { log, createIsolation } = fakeIsolation();
    const sink = io("x");
    assert.equal(await main(["--config", file, "--isolation", "strict", "-"], sink, { env: {}, createIsolation }), 2);
    assert.match(sink.err.join(""), /sets "parse-context"/);
    assert.match(sink.err.join(""), /tikajs-68os\.8\.7/);
    assert.equal(log.created.length, 0);
  });
  const { log, createIsolation } = fakeIsolation();
  const flagged = io("x");
  assert.equal(await main(["--maxEmbeddedCount=5", "--isolation", "lenient", "-"], flagged, { env: {}, createIsolation }), 2);
  assert.match(flagged.err.join(""), /--maxEmbeddedCount is set, which an isolated parse cannot yet receive \(tikajs-68os\.8\.7\)/);
  assert.equal(log.created.length, 0);
});

test("serve does not apply a parse-context section yet, and says so instead of half applying it", async () => {
  await withConfig({ ...MAX_TWO, isolation: { mode: "off" } }, async (file) => {
    const sink = io();
    assert.equal(await main(["serve", "--port", "0", "--config", file], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /"parse-context".*serve|serve.*"parse-context"/s);
    assert.match(sink.err.join(""), /tikajs-68os\.8\.9/);
    assert.equal(sink.out.join(""), "", "the server never started");
  });
});

test("detect and language run no parse, so a parse-context section changes nothing for them", async () => {
  await withConfig(MAX_TWO, async (file) => {
    assert.equal(await main(["detect", "--config", file, "-"], io("plain"), { env: {} }), 0);
    assert.equal(await main(["language", "--config", file, "-"], io("plain text here"), { env: {} }), 0);
  });
});

test("a parse-context limit without its throw flag is a usage error that says what to set", async () => {
  await withConfig({ "parse-context": { "embedded-limits": { maxCount: 2 } } }, async (file) => {
    const sink = io("x");
    assert.equal(await main(["--config", file, "-"], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /maxCount needs throwOnMaxCount: true/);
  });
});

test("a --config file saved with a byte order mark loads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-bom-"));
  try {
    const file = join(directory, "config.json");
    writeFileSync(file, `﻿${JSON.stringify({ isolation: { mode: "off" } })}`);
    assert.equal(await main(["--config", file, "-"], io("plain"), { env: {} }), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
