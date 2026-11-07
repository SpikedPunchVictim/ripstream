import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const budgets = JSON.parse(readFileSync("bundle-budget.json", "utf8")) as Record<string, number>;
const sizes: Record<string, number> = {};
let total = 0;

for (const name of readdirSync("packages")) {
  const directory = join("packages", name, "dist");
  let size = 0;
  try {
    const visit = (path: string): void => {
      for (const entry of readdirSync(path)) {
        const full = join(path, entry);
        const info = statSync(full);
        if (info.isDirectory()) visit(full);
        else size += info.size;
      }
    };
    visit(directory);
  } catch {
    continue;
  }
  sizes[name] = size;
  total += size;
}

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
