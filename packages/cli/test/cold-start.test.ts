import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/*
 * Cold start: a plain `parse`, `detect` or `metadata` runs no isolation, pipes, server or language code and fetches no
 * URL, so it must not pay for loading them (and node:http / node:dns, ~30 ms by themselves). Each one is imported by the
 * command that needs it; this runs the CLI in a child and looks at what it loaded, so the saving cannot quietly regress.
 */

const MAIN = new URL("../src/main.ts", import.meta.url).href;

// `threads` counts the worker threads started: Worker is wrapped before anything imports it.
const PROBE = `
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
const urls = [];
registerHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });
const threading = createRequire(import.meta.url)("node:worker_threads");
let threads = 0;
threading.Worker = class extends threading.Worker { constructor(...args) { threads++; super(...args); } };
syncBuiltinESMExports();
const { main } = await import(${JSON.stringify(MAIN)});
const code = await main(process.argv.slice(1), { stdout: () => {}, stderr: () => {}, readStdin: async () => new Uint8Array() });
const builtins = process.moduleLoadList.filter((name) => name.startsWith("NativeModule "));
console.log(JSON.stringify({ code, urls, builtins, threads }));
`;

const NOT_LOADED_PACKAGES = ["isolation-node", "pipes", "server", "language", "bundle-standard"];
const NOT_LOADED_BUILTINS = ["NativeModule http", "NativeModule https", "NativeModule dns/promises"];

function loadedBy(command: string): { urls: string[]; builtins: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "ripstream-cold-"));
  try {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello cold start\n");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", PROBE, command, file], { encoding: "utf8" });
    const probe = JSON.parse(out) as { code: number; urls: string[]; builtins: string[] };
    assert.equal(probe.code, 0);
    return probe;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const command of ["parse", "detect", "metadata"]) {
  test(`${command} loads no isolation, pipes, server, language or networking code`, () => {
    const { urls, builtins } = loadedBy(command);
    const packages = NOT_LOADED_PACKAGES.filter((name) => urls.some((url) => url.includes(`/packages/${name}/`)));
    assert.deepEqual(packages, []);
    assert.deepEqual(builtins.filter((name) => NOT_LOADED_BUILTINS.includes(name)), []);
  });
}

// `pipes --workers` (tikajs-ow39): the pool is its own subpath, imported only when workers are asked for, so a pipes
// run without them loads none of it and starts no thread. (node:worker_threads itself is loaded either way: fflate
// imports it.)

/** Runs `pipes` over one text file in a child, with `extra` flags, and returns what it loaded and how many threads it started. */
function loadedByPipes(extra: readonly string[]): { urls: string[]; threads: number } {
  const dir = mkdtempSync(join(tmpdir(), "ripstream-cold-"));
  try {
    const input = join(dir, "in");
    mkdirSync(input);
    writeFileSync(join(input, "a.txt"), "hello cold start\n");
    const config = join(dir, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
        emitters: { fse: { "file-system-emitter": { basePath: join(dir, "out"), fileExtension: "json", onExists: "REPLACE" } } },
        "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
      }),
    );
    // The shell's own settings must not decide which way the run goes.
    const env = { ...process.env, RIPSTREAM_WORKERS: undefined, RIPSTREAM_ISOLATION: undefined };
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", PROBE, "pipes", "--config", config, ...extra], { encoding: "utf8", env });
    const probe = JSON.parse(out) as { code: number; urls: string[]; threads: number };
    assert.equal(probe.code, 0);
    return probe;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const POOL_MODULES = /\/packages\/pipes\/(src|dist)\/(workers|parse-pool|parse-worker[^/]*)\.(ts|js)$/;

test("pipes without --workers loads none of the worker pool and starts no thread", () => {
  const { urls, threads } = loadedByPipes([]);
  assert.ok(urls.some((url) => url.includes("/packages/pipes/")), "the run loaded pipes, so the probe sees its modules");
  assert.deepEqual(urls.filter((url) => POOL_MODULES.test(url)), []);
  assert.equal(threads, 0);
});

test("pipes --workers 2 loads the worker pool (what the test above looks for is what a pool loads)", () => {
  const { urls, threads } = loadedByPipes(["--workers", "2"]);
  assert.ok(urls.some((url) => POOL_MODULES.test(url)), urls.filter((url) => url.includes("/pipes/")).join("\n"));
  assert.equal(threads, 2);
});
