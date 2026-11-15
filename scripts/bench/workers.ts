#!/usr/bin/env node
/**
 * The parse pool against parsing on the calling thread, for small documents (docs/workers.md, tikajs-czll).
 *
 * Usage (needs a built tree: pnpm typecheck):
 *   node scripts/bench/workers.ts [--workers 8] [--runs 5] [--docs 1500] [--formats rtf,rtfinfo,txt,csv,html,json]
 *       [--sizes 85,200,500,1000,2000,4000,8000]
 *
 * For each format and size it builds a distinct 'document' of that many bytes (a few distinct ones, so nothing is a
 * cache hit), parses `--docs` of them warm with `parseRecursive`, in-process with 8 in flight and on the pool with
 * 2 x workers in flight (as the CLI does), alternating the two back to back for `--runs` runs, and prints the median
 * documents a second of each and the ratio. * A loaded machine swings a single run by tens of percent: look at the medians, and run it again.
 */
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : (args[at + 1] ?? fallback);
};
const workers = Number(flag("--workers", "8"));
const runs = Number(flag("--runs", "5"));
const docs = Number(flag("--docs", "1500"));
const formats = flag("--formats", "rtf,rtfinfo,txt,csv,html,json").split(",");
const sizes = flag("--sizes", "85,200,500,1000,2000,4000,8000").split(",").map(Number);

const root = resolve(import.meta.dirname, "../..");
const load = async <T>(path: string): Promise<T> => (await import(pathToFileURL(resolve(root, path)).href)) as T;
interface Source { readonly path: string }
type Input = Uint8Array | Source;
interface Parser {
  parseRecursive(input: Input, options?: { filename?: string }): Promise<unknown>;
}
const { createRipstream } = await load<{ createRipstream(): Parser }>("packages/parsers/dist/index.js");
const { createParsePool } = await load<{
  createParsePool(options: { workers: number }): Promise<Parser & { close(): Promise<void> }>;
}>("packages/pipes/dist/workers.js");

const encoder = new TextEncoder();

/** A document of the format that is `size` bytes long, give or take a line; `variant` makes each one different. */
function build(format: string, size: number, variant: number): Uint8Array {
  const line = (n: number): string => `row ${variant} ${n} the quick brown fox jumps over the lazy dog`;
  let text = "";
  const [head, tail, each]: [string, string, (n: number) => string] = {
    rtf: ["{\\rtf1\\ansi ", "}", (n: number) => `${line(n)}\\par `] as [string, string, (n: number) => string],
    // A real RTF has a font table and an info group, so its parse yields metadata: the result costs more to rebuild.
    rtfinfo: ["{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}{\\info{\\title T}{\\author A}{\\creatim\\yr2020\\mo1\\dy2\\hr3\\min4}} ", "}", (n: number) => `${line(n)}\\par `] as [string, string, (n: number) => string],
    txt: ["", "", (n: number) => `${line(n)}\n`] as [string, string, (n: number) => string],
    csv: ["id,name,note\n", "", (n: number) => `${n},"${variant}-${n}","quick brown fox"\n`] as [string, string, (n: number) => string],
    html: ["<html><head><title>t</title></head><body>", "</body></html>", (n: number) => `<p>${line(n)}</p>`] as [string, string, (n: number) => string],
    json: ["[", "]", (n: number) => `${n === 0 ? "" : ","}{"v":${variant},"n":${n},"s":"quick brown fox"}`] as [string, string, (n: number) => string],
  }[format] ?? ["", "", (n: number) => `${line(n)}\n`];
  let n = 0;
  // Below a line there is no room for one: a run of words does as the body.
  if (size < 150) text = `v${variant} `.padEnd(Math.max(0, size - head.length - tail.length), "word ");
  else while (head.length + text.length + tail.length < size) text += each(n++);
  return encoder.encode(head + text + tail);
}

const EXTENSION: Record<string, string> = { rtf: "rtf", rtfinfo: "rtf", txt: "txt", csv: "csv", html: "html", json: "json" };

async function run(parser: Parser, inputs: readonly Uint8Array[], filename: string, inFlight: number): Promise<number> {
  const started = performance.now();
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let at = next++; at < docs; at = next++) await parser.parseRecursive(inputs[at % inputs.length]!, { filename });
  };
  await Promise.all(Array.from({ length: inFlight }, lane));
  return docs / ((performance.now() - started) / 1000);
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

const local = createRipstream();
const pool = await createParsePool({ workers });
console.log(`workers ${workers}, ${runs} runs of ${docs} documents, medians in documents a second`);
console.log("format      size   in-process        pool   pool / in-process (min..max over runs)");
try {
  for (const format of formats) {
    for (const size of sizes) {
      const inputs = Array.from({ length: 16 }, (_, variant) => build(format, size, variant));
      const filename = `bench.${EXTENSION[format] ?? format}`;
      await run(local, inputs, filename, 8);
      await run(pool, inputs, filename, workers * 2);
      const inProcess: number[] = [];
      const pooled: number[] = [];
      const ratios: number[] = [];
      for (let r = 0; r < runs; r += 1) {
        const a = await run(local, inputs, filename, 8);
        const b = await run(pool, inputs, filename, workers * 2);
        inProcess.push(a);
        pooled.push(b);
        ratios.push(b / a);
      }
      console.log(
        `${format.padEnd(7)} ${String(inputs[0]!.length).padStart(7)} ${median(inProcess).toFixed(0).padStart(12)} ${median(pooled).toFixed(0).padStart(11)}   ${(median(pooled) / median(inProcess)).toFixed(2)}x (${Math.min(...ratios).toFixed(2)}..${Math.max(...ratios).toFixed(2)})`,
      );
    }
  }
} finally {
  await pool.close();
}
