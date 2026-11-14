import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LimitExceededError } from "@spikedpunch/ripstream-core";
import {
  FileSystemFetcher,
  FileSystemPipesIterator,
  FlatFileEmitter,
  MemoryEmitter,
  PipesEngine,
  type FetchEmitTuple,
} from "../src/index.ts";
import { assertValidFilter } from "../src/adapters.ts";
import { GcsClient } from "../src/gcs/client.ts";
import { S3Client } from "../src/s3/client.ts";
import { AzBlobClient } from "../src/azblob/client.ts";

/*
 * Where a run meets the file system and the object stores: a tree that links to itself, ids that name the same file,
 * a link that leads out of the output directory, and keys and bodies a fetch cannot be trusted to carry.
 */

async function scratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ripstream-hardening-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function listed(iterator: AsyncIterable<FetchEmitTuple>): Promise<string[]> {
  const ids: string[] = [];
  for await (const tuple of iterator) ids.push(tuple.id);
  return ids;
}

const follow = (basePath: string): FileSystemPipesIterator => new FileSystemPipesIterator({ basePath, fetcherId: "f", symlinks: "follow" });

test("a link back to a directory above it is not walked into, in follow mode", async () => {
  await scratch(async (directory) => {
    await writeFile(join(directory, "f.txt"), "x");
    await symlink(".", join(directory, "a"));
    await symlink(".", join(directory, "b"));
    const ids = await Promise.race([
      listed(follow(directory)),
      new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error("the walk did not end")), 5000)),
    ]);
    assert.ok(ids.includes("f.txt"));
    assert.ok(ids.length <= 3, ids.join(", "));
  });
});

test("a directory linked twice is listed under both links, as Tika's walk does", async () => {
  await scratch(async (directory) => {
    await mkdir(join(directory, "real"));
    await writeFile(join(directory, "real", "f.txt"), "x");
    await symlink("real", join(directory, "one"));
    await symlink("real", join(directory, "two"));
    assert.deepEqual(await listed(follow(directory)), ["one/f.txt", "real/f.txt", "two/f.txt"]);
  });
});

test("a file name with a backslash keeps it in its key, so the key names the file", { skip: process.platform === "win32" }, async () => {
  await scratch(async (directory) => {
    await writeFile(join(directory, "a\\b.txt"), "slash");
    const iterator = new FileSystemPipesIterator({ basePath: directory, fetcherId: "f" });
    const [tuple] = [...(await collect(iterator))];
    assert.equal(tuple?.fetchKey, "a\\b.txt");
    const bytes = await new FileSystemFetcher({ basePath: directory }).fetch(tuple?.fetchKey ?? "", { signal: new AbortController().signal });
    assert.equal(Buffer.from(bytes).toString(), "slash");
  });
});

async function collect(iterator: AsyncIterable<FetchEmitTuple>): Promise<FetchEmitTuple[]> {
  const out: FetchEmitTuple[] = [];
  for await (const tuple of iterator) out.push(tuple);
  return out;
}

test("ids that differ only in case, or are empty, do not share an output file", async () => {
  await scratch(async (directory) => {
    const emitter = new FlatFileEmitter(directory);
    for (const [id, text] of [["Report", "upper"], ["report", "lower"], ["", "empty"], ["document", "named"]] as const) {
      await emitter.emit({ id, mode: "CONTENT_ONLY", text });
    }
    const names = (await readdir(directory)).map((name) => name.toLowerCase());
    assert.equal(new Set(names).size, 4, names.join(", "));
    const texts = await Promise.all((await readdir(directory)).map((name) => readFile(join(directory, name), "utf8")));
    assert.deepEqual(texts.sort(), ["empty", "lower", "named", "upper"]);
  });
});

test("a lower-case id keeps its name in the flat sink", async () => {
  await scratch(async (directory) => {
    await new FlatFileEmitter(directory).emit({ id: "report-2024.v1", mode: "CONTENT_ONLY", text: "x" });
    assert.deepEqual(await readdir(directory), ["report-2024.v1.txt"]);
  });
});

test("a run that fails closes the source it was reading", async () => {
  let closed = false;
  async function* source(): AsyncGenerator<FetchEmitTuple> {
    try {
      for (let index = 0; index < 100; index++) yield { id: `k${index}`, fetcher: "map", fetchKey: "a" };
    } finally {
      closed = true;
    }
  }
  const engine = new PipesEngine({
    iterator: source(),
    fetchers: { map: { fetch: async () => new TextEncoder().encode("x") } },
    emitter: new MemoryEmitter(),
    reporter: {
      report() {
        throw new Error("reporter down");
      },
    },
  });
  await assert.rejects(engine.run(), /reporter down/);
  assert.equal(closed, true);
});

const never = (async () => {
  throw new Error("no request should be made");
}) as typeof fetch;

test("S3 and GCS refuse a key with a dot segment, as Azure does, before any request", async () => {
  const s3 = new S3Client({
    region: "us-east-1",
    bucket: "b",
    credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }),
    pathStyle: true,
    endpoint: "http://s3.example",
    fetchImpl: never,
  });
  const gcs = new GcsClient({ bucket: "b", token: async () => "t", fetchImpl: never });
  for (const key of ["..", "a/../b", "./a"]) {
    await assert.rejects(s3.get(key), /"\.\.?" segment|"\." or "\.\." segment/, key);
    await assert.rejects(gcs.get(key), /segment/, key);
  }
});

const sized = (length: number | null, chunks: number): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks-- <= 0) controller.close();
        else controller.enqueue(new Uint8Array(1024));
      },
    }),
    length === null ? {} : { headers: { "content-length": String(length) } },
  );

test("a cloud object is capped as it arrives, whatever length it declares", async () => {
  const gcs = (response: () => Response): GcsClient => new GcsClient({ bucket: "b", token: async () => "t", fetchImpl: (async () => response()) as typeof fetch });
  await assert.rejects(gcs(() => sized(null, 1000)).get("o", { maxLength: 4096 }), LimitExceededError);
  await assert.rejects(gcs(() => sized(1_000_000, 1)).get("o", { maxLength: 4096 }), LimitExceededError);
  assert.equal((await gcs(() => sized(null, 3)).get("o", { maxLength: 4096 })).length, 3072);
  assert.equal((await gcs(() => sized(null, 8)).get("o", { maxLength: -1 })).length, 8192);

  const azure = new AzBlobClient({ endpoint: "http://az.example", container: "c", sasToken: "sv=1" }, { fetchImpl: (async () => sized(null, 1000)) as typeof fetch });
  await assert.rejects(azure.get("b", { maxLength: 4096 }), LimitExceededError);

  const s3 = new S3Client({
    region: "us-east-1",
    bucket: "b",
    credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }),
    pathStyle: true,
    endpoint: "http://s3.example",
    fetchImpl: (async () => sized(null, 1000)) as typeof fetch,
  });
  await assert.rejects(s3.get("o", { maxLength: 4096 }), /longer than the maxLength of 4096/);
});

test("a reporter filter names a status Tika has, not a property every object has", () => {
  assert.throws(() => assertValidFilter({ includes: ["constructor" as never] }), /names no result status/);
  assert.throws(() => assertValidFilter({ excludes: ["__proto__" as never] }), /names no result status/);
  assertValidFilter({ includes: ["TIMEOUT"] });
});
