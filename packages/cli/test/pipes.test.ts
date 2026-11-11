import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Metadata } from "@spikedpunch/ripstream-core";
import { main, type CliDeps, type CliIO } from "../src/main.ts";

/*
 * `ripstream pipes` (tikajs-68os.6.5): the pipes sections of a Tika configuration, run from the command line, with a
 * checkpoint that lets a run that was stopped (however it was stopped) be started again.
 */

function io(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (value) => out.push(value), stderr: (value) => err.push(value), readStdin: async () => new Uint8Array() };
}

interface Workspace {
  readonly input: string;
  readonly output: string;
  readonly config: string;
}

/** A directory with `files` in `in/`, and a configuration that reads them and writes `out/<name>.json`. */
function workspace(files: Record<string, string>, options: { onExists?: string; pipes?: Record<string, unknown>; extra?: Record<string, unknown> } = {}): Workspace {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-pipes-"));
  const input = join(directory, "in");
  const output = join(directory, "out");
  mkdirSync(input);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(input, name), content);
  const config = join(directory, "tika-config.json");
  writeFileSync(
    config,
    JSON.stringify({
      fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
      emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: "json", onExists: options.onExists ?? "REPLACE" } } },
      "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
      pipes: { parseMode: "RMETA", numClients: 1, ...options.pipes },
      ...options.extra,
    }),
  );
  return { input, output, config };
}

/** An output limit that a document of 5 000 characters is over, and that fails the parse as Tika does with the flag set. */
const LIMIT_100 = { "parse-context": { "output-limits": { writeLimit: 100, throwOnWriteLimit: true } } };

const cleanup = (paths: Workspace): void => rmSync(join(paths.input, ".."), { recursive: true, force: true });

const emitted = (paths: Workspace): string[] => (existsSync(paths.output) ? readdirSync(paths.output).sort() : []);

test("pipes runs the configuration's iterator, fetchers and emitters, and says what it did", async () => {
  const paths = workspace({ "a.txt": "content of a", "b.txt": "content of b", "c.txt": "content of c" });
  try {
    const sink = io();
    assert.equal(await main(["pipes", "--config", paths.config], sink), 0);
    assert.match(sink.out.join(""), /pipes: fetched 3, resumed 0, emitted 3, failed 0 \(\d+ ms\)/);
    assert.deepEqual(emitted(paths), ["a.txt.json", "b.txt.json", "c.txt.json"]);
    assert.match(readFileSync(join(paths.output, "b.txt.json"), "utf8"), /content of b/);
    assert.equal(sink.err.join(""), "");

    const json = io();
    assert.equal(await main(["pipes", "--config", paths.config, "--json"], json), 0);
    const stats = JSON.parse(json.out.join("")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stats).sort(), ["byStatus", "durationMs", "emitted", "failed", "fetched", "resumed"]);
    assert.equal(stats.fetched, 3);
  } finally {
    cleanup(paths);
  }
});

test("pipes names a failed input on stderr, finishes the others, and exits 3", async () => {
  const paths = workspace(
    { "a.txt": "short", "b-long.txt": "x".repeat(5_000), "c.txt": "also short" },
    { extra: LIMIT_100 },
  );
  try {
    const sink = io();
    assert.equal(await main(["pipes", "--config", paths.config], sink), 3);
    assert.match(sink.err.join(""), /ripstream: PAYLOAD_LIMIT_EXCEEDED b-long\.txt: /);
    assert.match(sink.out.join(""), /fetched 3, resumed 0, emitted 2, failed 1/);
    assert.deepEqual(emitted(paths), ["a.txt.json", "c.txt.json"], "the input after the failed one still ran");
  } finally {
    cleanup(paths);
  }
});

test("pipes names the first 100 failed inputs and counts the rest", async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 103; index++) files[`long-${String(index).padStart(3, "0")}.txt`] = "x".repeat(5_000);
  const paths = workspace(files, { extra: LIMIT_100 });
  try {
    const sink = io();
    assert.equal(await main(["pipes", "--config", paths.config], sink), 3);
    const named = sink.err.filter((line) => /PAYLOAD_LIMIT_EXCEEDED long-/.test(line));
    assert.equal(named.length, 100);
    assert.deepEqual(sink.err.filter((line) => /more failed inputs/.test(line)), ["ripstream: and 3 more failed inputs (the reporters have all of them)\n"]);
    assert.match(sink.out.join(""), /failed 103/);
  } finally {
    cleanup(paths);
  }
});

test("pipes tells the operator which of the configuration's settings change nothing here", async () => {
  const paths = workspace({ "a.txt": "content" }, { pipes: { javaPath: "/usr/bin/java" } });
  try {
    const sink = io();
    assert.equal(await main(["pipes", "--config", paths.config], sink), 0);
    assert.match(sink.err.join(""), /ripstream: NOTE: pipes\.javaPath names the java binary Tika forks; ripstream has none, so it changes nothing/);
  } finally {
    cleanup(paths);
  }
});

test("pipes says what is wrong with how it was called, with exit 2", async () => {
  const paths = workspace({ "a.txt": "content" });
  try {
    let sink = io();
    assert.equal(await main(["pipes"], sink), 2);
    assert.match(sink.err.join(""), /pipes needs --config with the pipes sections/);

    const bare = join(paths.input, "..", "bare.json");
    writeFileSync(bare, JSON.stringify({ isolation: { mode: "off" } }));
    sink = io();
    assert.equal(await main(["pipes", "--config", bare], sink), 2);
    assert.match(sink.err.join(""), /pipes needs --config with the pipes sections/);

    sink = io();
    assert.equal(await main(["pipes", "--config", paths.config, "a.txt"], sink), 2);
    assert.match(sink.err.join(""), /pipes takes no file/);

    const noIterator = join(paths.input, "..", "no-iterator.json");
    writeFileSync(noIterator, JSON.stringify({ fetchers: { fsf: { "file-system-fetcher": { basePath: paths.input } } } }));
    sink = io();
    assert.equal(await main(["pipes", "--config", noIterator], sink), 2);
    assert.match(sink.err.join(""), /no pipes-iterator to take tuples from/);

    for (const flag of ["--maxEmbeddedDepth", "--maxEmbeddedCount"]) {
      sink = io();
      assert.equal(await main(["pipes", "--config", paths.config, flag, "3"], sink), 2, flag);
      assert.match(sink.err.join(""), /applies to parse and metadata, not pipes/);
    }
    assert.deepEqual(emitted(paths), [], "none of these ran anything");
  } finally {
    cleanup(paths);
  }
});

test("--retry-attempts takes a positive whole number, and only for pipes", async () => {
  const paths = workspace({ "a.txt": "content of a" });
  try {
    for (const bad of ["0", "-1", "1.5", "two", "", " 3"]) {
      const sink = io();
      assert.equal(await main(["pipes", "--config", paths.config, "--retry-attempts", bad], sink), 2, JSON.stringify(bad));
    }
    const sink = io();
    assert.equal(await main(["pipes", "--config", paths.config, "--retry-attempts", "0"], sink), 2);
    assert.match(sink.err.join(""), /--retry-attempts expects a positive integer/);

    assert.equal(await main(["pipes", "--config", paths.config, "--retry-attempts=3"], io()), 0);
    assert.deepEqual(emitted(paths), ["a.txt.json"]);

    for (const command of ["parse", "metadata", "detect", "serve"]) {
      const refused = io();
      assert.equal(await main([command, "--retry-attempts", "3"], refused), 2, command);
      assert.match(refused.err.join(""), new RegExp(`--retry-attempts applies to pipes, not ${command}`));
      const refusedCheckpoint = io();
      assert.equal(await main([command, "--checkpoint", "x"], refusedCheckpoint), 2, command);
      assert.match(refusedCheckpoint.err.join(""), new RegExp(`--checkpoint applies to pipes, not ${command}`));
    }
  } finally {
    cleanup(paths);
  }
});

test("--checkpoint leaves out the inputs an earlier run finished, and does the ones that are new", async () => {
  const paths = workspace({ "a.txt": "content of a", "b.txt": "content of b" });
  const checkpoint = join(paths.input, "..", "done.jsonl");
  try {
    const first = io();
    assert.equal(await main(["pipes", "--config", paths.config, "--checkpoint", checkpoint], first), 0);
    assert.match(first.out.join(""), /fetched 2, resumed 0, emitted 2/);
    assert.deepEqual(readFileSync(checkpoint, "utf8").trim().split("\n").sort(), ['"a.txt"', '"b.txt"']);

    const second = io();
    assert.equal(await main(["pipes", "--config", paths.config, "--checkpoint", checkpoint], second), 0);
    assert.match(second.out.join(""), /fetched 0, resumed 2, emitted 0/, "nothing is done again");

    writeFileSync(join(paths.input, "c.txt"), "content of c");
    const third = io();
    assert.equal(await main(["pipes", "--config", paths.config, "--checkpoint", checkpoint], third), 0);
    assert.match(third.out.join(""), /fetched 1, resumed 2, emitted 1/);
    assert.deepEqual(emitted(paths), ["a.txt.json", "b.txt.json", "c.txt.json"]);
  } finally {
    cleanup(paths);
  }
});

test("--checkpoint does not record a failed input, so the next run does it again", async () => {
  const paths = workspace({ "a.txt": "short", "b-long.txt": "x".repeat(5_000) }, { extra: LIMIT_100 });
  const checkpoint = join(paths.input, "..", "done.jsonl");
  try {
    assert.equal(await main(["pipes", "--config", paths.config, "--checkpoint", checkpoint], io()), 3);
    assert.equal(readFileSync(checkpoint, "utf8").trim(), '"a.txt"');
    const again = io();
    assert.equal(await main(["pipes", "--config", paths.config, "--checkpoint", checkpoint], again), 3);
    assert.match(again.out.join(""), /fetched 1, resumed 1, emitted 0, failed 1/);
  } finally {
    cleanup(paths);
  }
});

test("--checkpoint warns about an emitter that cannot take a second write, and says so once for the ones that can", async () => {
  const strict = workspace({ "a.txt": "content" }, { onExists: "EXCEPTION" });
  const lenient = workspace({ "a.txt": "content" }, { onExists: "SKIP" });
  try {
    const warned = io();
    assert.equal(await main(["pipes", "--config", strict.config, "--checkpoint", join(strict.input, "..", "done.jsonl")], warned), 0);
    assert.match(warned.err.join(""), /WARN: emitter fse has onExists EXCEPTION \(Tika's default\).*Set onExists to SKIP or REPLACE/);

    const quiet = io();
    assert.equal(await main(["pipes", "--config", lenient.config, "--checkpoint", join(lenient.input, "..", "done.jsonl")], quiet), 0);
    assert.equal(quiet.err.join(""), "");

    const noCheckpoint = io();
    assert.equal(await main(["pipes", "--config", strict.config, "--json"], noCheckpoint), 3, "onExists EXCEPTION fails the second write, as Tika's does");
    assert.equal(noCheckpoint.err.join("").includes("WARN"), false, "no checkpoint, nothing to warn about");
  } finally {
    cleanup(strict);
    cleanup(lenient);
  }
});

test("--checkpoint refuses a file it cannot read as a checkpoint, with exit 2, and runs nothing", async () => {
  const paths = workspace({ "a.txt": "content" });
  const checkpoint = join(paths.input, "..", "done.jsonl");
  try {
    writeFileSync(checkpoint, '["a.txt"]');
    const array = io();
    assert.equal(await main(["pipes", "--config", paths.config, "--checkpoint", checkpoint], array), 2);
    assert.match(array.err.join(""), /Corrupt checkpoint file .* JSON array/);

    writeFileSync(checkpoint, "not json\n");
    const garbage = io();
    assert.equal(await main(["pipes", "--config", paths.config, "--checkpoint", checkpoint], garbage), 2);
    assert.match(garbage.err.join(""), /Corrupt checkpoint file/);
    assert.deepEqual(emitted(paths), []);
  } finally {
    cleanup(paths);
  }
});

test("pipes parses in the isolation when one is asked for, and disposes it", async () => {
  const paths = workspace({ "a.txt": "content" }, { pipes: { parseMode: "CONTENT_ONLY" } });
  try {
    const log: { created: number; disposed: number; parsed: number } = { created: 0, disposed: 0, parsed: 0 };
    const createIsolation = (async () => {
      log.created++;
      return {
        isolator: { dispose: async () => void log.disposed++ },
        ripstream: {
          detect: async () => {
            throw new Error("not used");
          },
          parse: async () => {
            log.parsed++;
            return { text: "from the child", metadata: new Metadata() };
          },
          parseRecursive: async () => [],
        },
      };
    }) as unknown as NonNullable<CliDeps["createIsolation"]>;
    const sink = io();
    assert.equal(await main(["pipes", "--config", paths.config, "--isolation", "strict"], sink, { createIsolation, env: {} }), 0);
    assert.deepEqual(log, { created: 1, disposed: 1, parsed: 1 });
    assert.match(readFileSync(join(paths.output, "a.txt.json"), "utf8"), /from the child/);

    const off = io();
    assert.equal(await main(["pipes", "--config", paths.config], off, { createIsolation, env: {} }), 0);
    assert.equal(log.created, 1, "off unless asked for, like parse and metadata");
  } finally {
    cleanup(paths);
  }
});

/** Runs the built `ripstream` as a process, so it can be killed. */
function spawnRipstream(args: string[]): { process: ReturnType<typeof spawn>; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> } {
  const bin = join(import.meta.dirname, "..", "bin", "ripstream.js");
  const child = spawn(process.execPath, [bin, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
  return { process: child, done };
}

const completeLines = (path: string): string[] => {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter((line) => line !== "");
};

test("a run that is killed with SIGKILL resumes where its checkpoint says, and finishes the rest", async () => {
  const total = 600;
  const files: Record<string, string> = {};
  for (let index = 0; index < total; index++) files[`doc-${String(index).padStart(4, "0")}.txt`] = `content of document ${index} `.repeat(200);
  const paths = workspace(files);
  const checkpoint = join(paths.input, "..", "done.jsonl");
  try {
    const first = spawnRipstream(["pipes", "--config", paths.config, "--checkpoint", checkpoint, "--json"]);
    // Kill it as soon as it has finished some inputs and before it has finished them all.
    const deadline = Date.now() + 60_000;
    while (completeLines(checkpoint).length < 5) {
      if (Date.now() > deadline) assert.fail(`the run recorded ${completeLines(checkpoint).length} inputs in 60 s`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    first.process.kill("SIGKILL");
    const killed = await first.done;
    assert.equal(killed.signal, "SIGKILL");
    const recorded = completeLines(checkpoint).length;
    assert.ok(recorded >= 5 && recorded < total, `the run was killed part way (${recorded} of ${total} recorded)`);

    const second = spawnRipstream(["pipes", "--config", paths.config, "--checkpoint", checkpoint, "--json"]);
    const resumed = await second.done;
    assert.equal(resumed.code, 0, resumed.stderr);
    const stats = JSON.parse(resumed.stdout) as { fetched: number; resumed: number; emitted: number; failed: number };
    assert.equal(stats.resumed, recorded, "every complete line of the checkpoint was left out, and nothing else");
    assert.equal(stats.fetched, total - recorded);
    assert.equal(stats.emitted, total - recorded);
    assert.equal(stats.failed, 0);

    assert.equal(emitted(paths).length, total, "every input has its document");
    assert.equal(completeLines(checkpoint).length, total, "and is recorded");
    for (const name of [Object.keys(files)[0]!, Object.keys(files)[total - 1]!]) {
      assert.match(readFileSync(join(paths.output, `${name}.json`), "utf8"), /content of document/);
    }

    const third = await spawnRipstream(["pipes", "--config", paths.config, "--checkpoint", checkpoint, "--json"]).done;
    assert.equal(third.code, 0);
    assert.equal((JSON.parse(third.stdout) as { fetched: number; resumed: number }).resumed, total, "a finished run resumes to nothing");
  } finally {
    cleanup(paths);
  }
});

// ---- UNPACK: Tika's Frictionless package (tikajs-68os.6.7) ---------------------------------------------------------

/** Stored entries only, which is all a reader of the package needs of the container's own format. */
function storedZip(entries: Record<string, string>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc(data), 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The names of a zip's entries, read from its central directory. */
function entryNames(zip: Buffer): string[] {
  const names: string[] = [];
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(end + 16);
  for (let count = zip.readUInt16LE(end + 10); count > 0; count--) {
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    names.push(zip.subarray(at + 46, at + 46 + nameLength).toString("utf8"));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

test("pipes in UNPACK mode writes Tika's package, `<emitKey>-frictionless.zip`, by default", async () => {
  const paths = workspace({}, { pipes: { parseMode: "UNPACK" } });
  try {
    writeFileSync(join(paths.input, "outer.zip"), storedZip({ "one.txt": "first", "two.txt": "second" }));
    const sink = io();
    assert.equal(await main(["pipes", "--config", paths.config], sink), 0, sink.err.join(""));
    assert.deepEqual(emitted(paths), ["outer.zip-frictionless.zip"]);
    assert.deepEqual(entryNames(readFileSync(join(paths.output, "outer.zip-frictionless.zip"))), ["datapackage.json", "rmeta.json", "unpacked/1", "unpacked/2"]);
  } finally {
    cleanup(paths);
  }
});

test("pipes in UNPACK mode names a package's files by the media type registry when the configuration says DETECTED", async () => {
  const paths = workspace(
    {},
    { pipes: { parseMode: "UNPACK" }, extra: { "parse-context": { "unpack-config": { suffixStrategy: "DETECTED" } } } },
  );
  try {
    // Text and HTML carry a charset in Content-Type, which Tika's registry reads as no type: `.bin`. XML carries none.
    writeFileSync(join(paths.input, "outer.zip"), storedZip({ "one.txt": "first", "two.html": "<p>second</p>", "three.xml": "<a>third</a>" }));
    const sink = io();
    assert.equal(await main(["pipes", "--config", paths.config], sink), 0, sink.err.join(""));
    assert.deepEqual(entryNames(readFileSync(join(paths.output, "outer.zip-frictionless.zip"))), ["datapackage.json", "rmeta.json", "unpacked/1.bin", "unpacked/2.bin", "unpacked/3.xml"]);
  } finally {
    cleanup(paths);
  }
});

test("pipes in UNPACK mode refuses an unpack-config key it cannot honor, naming it, with exit 2 and nothing run", async () => {
  const paths = workspace(
    { "a.txt": "content" },
    { pipes: { parseMode: "UNPACK" }, extra: { "parse-context": { "unpack-config": { zipEmbeddedFiles: true } } } },
  );
  try {
    const sink = io();
    assert.equal(await main(["pipes", "--config", paths.config], sink), 2);
    assert.match(sink.err.join(""), /unpack-config: zipEmbeddedFiles is not supported/);
    assert.deepEqual(emitted(paths), []);
  } finally {
    cleanup(paths);
  }
});
