import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUNDLE_DIRECTORY, ROOT, SKIP_WITHOUT_BUNDLE, STUB } from "./bundle-support.ts";

/*
 * What only the bundle can get wrong: the files it finds next to itself (isolation child, pipes worker, language model,
 * sql.js and pdf.js assets) and the stub that picks it and switches on the compile cache (docs/cli-startup.md).
 * `bin/ripstream.js` runs the bundle when it is built, so these go through the stub, as a user's command does.
 */

const BASE_ENV = { ...process.env, RIPSTREAM_NO_BUNDLE: undefined, RIPSTREAM_ISOLATION: undefined, RIPSTREAM_WORKERS: undefined, NODE_COMPILE_CACHE: undefined };

function ripstream(args: readonly string[], env: Record<string, string | undefined> = {}): { code: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [STUB, ...args], { encoding: "utf8", cwd: ROOT, env: { ...BASE_ENV, ...env } });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function withDirectory<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ripstream-bundle-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the bundle carries the sibling entries the code looks up next to itself", { skip: SKIP_WITHOUT_BUNDLE }, () => {
  const names = readdirSync(BUNDLE_DIRECTORY);
  for (const entry of ["run.js", "isolation-child.js", "probe-child.js", "parse-worker.js"]) assert.ok(names.includes(entry), entry);
  assert.ok(existsSync(join(BUNDLE_DIRECTORY, "../data/langdetect-20260320.bin")), "the language model sits in data/ next to dist/");
});

test("parse --isolation strict works from the bundle (the isolation child is the bundle's)", { skip: SKIP_WITHOUT_BUNDLE }, () =>
  withDirectory((dir) => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello isolated bundle\n");
    const run = ripstream(["parse", "--isolation", "strict", file]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout.trim(), "hello isolated bundle");
  }));

test("parse --isolation strict of a database works from the bundle (sql.js and its wasm stay external)", { skip: SKIP_WITHOUT_BUNDLE }, () => {
  const run = ripstream(["parse", "--isolation", "strict", join(ROOT, "packages/parser-db/test/fixtures/gdal-byte.gpkg")]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /WGS 84 geodetic/);
});

test("language works from the bundle (the model is found in data/)", { skip: SKIP_WITHOUT_BUNDLE }, () =>
  withDirectory((dir) => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "The quick brown fox jumps over the lazy dog and keeps running through the forest for a long time.\n");
    const run = ripstream(["language", file]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /en/);
  }));

test("pipes --workers 2 works from the bundle (the worker entry is the bundle's)", { skip: SKIP_WITHOUT_BUNDLE }, () =>
  withDirectory((dir) => {
    const input = join(dir, "in");
    mkdirSync(input);
    for (const name of ["a", "b", "c", "d"]) writeFileSync(join(input, `${name}.txt`), `document ${name}\n`);
    const config = join(dir, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
        emitters: { fse: { "file-system-emitter": { basePath: join(dir, "out"), fileExtension: "json", onExists: "REPLACE" } } },
        "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
      }),
    );
    const run = ripstream(["pipes", "--config", config, "--workers", "2"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /fetched 4, resumed 0, emitted 4, failed 0/);
    assert.equal(readdirSync(join(dir, "out")).length, 4);
  }));

test("RIPSTREAM_NO_BUNDLE runs dist and gives the same answer", { skip: SKIP_WITHOUT_BUNDLE }, () =>
  withDirectory((dir) => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "same either way\n");
    const bundled = ripstream(["parse", file]);
    const dist = ripstream(["parse", file], { RIPSTREAM_NO_BUNDLE: "1" });
    assert.equal(dist.code, 0, dist.stderr);
    assert.deepEqual(dist, bundled);
    // "0" and "" mean not set.
    assert.deepEqual(ripstream(["parse", file], { RIPSTREAM_NO_BUNDLE: "0" }), bundled);
  }));

test("a compile cache that cannot be written is harmless", { skip: SKIP_WITHOUT_BUNDLE }, () =>
  withDirectory((dir) => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "no cache, no problem\n");
    // NODE_COMPILE_CACHE under a file: cannot be created.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const named = ripstream(["parse", file], { NODE_COMPILE_CACHE: join(blocker, "cache") });
    assert.equal(named.code, 0, named.stderr);
    assert.equal(named.stdout.trim(), "no cache, no problem");
    assert.equal(named.stderr, "");
    // The default per-user directory under a temp directory that is read-only (a no-op when the user can write anyway, as root can).
    const readOnly = join(dir, "ro");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o555);
    const defaulted = ripstream(["parse", file], { TMPDIR: readOnly, TMP: readOnly, TEMP: readOnly });
    assert.equal(defaulted.code, 0, defaulted.stderr);
    assert.equal(defaulted.stdout.trim(), "no cache, no problem");
    assert.equal(defaulted.stderr, "");
    chmodSync(readOnly, 0o755);
  }));

test("the compile cache lands in NODE_COMPILE_CACHE, never in the package", { skip: SKIP_WITHOUT_BUNDLE }, () =>
  withDirectory((dir) => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "cache me\n");
    const cache = join(dir, "cache");
    const run = ripstream(["parse", file], { NODE_COMPILE_CACHE: cache });
    assert.equal(run.code, 0, run.stderr);
    assert.ok(existsSync(cache) && readdirSync(cache).length > 0, "the cache directory was filled");
    assert.ok(!existsSync(join(ROOT, "packages/cli/bundle/.cache")));
  }));
