import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUNDLE_DIRECTORY, BUNDLE_ENTRY, SKIP_WITHOUT_BUNDLE, bundleFiles, packagesIn, staticGraph } from "./bundle-support.ts";

/*
 * Cold start, bundle edition (cold-start.test.ts is the same guard for `dist`). The bundle's chunks have hashed names, so
 * that test's "/packages/<name>/" URL check cannot see them. Instead: the entry's STATIC import graph (what loads before the
 * CLI runs a line) must hold none of the code a plain parse does not need, and a real run must load only files of that
 * graph. If a command's lazy import() turns into a static import, or a shared helper drags a package into the entry's
 * chunks, one of these fails.
 */

// Same lists as cold-start.test.ts.
const NOT_LOADED_PACKAGES = ["isolation-node", "pipes", "server", "language", "bundle-standard"];
const NOT_LOADED_BUILTINS = ["NativeModule http", "NativeModule https", "NativeModule dns/promises"];
const NETWORK_IMPORT = /^(?:import|export)(?=[\s{*"'])[^"'`;]*?["']node:(?:http|https|dns|dns\/promises)["']/m;

test("the entry's static import graph holds no isolation, pipes, server, language or bundle-standard code", { skip: SKIP_WITHOUT_BUNDLE }, () => {
  const graph = staticGraph("run.js");
  assert.ok(graph.size > 1, "the entry has chunks, so the check reads something");
  assert.ok([...graph].some((file) => packagesIn(file).has("parsers")), "the graph holds the parsers, so packagesIn reads the chunks");
  const leaked: string[] = [];
  for (const file of graph) {
    for (const name of packagesIn(file)) if (NOT_LOADED_PACKAGES.includes(name)) leaked.push(`${file} holds ${name}`);
  }
  assert.deepEqual(leaked, []);
});

test("each lazy package is in a chunk the entry does not load statically (so the check above reads what it should)", { skip: SKIP_WITHOUT_BUNDLE }, () => {
  const graph = staticGraph("run.js");
  for (const name of NOT_LOADED_PACKAGES) {
    const holders = bundleFiles().filter((file) => packagesIn(file).has(name));
    assert.ok(holders.length > 0, `${name} is in the bundle`);
    assert.ok(
      holders.every((file) => !graph.has(file)),
      `${name} is in a file the entry loads statically: ${holders.filter((file) => graph.has(file)).join(", ")}`,
    );
  }
});

test("the entry's static import graph imports no networking builtin", { skip: SKIP_WITHOUT_BUNDLE }, () => {
  const importing = [...staticGraph("run.js")].filter((file) => NETWORK_IMPORT.test(readFileSync(join(BUNDLE_DIRECTORY, file), "utf8")));
  assert.deepEqual(importing, []);
});

// Runs the bundle's entry as `ripstream <command> <file>` in a child that records every module it loads.
const PROBE = `
import { registerHooks } from "node:module";
const urls = [];
registerHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });
process.on("exit", (code) => {
  const builtins = process.moduleLoadList.filter((name) => name.startsWith("NativeModule "));
  process.stderr.write("PROBE" + JSON.stringify({ code, urls, builtins }));
});
await import(${JSON.stringify(BUNDLE_ENTRY)});
`;

for (const command of ["parse", "detect", "metadata"]) {
  test(`${command} from the bundle loads only the entry's static graph and no networking builtin`, { skip: SKIP_WITHOUT_BUNDLE }, () => {
    const dir = mkdtempSync(join(tmpdir(), "ripstream-bundle-cold-"));
    try {
      const file = join(dir, "a.txt");
      writeFileSync(file, "hello cold start\n");
      // argv[1] is the `-e` script's placeholder; the CLI reads argv from index 2.
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE, command, file], { encoding: "utf8" });
      const report = run.stderr.slice(run.stderr.indexOf("PROBE") + "PROBE".length);
      const probe = JSON.parse(report) as { code: number; urls: string[]; builtins: string[] };
      assert.equal(probe.code, 0, run.stderr);
      const loaded = probe.urls.filter((url) => url.includes("/bundle/dist/")).map((url) => url.slice(url.lastIndexOf("/") + 1));
      assert.ok(loaded.includes("run.js"), "the probe saw the bundle load");
      const graph = staticGraph("run.js");
      assert.deepEqual(loaded.filter((name) => !graph.has(name)), []);
      assert.deepEqual(probe.builtins.filter((name) => NOT_LOADED_BUILTINS.includes(name)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
