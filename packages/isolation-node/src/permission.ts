import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CALL_DIR_PREFIX } from "./disk.ts";

/** `childModule`: the child entry, its package is readable. `tempDir`: default os.tmpdir(). */
export interface PermissionArgsOptions {
  readonly childModule: string;
  readonly tempDir?: string;
}

const real = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** A workspace package: dist, package.json, node_modules, then its dependencies. An installed one: its node_modules root. */
function allow(dir: string, read: Set<string>): void {
  const parts = dir.split(sep);
  const installed = parts.indexOf("node_modules");
  if (installed >= 0) return void read.add(parts.slice(0, installed + 1).join(sep));
  const manifest = join(dir, "package.json");
  if (read.has(manifest)) return;
  for (const path of [manifest, join(dir, "dist"), join(dir, "node_modules")]) {
    const found = real(path);
    if (found !== null) read.add(found);
  }
  const { dependencies } = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string> };
  for (const name of Object.keys({ ...dependencies })) {
    const dependency = real(join(dir, "node_modules", name));
    if (dependency !== null) allow(dependency, read);
  }
}

/** `node` flags: read the child's packages, write only `CALL_DIR_PREFIX*` in `tempDir`; no process, worker or addon. Not the network. */
export function permissionArgs(options: PermissionArgsOptions): string[] {
  const read = new Set<string>();
  for (const entry of [options.childModule, fileURLToPath(import.meta.url)]) {
    const file = real(entry);
    if (file === null) continue;
    read.add(dirname(file));
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      if (existsSync(join(dir, "package.json"))) {
        allow(dir, read);
        break;
      }
      if (dirname(dir) === dir) break;
    }
  }
  const temp = options.tempDir ?? tmpdir();
  const calls = [temp, real(temp) ?? temp].map((dir) => join(dir, `${CALL_DIR_PREFIX}*`));
  return [
    "--permission=true",
    ...[...read, ...calls].map((path) => `--allow-fs-read=${path}`),
    ...calls.map((path) => `--allow-fs-write=${path}`),
  ];
}

export function permissionExecArgv(options: PermissionArgsOptions, execArgv: readonly string[] = []): string[] {
  const widening = execArgv.find((arg) => /^--(allow-|permission|experimental-permission)/.test(arg));
  if (widening !== undefined) throw new TypeError(`permission: execArgv ${JSON.stringify(widening)} would widen or replace it`);
  return [...permissionArgs(options), ...execArgv];
}
