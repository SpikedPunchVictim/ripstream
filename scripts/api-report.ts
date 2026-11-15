import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

interface Report {
  readonly formatVersion: 1;
  readonly packages: Readonly<Record<string, readonly string[]>>;
}

const root = new URL("..", import.meta.url);
const packagesDirectory = new URL("../packages/", import.meta.url);
const entryFor = (name: string): string | null => {
  for (const candidate of ["src/index.ts", "src/main.ts"]) {
    try {
      const path = new URL(`${name}/${candidate}`, packagesDirectory);
      if (statSync(path).isFile()) return path.pathname;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
};
const packageNames = readdirSync(packagesDirectory)
  .filter((name) => entryFor(name) !== null)
  .sort();

/**
 * The subpaths a package exports beside its main entry (`@spikedpunch/ripstream-pipes/workers`), each reported as
 * `<package>/<subpath>`. Its source is the `dist/*.js` (or `.d.ts`) it names, under `src/` as a `.ts`.
 */
function subpathEntries(name: string): { readonly key: string; readonly path: string }[] {
  const manifest = JSON.parse(readFileSync(new URL(`${name}/package.json`, packagesDirectory), "utf8")) as {
    exports?: Record<string, string | Record<string, string>>;
  };
  return Object.entries(manifest.exports ?? {})
    .filter(([subpath]) => subpath !== ".")
    .map(([subpath, target]) => {
      const built = typeof target === "string" ? target : (target.types ?? target.import ?? target.default);
      const source = built?.replace(/^\.\/dist\//, "src/").replace(/(\.d)?\.js$|\.d\.ts$/, ".ts");
      const path = source === undefined ? undefined : new URL(`${name}/${source}`, packagesDirectory);
      if (path === undefined || !statSync(path, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`${name}: export ${JSON.stringify(subpath)} names ${JSON.stringify(built)}, which has no source under src/`);
      }
      return { key: `${name}/${subpath.replace(/^\.\//, "")}`, path: path.pathname };
    });
}

const entries = packageNames
  .flatMap((name) => [{ key: name, path: entryFor(name)! }, ...subpathEntries(name)])
  .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

const entryPoints = entries.map((entry) => entry.path);
const program = ts.createProgram(entryPoints, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  noEmit: true,
  strict: true,
});
const checker = program.getTypeChecker();
const packages: Record<string, string[]> = {};

for (const { key, path } of entries) {
  const source = program.getSourceFile(path);
  if (source === undefined) continue;
  const symbol = checker.getSymbolAtLocation(source);
  packages[key] =
    symbol === undefined
      ? []
      : checker
          .getExportsOfModule(symbol)
          .map((entry) => entry.getName())
          .filter((entry) => entry !== "default")
          .sort();
}

const report: Report = { formatVersion: 1, packages };
const serialized = `${JSON.stringify(report, null, 2)}\n`;
const target = new URL("../api-report.json", import.meta.url);

if (process.argv.includes("--check")) {
  const current = readFileSync(target, "utf8");
  if (current !== serialized) {
    console.error("API report is stale. Run `pnpm api:report` and review the diff.");
    process.exitCode = 1;
  } else {
    console.log(`API report up to date: ${packageNames.length} packages, ${entries.length - packageNames.length} subpaths`);
  }
} else {
  writeFileSync(target, serialized);
  console.log(`wrote API report for ${packageNames.length} packages, ${entries.length - packageNames.length} subpaths`);
}
void root;
