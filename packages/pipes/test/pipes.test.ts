import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LimitExceededError, Metadata } from "@spikedpunch/ripstream-core";
import {
  FlatFileEmitter,
  FileSystemFetcher,
  FileSystemPipesIterator,
  MemoryEmitter,
  PipesClient,
  PipesEngine,
  PipesPathError,
  createEngine,
  type PipesRipstream,
} from "../src/index.ts";
import { fileSystem } from "./helpers.ts";

test("runs filesystem pipes in content and rmeta modes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-pipes-"));
  try {
    writeFileSync(join(directory, "a.txt"), "alpha text");
    writeFileSync(join(directory, "b.txt"), "beta text");

    const content = new MemoryEmitter();
    const count = await new PipesEngine({
      ...fileSystem(directory),
      emitter: content,
      mode: "CONTENT_ONLY",
    }).run();
    assert.equal(count, 2);
    assert.deepEqual(
      content.documents.map((document) => document.id).sort(),
      ["a.txt", "b.txt"],
    );
    assert.match(content.documents.map((document) => document.text).join(""), /alpha text/);

    const rmeta = new MemoryEmitter();
    await new PipesEngine({
      ...fileSystem(directory),
      emitter: rmeta,
      mode: "RMETA",
    }).run();
    assert.equal(rmeta.documents[0]?.records?.length, 1);
    assert.match(rmeta.documents[0]?.text ?? "", /tk:content/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("writes filesystem output and builds from config", async () => {
  const input = mkdtempSync(join(tmpdir(), "ripstream-pipes-in-"));
  const output = mkdtempSync(join(tmpdir(), "ripstream-pipes-out-"));
  try {
    writeFileSync(join(input, "one.txt"), "file text");
    const engine = createEngine({
      source: { type: "filesystem", path: input },
      sink: { type: "filesystem", path: output },
      mode: "CONTENT_ONLY",
    });
    assert.equal(await engine.run(), 1);
    assert.deepEqual(readdirSync(output), ["one.txt.txt"]);
  } finally {
    rmSync(input, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("UNPACK, REGULAR, emits one document per parse record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-pipes-unpack-"));
  try {
    writeFileSync(join(directory, "one.txt"), "unpack text");
    const emitter = new MemoryEmitter();
    const count = await new PipesEngine({
      ...fileSystem(directory),
      emitter,
      mode: "UNPACK",
      unpack: { outputFormat: "REGULAR" },
    }).run();
    assert.equal(count, 1);
    assert.match(emitter.documents[0]?.text ?? "", /unpack text/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports stats and supports the embedded client", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-pipes-client-"));
  try {
    writeFileSync(join(directory, "one.txt"), "client text");
    const client = new PipesClient({
      source: { type: "filesystem", path: directory },
      mode: "CONTENT_ONLY",
    });
    const result = await client.run();
    assert.equal(result.count, 1);
    assert.equal(result.stats.fetched, 1);
    assert.equal(result.stats.emitted, 1);
    assert.equal(result.stats.failed, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded queue still drains every document", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-pipes-queue-"));
  try {
    for (let index = 0; index < 20; index++) {
      writeFileSync(join(directory, `f${index}.txt`), `text ${index}`);
    }
    const emitter = new MemoryEmitter();
    const count = await new PipesEngine({
      ...fileSystem(directory),
      emitter,
      concurrency: 2,
      maxQueue: 2,
    }).run();
    assert.equal(count, 20);
    assert.equal(emitter.documents.length, 20);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ordered mode emits in fetch order", async () => {
  const large = new Uint8Array(2 * 1024 * 1024).fill(0x61);
  const fetcher = {
    async *fetch() {
      yield { id: "first", data: large };
      yield { id: "second", data: new TextEncoder().encode("small") };
      yield { id: "third", data: new TextEncoder().encode("tiny") };
    },
  };
  const emitter = new MemoryEmitter();
  await new PipesEngine({
    source: fetcher,
    emitter,
    concurrency: 3,
    ordered: true,
    limits: { maxOutputChars: large.length * 2 },
  }).run();
  assert.deepEqual(
    emitter.documents.map((document) => document.id),
    ["first", "second", "third"],
  );
});

test("resolveWithinRoot rejects escapes, absolute paths and symlinks", async () => {
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const { resolveWithinRoot, PipesPathError } = await import("../src/index.ts");
  const base = mkdtempSync(join(tmpdir(), "ripstream-root-"));
  try {
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(root, "link"));
    const { realpath } = await import("node:fs/promises");
    assert.equal(await resolveWithinRoot(root, "."), await realpath(root));
    await resolveWithinRoot(root, "sub");
    await resolveWithinRoot(root, "sub/not-yet/created");
    for (const bad of ["..", "../outside", "sub/../../outside", "/etc", outside, "link", "link/x", "a\0b"]) {
      await assert.rejects(resolveWithinRoot(root, bad), PipesPathError, bad);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the file-system iterator skips, follows or leaves to the fetcher each symbolic link, and the fetcher confines them", async () => {
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "ripstream-sym-"));
  try {
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "inside.txt"), "inside");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "dir"));
    symlinkSync(join(outside, "secret.txt"), join(root, "file.txt"));
    symlinkSync(join(root, "inside.txt"), join(root, "link-inside.txt"));
    const keys = async (symlinks: "fetch" | "follow" | "skip"): Promise<string[]> => {
      const found: string[] = [];
      for await (const tuple of new FileSystemPipesIterator({ basePath: root, fetcherId: "fs", symlinks })) found.push(tuple.fetchKey);
      return found.sort();
    };
    assert.deepEqual(await keys("skip"), ["a.txt", "inside.txt"]);
    assert.deepEqual(await keys("fetch"), ["a.txt", "dir", "file.txt", "inside.txt", "link-inside.txt"]);
    assert.deepEqual(await keys("follow"), ["a.txt", "dir/secret.txt", "file.txt", "inside.txt", "link-inside.txt"]);

    // Tika's fetcher: a link that stays inside the base is read, one that leaves it is refused, whatever walked to it.
    const context = { signal: new AbortController().signal };
    const confined = new FileSystemFetcher({ basePath: root });
    assert.equal(new TextDecoder().decode(await confined.fetch("link-inside.txt", context)), "inside");
    await assert.rejects(confined.fetch("file.txt", context), PipesPathError);
    await assert.rejects(confined.fetch("dir/secret.txt", context), PipesPathError);
    await assert.rejects(confined.fetch("dir", context), /not a regular file|PipesPathError|descendant/);
    const trusting = new FileSystemFetcher({ basePath: root, confineSymlinks: false });
    assert.equal(new TextDecoder().decode(await trusting.fetch("file.txt", context)), "secret");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the file-system fetcher keeps every key under its basePath and refuses what Tika refuses", async () => {
  const base = mkdtempSync(join(tmpdir(), "ripstream-fetch-"));
  try {
    writeFileSync(join(base, "a.txt"), "a");
    const context = { signal: new AbortController().signal };
    const fetcher = new FileSystemFetcher({ basePath: base });
    assert.equal(new TextDecoder().decode(await fetcher.fetch("a.txt", context)), "a");
    for (const key of ["../a.txt", "sub/../../a.txt", join(tmpdir(), "x"), "a\u0000.txt"]) {
      await assert.rejects(fetcher.fetch(key, context), PipesPathError, key);
    }
    await assert.rejects(fetcher.fetch("missing.txt", context), /ENOENT/);
    await assert.rejects(new FileSystemFetcher({ basePath: join(base, "no-such-dir") }).fetch("a.txt", context), /basePath is not a directory/);
    assert.throws(() => new FileSystemFetcher(), /needs basePath, or allowAbsolutePaths/);
    assert.throws(() => new FileSystemFetcher({ basePath: "s3://bucket" }), /local directories only/);
    assert.throws(() => new FileSystemFetcher({ basePath: "/a\u0000" }), /NUL/);
    const open = new FileSystemFetcher({ allowAbsolutePaths: true });
    assert.equal(new TextDecoder().decode(await open.fetch(join(base, "a.txt"), context)), "a");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a fetcher that cannot list its inputs stops siblings, closes the emitter once and rejects with its error", async () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);
  const broken = new Error("listing broke");
  const fetcher = {
    async *fetch() {
      for (let index = 0; index < 12; index++) {
        if (index === 4) throw broken;
        yield { id: `doc${index}.txt`, data: text(`small ${index}`) };
      }
    },
  };
  class SpyEmitter extends MemoryEmitter {
    closes = 0;
    emits = 0;
    override async emit(document: Parameters<MemoryEmitter["emit"]>[0]): Promise<void> {
      this.emits++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await super.emit(document);
    }
    close(): void {
      this.closes++;
    }
  }
  const emitter = new SpyEmitter();
  const engine = new PipesEngine({ source: fetcher, emitter, concurrency: 3, maxQueue: 1 });
  await assert.rejects(engine.run(), (error) => error === broken);
  assert.equal(emitter.closes, 1);
  const emitsAtReject = emitter.emits;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(emitter.emits, emitsAtReject, "no emit after run() rejected");
  assert.equal(emitter.closes, 1);
  assert.ok(emitter.emits < 12, `siblings kept running: ${emitter.emits} emits`);
});

test("a document over a limit is that input's result: the run goes on and emits the rest", async () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);
  const fetcher = {
    async *fetch() {
      for (let index = 0; index < 12; index++) {
        yield { id: `doc${index}.txt`, data: index === 3 ? text("x".repeat(5000)) : text(`small ${index}`) };
      }
    },
  };
  const emitter = new MemoryEmitter();
  const engine = new PipesEngine({ source: fetcher, emitter, concurrency: 3, maxQueue: 1, limits: { maxOutputChars: 100 } });
  assert.equal(await engine.run(), 11);
  assert.equal(emitter.documents.length, 11);
  assert.ok(!emitter.documents.some((document) => document.id === "doc3.txt"));
  assert.equal(engine.stats.failed, 1);
  assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 11, PAYLOAD_LIMIT_EXCEEDED: 1 });
});

test("FlatFileEmitter keeps distinct unsafe ids in distinct files", async () => {
  const output = mkdtempSync(join(tmpdir(), "ripstream-emit-"));
  try {
    const emitter = new FlatFileEmitter(output);
    await emitter.emit({ id: "a/x", text: "slash" });
    await emitter.emit({ id: "a:x", text: "colon" });
    await emitter.emit({ id: "a_x", text: "underscore" });
    await emitter.emit({ id: "one.txt", text: "plain" });
    const files = readdirSync(output);
    assert.equal(files.length, 4);
    assert.ok(files.includes("one.txt.txt"));
    const contents = files.map((file) => readFileSync(join(output, file), "utf8")).sort();
    assert.deepEqual(contents, ["colon", "plain", "slash", "underscore"]);
    // Rerun-stable: same id maps to the same file.
    await emitter.emit({ id: "a/x", text: "slash2" });
    assert.equal(readdirSync(output).length, 4);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("a ripstream given to the engine does every parse; the default pipeline is never built", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-pipes-inject-"));
  try {
    writeFileSync(join(directory, "a.txt"), "alpha");
    const calls: string[] = [];
    const ripstream: PipesRipstream = {
      parse: async (_source, options) => {
        calls.push(`parse:${options?.filename}`);
        return { metadata: new Metadata(), text: "from the injected parser" };
      },
      parseRecursive: async (_source, options) => {
        calls.push(`parseRecursive:${options?.filename}`);
        return [];
      },
    };
    const content = new MemoryEmitter();
    await new PipesEngine({ ...fileSystem(directory), emitter: content, mode: "CONTENT_ONLY", ripstream }).run();
    assert.deepEqual(content.documents.map((document) => document.text), ["from the injected parser"]);
    const rmeta = new MemoryEmitter();
    await new PipesEngine({ ...fileSystem(directory), emitter: rmeta, mode: "RMETA", ripstream }).run();
    assert.deepEqual(calls, ["parse:a.txt", "parseRecursive:a.txt"]);

    const client = new PipesClient({ source: { type: "filesystem", path: directory }, mode: "CONTENT_ONLY" }, { ripstream });
    await client.run();
    assert.equal(calls.at(-1), "parse:a.txt");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a file-system fetcher hands the parser a path, not the whole body, in CONTENT_ONLY mode", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-pipes-path-"));
  try {
    writeFileSync(join(directory, "a.txt"), "alpha text");
    const seen: unknown[] = [];
    const ripstream = {
      parse: async (source: unknown) => {
        seen.push(source);
        return { metadata: new Metadata({ "Content-Type": "text/plain" }), text: "alpha text" };
      },
      parseRecursive: async () => [],
      detect: async () => new Metadata({ "Content-Type": "text/plain" }),
    } as unknown as PipesRipstream;
    const emitter = new MemoryEmitter();
    await new PipesEngine({ ...fileSystem(directory), emitter, mode: "CONTENT_ONLY", ripstream }).run();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { path: join(directory, "a.txt") });
    assert.equal(emitter.documents[0]?.text, "alpha text");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A parser that takes `ms` for every document and gives up when its signal fires, as a real parse does. */
function slowParser(ms: number, started: string[] = [], aborted: string[] = []): PipesRipstream {
  const wait = (name: string, signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      started.push(name);
      const timer = setTimeout(resolve, ms);
      const stop = (): void => {
        clearTimeout(timer);
        aborted.push(name);
        reject(signal?.reason);
      };
      if (signal?.aborted === true) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    });
  return {
    parse: async (_source, options) => {
      await wait(options?.filename ?? "?", options?.signal);
      return { metadata: new Metadata(), text: "text" };
    },
    parseRecursive: async () => [],
    detect: async () => new Metadata({ "Content-Type": "text/plain" }),
  } as unknown as PipesRipstream;
}

test("a run whose signal fires stops starting files, aborts the parses in flight and keeps what was written", async () => {
  const input = mkdtempSync(join(tmpdir(), "ripstream-pipes-signal-in-"));
  const output = mkdtempSync(join(tmpdir(), "ripstream-pipes-signal-out-"));
  try {
    for (let index = 0; index < 100; index++) writeFileSync(join(input, `f${String(index).padStart(3, "0")}.txt`), `file ${index}`);
    const started: string[] = [];
    const aborted: string[] = [];
    const controller = new AbortController();
    const client = new PipesClient(
      { source: { type: "filesystem", path: input }, sink: { type: "filesystem", path: output }, mode: "CONTENT_ONLY", concurrency: 2 },
      { ripstream: slowParser(20, started, aborted), signal: controller.signal },
    );
    const run = client.run();
    setTimeout(() => controller.abort(new Error("client went away")), 150);
    await assert.rejects(run, /client went away/);
    const written = readdirSync(output).length;
    assert.ok(written > 0 && written < 100, `partial output stays on disk: ${written} of 100`);
    const startedAtAbort = started.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(started.length, startedAtAbort, "no file is started after the abort");
    assert.equal(readdirSync(output).length, written, "nothing is written after the abort");
    assert.ok(aborted.length > 0, "a parse that was in flight was aborted");
  } finally {
    rmSync(input, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("a run whose signal has fired already starts nothing", async () => {
  const input = mkdtempSync(join(tmpdir(), "ripstream-pipes-signal-in-"));
  try {
    writeFileSync(join(input, "a.txt"), "alpha");
    const started: string[] = [];
    const emitter = new MemoryEmitter();
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    await assert.rejects(
      new PipesEngine({ ...fileSystem(input), emitter, mode: "CONTENT_ONLY", ripstream: slowParser(1, started), signal: controller.signal }).run(),
      /already gone/,
    );
    assert.deepEqual(started, []);
    assert.equal(emitter.documents.length, 0);
  } finally {
    rmSync(input, { recursive: true, force: true });
  }
});

test("an ordered run whose signal fires stops too", async () => {
  const input = mkdtempSync(join(tmpdir(), "ripstream-pipes-signal-in-"));
  try {
    for (let index = 0; index < 50; index++) writeFileSync(join(input, `f${index}.txt`), `file ${index}`);
    const emitter = new MemoryEmitter();
    const controller = new AbortController();
    const run = new PipesEngine({
      ...fileSystem(input),
      emitter,
      mode: "CONTENT_ONLY",
      ordered: true,
      concurrency: 2,
      ripstream: slowParser(20),
      signal: controller.signal,
    }).run();
    setTimeout(() => controller.abort(new Error("stop")), 100);
    await assert.rejects(run, /stop/);
    assert.ok(emitter.documents.length < 50);
  } finally {
    rmSync(input, { recursive: true, force: true });
  }
});
