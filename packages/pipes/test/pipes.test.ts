import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LimitExceededError } from "@spikedpunch/ripstream-core";
import {
  FileSystemEmitter,
  FileSystemFetcher,
  MemoryEmitter,
  PipesClient,
  PipesEngine,
  createEngine,
} from "../src/index.ts";

test("runs filesystem pipes in content and rmeta modes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-pipes-"));
  try {
    writeFileSync(join(directory, "a.txt"), "alpha text");
    writeFileSync(join(directory, "b.txt"), "beta text");

    const content = new MemoryEmitter();
    const count = await new PipesEngine({
      fetcher: new FileSystemFetcher(directory),
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
      fetcher: new FileSystemFetcher(directory),
      emitter: rmeta,
      mode: "RMETA",
    }).run();
    assert.equal(rmeta.documents[0]?.records?.length, 1);
    assert.match(rmeta.documents[0]?.text ?? "", /X-TIKA:content/);
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

test("UNPACK emits one document per parse record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-pipes-unpack-"));
  try {
    writeFileSync(join(directory, "one.txt"), "unpack text");
    const emitter = new MemoryEmitter();
    const count = await new PipesEngine({
      fetcher: new FileSystemFetcher(directory),
      emitter,
      mode: "UNPACK",
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
      fetcher: new FileSystemFetcher(directory),
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
    fetcher,
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

test("FileSystemFetcher skips symlinks when followSymlinks is false", async () => {
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "ripstream-sym-"));
  try {
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "dir"));
    symlinkSync(join(outside, "secret.txt"), join(root, "file.txt"));
    const ids = async (follow: boolean): Promise<string[]> => {
      const found: string[] = [];
      for await (const doc of new FileSystemFetcher(root, { followSymlinks: follow }).fetch()) found.push(doc.id);
      return found.sort();
    };
    assert.deepEqual(await ids(false), ["a.txt"]);
    assert.deepEqual(await ids(true), ["a.txt", "dir/secret.txt", "file.txt"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a worker failure stops siblings, closes the emitter once and rejects with the original error", async () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);
  const fetcher = {
    async *fetch() {
      for (let index = 0; index < 12; index++) {
        yield {
          id: `doc${index}.txt`,
          data: index === 3 ? text("x".repeat(5000)) : text(`small ${index}`),
        };
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
  const engine = new PipesEngine({
    fetcher,
    emitter,
    concurrency: 3,
    maxQueue: 1,
    limits: { maxOutputChars: 100 },
  });
  await assert.rejects(engine.run(), LimitExceededError);
  assert.equal(emitter.closes, 1);
  assert.equal(engine.stats.failed, 1);
  const emitsAtReject = emitter.emits;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(emitter.emits, emitsAtReject, "no emit after run() rejected");
  assert.equal(emitter.closes, 1);
  assert.ok(emitter.emits < 11, `siblings kept running: ${emitter.emits} emits`);
});

test("FileSystemEmitter keeps distinct unsafe ids in distinct files", async () => {
  const output = mkdtempSync(join(tmpdir(), "ripstream-emit-"));
  try {
    const emitter = new FileSystemEmitter(output);
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
