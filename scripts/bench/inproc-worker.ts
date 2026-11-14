#!/usr/bin/env node
/**
 * ripstream in one long-lived Node process, for the warm in-process lane and the batch lane.
 * It parses exactly as the CLI's one-shot `parse -c <config>` does: loadConfig() on the file,
 * one createRipstream({ config }), file bytes read with readFile, `parse(bytes, { filename })`,
 * and `result.text` as the output.
 *
 * Usage:
 *   node scripts/bench/inproc-worker.ts --root <ripstream checkout> [--config <file>] server
 *     Prints READY, then answers each stdin line (a file path) with one JSON line:
 *     {"content", "metadata": {"mimeType"}, "_extraction_time_ms"} or {"error"}.
 *     The same protocol as xberg's TikaExtract `server` mode.
 *   node scripts/bench/inproc-worker.ts --root <ripstream checkout> [--config <file>] batch <file>...
 *     Parses the files in order and prints one JSON array of the same objects.
 *
 * The root must hold a built tree (packages/core/dist, packages/parsers/dist).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

interface ParseResult {
  readonly text: string;
  readonly metadata: { get(name: string): string | null };
}
interface Ripstream {
  parse(bytes: Uint8Array, options: { filename?: string }): Promise<ParseResult>;
}
interface ParsersModule {
  createRipstream(options: { config?: unknown }): Ripstream;
}
interface CoreModule {
  loadConfig(text: string, options: { env: NodeJS.ProcessEnv }): unknown;
}

const args = process.argv.slice(2);
const flag = (name: string): { value: string | undefined; index: number } => {
  const index = args.indexOf(name);
  return { value: index >= 0 ? args[index + 1] : undefined, index };
};
const root = flag("--root");
const config = flag("--config");
if (root.value === undefined) usage("--root is required");
const flagIndexes = new Set([root.index, root.index + 1, ...(config.index < 0 ? [] : [config.index, config.index + 1])]);
const positional = args.filter((_, index) => !flagIndexes.has(index));
const mode = positional[0];

const load = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(join(root.value ?? "", rel)).href)) as T;
const parsers = await load<ParsersModule>("packages/parsers/dist/index.js");
const loaded =
  config.value === undefined
    ? undefined
    : (await load<CoreModule>("packages/core/dist/index.js")).loadConfig(await readFile(config.value, "utf8"), { env: process.env });
const ripstream = parsers.createRipstream(loaded === undefined ? {} : { config: loaded });

if (mode === "server") {
  process.stdout.write("READY\n");
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    const path = line.trim();
    if (path === "") continue;
    await write(`${JSON.stringify(await extract(path))}\n`);
  }
} else if (mode === "batch") {
  const results: object[] = [];
  for (const path of positional.slice(1)) results.push(await extract(path));
  await write(JSON.stringify(results));
} else {
  usage(`unknown mode ${JSON.stringify(mode)}`);
}

async function extract(path: string): Promise<object> {
  const started = performance.now();
  try {
    const bytes = new Uint8Array(await readFile(path));
    const result = await ripstream.parse(bytes, { filename: path });
    return {
      content: result.text,
      metadata: { mimeType: result.metadata.get("Content-Type") ?? "application/octet-stream" },
      _extraction_time_ms: performance.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { error: message, _extraction_time_ms: performance.now() - started };
  }
}

function write(text: string): Promise<void> {
  return new Promise((resolve, reject) => process.stdout.write(text, (error) => (error ? reject(error) : resolve())));
}

function usage(message: string): never {
  process.stderr.write(`inproc-worker: ${message}\nusage: inproc-worker.ts --root <dir> server | batch <file>...\n`);
  process.exit(2);
}
