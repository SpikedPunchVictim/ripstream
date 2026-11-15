import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/*
 * Cold start: a plain `parse`, `detect` or `metadata` runs no isolation, pipes, server or language code and fetches no
 * URL, so it must not pay for loading them (and node:http / node:dns, ~30 ms by themselves). Each one is imported by the
 * command that needs it; this runs the CLI in a child and looks at what it loaded, so the saving cannot quietly regress.
 */

const MAIN = new URL("../src/main.ts", import.meta.url).href;

const PROBE = `
import { registerHooks } from "node:module";
const urls = [];
registerHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });
const { main } = await import(${JSON.stringify(MAIN)});
const code = await main(process.argv.slice(1), { stdout: () => {}, stderr: () => {}, readStdin: async () => new Uint8Array() });
const builtins = process.moduleLoadList.filter((name) => name.startsWith("NativeModule "));
console.log(JSON.stringify({ code, urls, builtins }));
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
