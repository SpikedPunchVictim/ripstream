import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
