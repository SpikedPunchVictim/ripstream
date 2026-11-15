// Cold-start benchmark for the CLI: `ripstream parse <tiny file>` as a fresh process, dist against the bundle.
// Usage: node scripts/bench-cli-start.ts [runs=30]. Needs `pnpm build && pnpm build:bundle`. See docs/cli-startup.md.
//
// Variants run interleaved (one spawn of each, then the next round), so machine noise lands on both. Both go through
// bin/ripstream.js, the way a user runs it: "dist" with RIPSTREAM_NO_BUNDLE=1, "bundle" with the compile cache warm.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const stub = join(root, "packages/cli/bin/ripstream.js");
const runs = Number(process.argv[2] ?? 30);
const WARMUP = 3;

const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 18 Tf 10 50 Td (hello pdf start-up) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 6 >>
%%EOF
`;

function smallestFixture(extension: string): string {
  let best: { path: string; size: number } | undefined;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const info = statSync(path);
      if (info.isDirectory()) visit(path);
      else if (extname(path) === extension && (best === undefined || info.size < best.size)) best = { path, size: info.size };
    }
  };
  visit(join(root, "packages/parsers/test/fixtures"));
  if (best === undefined) throw new Error(`no ${extension} fixture`);
  return best.path;
}

const dir = mkdtempSync(join(tmpdir(), "ripstream-bench-"));
const inputs: Record<string, string> = { txt: join(dir, "a.txt"), json: join(dir, "a.json"), docx: smallestFixture(".docx"), pdf: join(dir, "a.pdf") };
writeFileSync(inputs.txt!, "hello cold start\n");
writeFileSync(inputs.json!, '{"hello":"cold start","n":[1,2,3]}\n');
writeFileSync(inputs.pdf!, pdf);

const variants = [
  { label: "dist", env: { RIPSTREAM_NO_BUNDLE: "1" } },
  { label: "bundle + cache", env: {} },
];
const cacheDir = join(dir, "cache");
const quantile = (sorted: number[], q: number): number => sorted[Math.round((sorted.length - 1) * q)]!;

function spawnMillis(env: Record<string, string>, file: string): number {
  const start = process.hrtime.bigint();
  const run = spawnSync(process.execPath, [stub, "parse", file], { stdio: "ignore", env: { ...process.env, RIPSTREAM_ISOLATION: undefined, NODE_COMPILE_CACHE: cacheDir, ...env } });
  if (run.status !== 0) throw new Error(`parse ${file} exited ${String(run.status)}`);
  return Number(process.hrtime.bigint() - start) / 1e6;
}

console.log(`cold \`parse\`, ${runs} interleaved spawns each (ms): median (p25-p75, p95)\n`);
console.log("| input | " + variants.map((v) => v.label).join(" | ") + " | bundle / dist |");
console.log("|---|" + variants.map(() => "---|").join("") + "---|");
for (const [name, file] of Object.entries(inputs)) {
  const samples = variants.map(() => [] as number[]);
  for (let round = -WARMUP; round < runs; round++) {
    variants.forEach((variant, index) => {
      const millis = spawnMillis(variant.env, file);
      if (round >= 0) samples[index]!.push(millis);
    });
  }
  const sorted = samples.map((s) => s.sort((a, b) => a - b));
  const cells = sorted.map((s) => `${quantile(s, 0.5).toFixed(0)} (${quantile(s, 0.25).toFixed(0)}-${quantile(s, 0.75).toFixed(0)}, ${quantile(s, 0.95).toFixed(0)})`);
  const ratio = quantile(sorted[1]!, 0.5) / quantile(sorted[0]!, 0.5);
  console.log(`| ${name} | ${cells.join(" | ")} | ${ratio.toFixed(2)} |`);
}

// The price of the first run after a Node upgrade or a wiped temp directory: an empty cache directory each time.
const first: number[] = [];
for (let round = 0; round < Math.min(runs, 10); round++) {
  rmSync(cacheDir, { recursive: true, force: true });
  first.push(spawnMillis({}, inputs.txt!));
}
first.sort((a, b) => a - b);
console.log(`\nbundle, empty compile cache (txt, ${first.length} runs): median ${quantile(first, 0.5).toFixed(0)}, min ${first[0]!.toFixed(0)}, max ${first.at(-1)!.toFixed(0)}`);
rmSync(dir, { recursive: true, force: true });
