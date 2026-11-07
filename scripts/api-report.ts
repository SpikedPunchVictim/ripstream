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

const entryPoints = packageNames.map(
  (name) => entryFor(name)!,
);
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

for (const name of packageNames) {
  const path = entryFor(name)!;
  const source = program.getSourceFile(path);
  if (source === undefined) continue;
  const symbol = checker.getSymbolAtLocation(source);
  packages[name] =
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
    console.log(`API report up to date: ${packageNames.length} packages`);
  }
} else {
  writeFileSync(target, serialized);
  console.log(`wrote API report for ${packageNames.length} packages`);
}
void root;
