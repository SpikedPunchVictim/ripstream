import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CALL_DIR_PREFIX } from "../src/disk.ts";
import { createNodeIsolator } from "../src/isolator.ts";
import { permissionArgs, permissionExecArgv } from "../src/permission.ts";
import { CHILD } from "./fixtures/helpers.ts";

/** tikajs-bcnh: the opt-in permission model for the child. */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ripstream-permission-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BUNDLE_CHILD = join(ROOT, "packages/bundle-standard/src/isolation-child.ts");
const args = permissionArgs({ childModule: BUNDLE_CHILD, tempDir: scratch });
const flag = (name: string): string[] => args.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3));

test("the args turn the model on and allow what a child needs: its packages and its call directories", () => {
  assert.equal(args[0], "--permission=true");
  const read = flag("allow-fs-read");
  for (const path of [join(ROOT, "packages/core/dist"), join(ROOT, "packages/core/package.json"), join(ROOT, "packages/isolation-node/dist")]) {
    assert.ok(read.includes(path), `${path} is readable`);
  }
  assert.ok(read.includes(join(ROOT, "node_modules")), "the root node_modules is readable");
  assert.ok(flag("allow-fs-write").every((path) => path.endsWith(`/${CALL_DIR_PREFIX}*`)) && flag("allow-fs-write").includes(join(scratch, `${CALL_DIR_PREFIX}*`)));
  assert.ok(read.includes(join(scratch, `${CALL_DIR_PREFIX}*`)));
  assert.ok(!read.includes(join(ROOT, "packages/core")) && !read.includes(join(ROOT, "packages/core/src")), "a package's sources are not");
});

test("the args never allow a process, a worker or an addon", () => {
  assert.deepEqual(args.filter((arg) => !/^--(permission=true|allow-fs-(read|write)=)/.test(arg)), []);
});

test("a caller's execArgv follows the args and cannot widen them", () => {
  assert.deepEqual(permissionExecArgv({ childModule: CHILD, tempDir: scratch }, ["--no-warnings"]).slice(-1), ["--no-warnings"]);
  for (const widening of ["--allow-child-process=true", "--allow-worker=true", "--allow-addons=true", "--allow-fs-read=/", "--permission=false"]) {
    assert.throws(() => permissionExecArgv({ childModule: CHILD, tempDir: scratch }, [widening]), /would widen or replace/, widening);
  }
});

test("under the args, a write outside the call directory and a spawn are denied, a write in it is not", () => {
  const callDir = join(scratch, `${CALL_DIR_PREFIX}probe`);
  mkdirSync(callDir);
  const outside = join(scratch, "outside.txt");
  const script = join(dirname(CHILD), "permission-probe.mjs");
  const run = spawnSync(process.execPath, [...permissionArgs({ childModule: CHILD, tempDir: scratch }), script, callDir, outside], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    writeCallDir: "allowed",
    writeOutside: "ERR_ACCESS_DENIED",
    readOutside: "ERR_ACCESS_DENIED",
    spawn: "ERR_ACCESS_DENIED",
    worker: "ERR_ACCESS_DENIED",
  });
});

test("an isolator with permission refuses a caller's widening execArgv at construction", async () => {
  await assert.rejects(
    createNodeIsolator({
      config: { mode: "strict" },
      ripstream: { detect: async () => { throw new Error("unused"); }, parse: async () => { throw new Error("unused"); }, parseRecursive: async () => { throw new Error("unused"); } },
      childModule: CHILD,
      permission: true,
      runner: { execArgv: ["--allow-child-process=true"] },
    }),
    /would widen or replace/,
  );
});
