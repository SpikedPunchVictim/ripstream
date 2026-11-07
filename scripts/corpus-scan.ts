#!/usr/bin/env node
/**
 * Detects and parses every file under one or more roots with the standard
 * ripstream pipeline. Corpus files are untrusted input and are only read.
 *
 * Usage:
 *   node scripts/corpus-scan.ts <dir-or-file>... [options]
 *
 * Options:
 *   --limit <n>          max files per root (default 0 = unlimited)
 *   --timeout <ms>       per-file limit (default 20000)
 *   --concurrency <n>    parallel parses (default 4)
 *   --extensions <list>  comma-separated extensions to include (default all)
 *   --out <path.jsonl>   result file (default artifacts/corpus/scan-results.jsonl)
 *   --summary <path>     summary file (default artifacts/corpus/scan-summary.json)
 */
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { BodyContentHandler, Metadata } from "../packages/core/src/index.ts";
import { createRipstream } from "../packages/parsers/src/index.ts";

interface Options {
  readonly roots: string[];
  readonly limit: number;
  readonly timeout: number;
  readonly concurrency: number;
  readonly extensions: readonly string[];
  readonly out: string;
  readonly summary: string;
}

interface Result {
  readonly file: string;
  readonly size: number;
  readonly extension: string;
  readonly detected: string | null;
  readonly status: "ok" | "error";
  readonly error?: string;
  readonly message?: string;
  readonly milliseconds: number;
  readonly textLength: number;
  readonly metadataCount: number;
  readonly contentType?: string;
  readonly sample?: string;
}

const options = parseArgs(process.argv.slice(2));
if (options.roots.length === 0) {
  console.error(
    "usage: node scripts/corpus-scan.ts DIR... [--limit N] [--timeout MS] [--concurrency N] [--extensions pdf,docx] [--out FILE] [--summary FILE]",
  );
  process.exit(2);
}

const accepted = new Set(options.extensions.map((value) => value.toLowerCase()));
const files = (await collectFiles(options)).filter((file) => {
  if (accepted.size === 0) return true;
  return accepted.has(extensionOf(file));
});
await mkdir(dirname(resolve(options.out)), { recursive: true });
await mkdir(dirname(resolve(options.summary)), { recursive: true });

const ripstream = createRipstream();
const results: Result[] = [];
let next = 0;
const workers = Array.from(
  { length: Math.max(1, options.concurrency) },
  async () => {
    while (true) {
      const index = next++;
      const file = files[index];
      if (file === undefined) return;
      const result = await inspect(file, options.timeout, ripstream);
      results.push(result);
      const marker = result.status === "ok" ? "ok" : `ERR ${result.error}`;
      console.error(
        `[${results.length}/${files.length}] ${marker} ${result.milliseconds}ms ${result.detected ?? "?"} ${file}`,
      );
    }
  },
);
await Promise.all(workers);
results.sort((left, right) => left.file.localeCompare(right.file));

const out = createWriteStream(options.out, { flags: "w" });
for (const result of results) out.write(`${JSON.stringify(result)}\n`);
await new Promise<void>((done, fail) => {
  out.on("error", fail);
  out.end(done);
});

const summary = summarize(results, files.length);
await writeFile(options.summary, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

async function inspect(
  file: string,
  timeout: number,
  scanner: ReturnType<typeof createRipstream>,
): Promise<Result> {
  const start = performance.now();
  const extension = extensionOf(file);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(file));
  } catch (error) {
    return failure(file, extension, 0, start, error);
  }

  const signal = AbortSignal.timeout(timeout);
  let detected: string | null = null;
  try {
    detected = (
      await scanner.detect(bytes, { filename: basename(file), signal })
    ).toString();
  } catch (error) {
    detected = `detection-error:${errorName(error)}`;
  }

  let textLength = 0;
  let sample = "";
  const handler = new BodyContentHandler((text) => {
    textLength += text.length;
    if (sample.length < 500) sample += text.slice(0, 500 - sample.length);
  });
  try {
    const metadata = await scanner.parseToHandler(bytes, handler, {
      filename: basename(file),
      signal,
      limits: { maxParseMillis: timeout },
    });
    return {
      file,
      size: bytes.byteLength,
      extension,
      detected,
      status: "ok",
      milliseconds: elapsed(start),
      textLength,
      metadataCount: countMetadata(metadata),
      contentType: metadata.get("Content-Type") ?? undefined,
      sample: sample.length === 0 ? undefined : sample,
    };
  } catch (error) {
    return {
      file,
      size: bytes.byteLength,
      extension,
      detected,
      status: "error",
      error: errorName(error),
      message: message(error),
      milliseconds: elapsed(start),
      textLength,
      metadataCount: 0,
    };
  }
}

function failure(
  file: string,
  extension: string,
  size: number,
  start: number,
  error: unknown,
): Result {
  return {
    file,
    size,
    extension,
    detected: null,
    status: "error",
    error: errorName(error),
    message: message(error),
    milliseconds: elapsed(start),
    textLength: 0,
    metadataCount: 0,
  };
}

function countMetadata(metadata: Metadata): number {
  let count = 0;
  for (const _name of metadata.names()) count++;
  return count;
}

function summarize(results: readonly Result[], discovered: number) {
  const byStatus: Record<string, number> = {};
  const byError: Record<string, number> = {};
  const byDetection: Record<string, number> = {};
  const byExtension: Record<string, { tested: number; errors: number }> = {};
  const durations: number[] = [];
  let zeroText = 0;
  let timeouts = 0;
  for (const result of results) {
    byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
    durations.push(result.milliseconds);
    const detection = result.detected ?? "unknown";
    byDetection[detection] = (byDetection[detection] ?? 0) + 1;
    const ext = result.extension.length === 0 ? "(none)" : result.extension;
    const bucket = byExtension[ext] ?? { tested: 0, errors: 0 };
    bucket.tested++;
    if (result.status === "error") {
      bucket.errors++;
      const name = result.error ?? "UnknownError";
      byError[name] = (byError[name] ?? 0) + 1;
      if (name === "AbortError" || name === "TimeoutError") timeouts++;
    } else if (result.textLength === 0) {
      zeroText++;
    }
    byExtension[ext] = bucket;
  }
  durations.sort((left, right) => left - right);
  return {
    filesDiscovered: discovered,
    filesTested: results.length,
    ok: byStatus.ok ?? 0,
    errors: byStatus.error ?? 0,
    zeroText,
    timeouts,
    byError,
    byExtension,
    byDetection,
    milliseconds: {
      total: Math.round(durations.reduce((sum, value) => sum + value, 0)),
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      max: durations.at(-1) ?? 0,
    },
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

async function collectFiles(options: Options): Promise<string[]> {
  const files: string[] = [];
  for (const root of options.roots) {
    const absolute = resolve(root);
    try {
      await readdir(absolute, { withFileTypes: true });
    } catch {
      files.push(absolute);
      continue;
    }
    const stack: string[] = [absolute];
    while (stack.length > 0) {
      const directory = stack.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(path);
        } else if (entry.isFile()) {
          files.push(path);
        }
      }
    }
  }
  files.sort();
  return options.limit > 0 ? files.slice(0, options.limit) : files;
}

function parseArgs(args: readonly string[]): Options {
  const roots: string[] = [];
  let limit = 0;
  let timeout = 20_000;
  let concurrency = 4;
  let extensions: string[] = [];
  let out = "artifacts/corpus/scan-results.jsonl";
  let summary = "artifacts/corpus/scan-summary.json";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    switch (arg) {
      case "--limit":
        limit = Number(args[++index] ?? "0");
        break;
      case "--timeout":
        timeout = Number(args[++index] ?? "20000");
        break;
      case "--concurrency":
        concurrency = Number(args[++index] ?? "4");
        break;
      case "--extensions":
        extensions = (args[++index] ?? "")
          .split(",")
          .map((value) => value.trim().replace(/^\./, ""))
          .filter((value) => value.length > 0);
        break;
      case "--out":
        out = args[++index] ?? out;
        break;
      case "--summary":
        summary = args[++index] ?? summary;
        break;
      default:
        roots.push(arg);
    }
  }
  return { roots, limit, timeout, concurrency, extensions, out, summary };
}

function extensionOf(file: string): string {
  const extension = extname(file).slice(1).toLowerCase();
  return extension;
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "UnknownError";
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return String(error).slice(0, 300);
}
