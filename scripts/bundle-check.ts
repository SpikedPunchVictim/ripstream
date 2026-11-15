import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const budgets = JSON.parse(readFileSync("bundle-budget.json", "utf8")) as Record<string, number>;
const sizes: Record<string, number> = {};
let total = 0;


/** The bytes under `directory`, or null when it does not exist (not built). */
function directorySize(directory: string): number | null {
  let size = 0;
  const visit = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      const info = statSync(full);
      if (info.isDirectory()) visit(full);
      else size += info.size;
    }
  };
  try {
    visit(directory);
  } catch {
    return null;
  }
  return size;
}

for (const name of readdirSync("packages")) {
  const size = directorySize(join("packages", name, "dist"));
  if (size === null) continue;
  sizes[name] = size;
  total += size;
}

// The CLI's split bundle (`pnpm build:bundle`, docs/cli-startup.md) is a second copy of code already counted above, so it
// has a budget of its own and is not part of the total. It is checked when it has been built.
const bundleSize = directorySize(join("packages", "cli", "bundle", "dist"));
if (bundleSize === null) console.log("cli-bundle: not built (pnpm build:bundle), budget not checked");
else sizes["cli-bundle"] = bundleSize;

const problems = Object.entries(budgets)
  .filter(([name, budget]) => name !== "total" && (sizes[name] ?? 0) > budget * 1024)
  .map(([name, budget]) => `${name}: ${sizes[name] ?? 0} bytes > ${budget} KiB`);

if (total > (budgets.total ?? Number.MAX_SAFE_INTEGER) * 1024) {
  problems.push(`total: ${total} bytes > ${budgets.total} KiB`);
}
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  console.log(`bundle budgets pass: total ${(total / 1024).toFixed(1)} KiB`);
}
