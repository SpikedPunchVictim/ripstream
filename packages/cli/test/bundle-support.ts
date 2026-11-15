import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The repository root, and where the CLI's `dist` and split bundle (pnpm build:bundle, docs/cli-startup.md) put their entries. */
export const ROOT = new URL("../../..", import.meta.url).pathname;
export const STUB = join(ROOT, "packages/cli/bin/ripstream.js");
export const DIST_ENTRY = join(ROOT, "packages/cli/dist/run.js");
export const BUNDLE_DIRECTORY = join(ROOT, "packages/cli/bundle/dist");
export const BUNDLE_ENTRY = join(BUNDLE_DIRECTORY, "run.js");

/** What `test(..., { skip })` takes: a reason when the bundle is not built, else false. */
export const SKIP_WITHOUT_BUNDLE: string | false = existsSync(BUNDLE_ENTRY)
  ? false
  : "the CLI bundle is not built: run `pnpm build && pnpm build:bundle`";

/** Relative files a module imports with static `import ... from "./x.js"`, `import "./x.js"` and `export ... from "./x.js"` (not `import("./x.js")`). */
const STATIC_IMPORT = /^(?:import|export)(?=[\s{*"'])[^"'`;]*?["'](\.\/[^"']+)["']/gm;

/** The files `entry` loads before it runs a line of its own: its static import graph inside the bundle directory. */
export function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(join(BUNDLE_DIRECTORY, file), "utf8").matchAll(STATIC_IMPORT)) visit(match[1]!.slice(2));
  };
  visit(entry);
  return seen;
}

/** Every `.js` file of the bundle. */
export function bundleFiles(): string[] {
  return readdirSync(BUNDLE_DIRECTORY).filter((name) => name.endsWith(".js"));
}

/** The packages whose modules `file` holds: esbuild marks each module it inlines with a `// packages/<name>/...` comment. */
export function packagesIn(file: string): Set<string> {
  const names = new Set<string>();
  for (const match of readFileSync(join(BUNDLE_DIRECTORY, file), "utf8").matchAll(/^\/\/ packages\/([^/]+)\//gm)) names.add(match[1]!);
  return names;
}
