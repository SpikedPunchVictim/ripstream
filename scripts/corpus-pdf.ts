#!/usr/bin/env node
/**
 * Runs PDF detection and parsing over a directory tree and records a
 * machine-readable result per file. Corpus files are treated as untrusted
 * input: they are only read and parsed, never executed.
 *
 * Usage:
 *   node scripts/corpus-pdf.ts <dir-or-file>... [options]
 *
 * Options:
 *   --limit <n>          max files per root (default 0 = unlimited)
 *   --timeout <ms>       per-file parse timeout (default 20000)
 *   --concurrency <n>    parallel parses (default 4)
 *   --out <path.jsonl>   result file (default artifacts/corpus/pdf-results.jsonl)
 *   --summary <path>     summary file (default artifacts/corpus/pdf-summary.json)
 *   --all                include non-.pdf files
 */
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "../packages/core/src/index.ts";
import { DefaultDetector } from "../packages/mime/src/index.ts";
import { PdfParser } from "../packages/parser-pdf/src/index.ts";

interface Options {
  readonly roots: string[];
  readonly limit: number;
  readonly timeout: number;
  readonly concurrency: number;
  readonly out: string;
  readonly summary: string;
  readonly all: boolean;
}

interface Result {
  readonly file: string;
  readonly size: number;
  readonly detected: string | null;
  readonly status: "ok" | "error";
  readonly error?: string;
  readonly message?: string;
  readonly milliseconds: number;
  readonly textLength: number;
  readonly metadataCount: number;
  readonly pageCount?: string;
  readonly title?: string;
  readonly sample?: string;
}

const options = parseArgs(process.argv.slice(2));
if (options.roots.length === 0) {
  console.error(
    "usage: node scripts/corpus-pdf.ts DIR... [--limit N] [--timeout MS] [--concurrency N] [--out FILE] [--summary FILE] [--all]",
  );
  process.exit(2);
}

const files = await collectFiles(options);
await mkdir(dirname(resolve(options.out)), { recursive: true });
await mkdir(dirname(resolve(options.summary)), { recursive: true });

const results: Result[] = [];
let next = 0;
const workers = Array.from(
  { length: Math.max(1, options.concurrency) },
  async () => {
    while (true) {
      const index = next++;
      const file = files[index];
      if (file === undefined) return;
      const result = await inspect(file, options.timeout);
      results.push(result);
      const marker = result.status === "ok" ? "ok" : `ERR ${result.error}`;
      console.error(
        `[${results.length}/${files.length}] ${marker} ${result.milliseconds}ms ${file}`,
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

async function inspect(file: string, timeout: number): Promise<Result> {
  const start = performance.now();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(file));
  } catch (error) {
    return {
      file,
      size: 0,
      detected: null,
      status: "error",
      error: "ReadError",
      message: message(error),
      milliseconds: elapsed(start),
      textLength: 0,
      metadataCount: 0,
    };
  }

  let detected: string | null = null;
  const detectionMetadata = new Metadata();
  detectionMetadata.set("resourceName", basename(file));
  try {
    const stream = await RipstreamInputStream.from(bytes);
    try {
      detected = (
        await new DefaultDetector().detect(
          stream,
          detectionMetadata,
          new ParseContext(),
        )
      ).toString();
    } finally {
      await stream.close();
    }
  } catch (error) {
    detected = `detection-error:${errorName(error)}`;
  }

  let textLength = 0;
  let sample = "";
  const metadata = new Metadata();
  const handler = new BodyContentHandler((text) => {
    textLength += text.length;
    if (sample.length < 500) sample += text.slice(0, 500 - sample.length);
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const stream = await RipstreamInputStream.from(bytes, {
    context: new ParseContext({ signal: controller.signal }),
  });
  try {
    await new PdfParser().parse(
      stream,
      handler,
      metadata,
      new ParseContext({ signal: controller.signal }),
    );
    return {
      file,
      size: bytes.byteLength,
      detected,
      status: "ok",
      milliseconds: elapsed(start),
      textLength,
      metadataCount: countMetadata(metadata),
      pageCount: metadata.get("xmpTPg:NPages") ?? undefined,
      title: metadata.get("dc:title") ?? undefined,
      sample: sample.length === 0 ? undefined : sample,
    };
  } catch (error) {
    return {
      file,
      size: bytes.byteLength,
      detected,
      status: "error",
      error: errorName(error),
      message: message(error),
      milliseconds: elapsed(start),
      textLength,
      metadataCount: countMetadata(metadata),
      pageCount: metadata.get("xmpTPg:NPages") ?? undefined,
    };
  } finally {
    clearTimeout(timer);
    await stream.close();
  }
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
  const durations: number[] = [];
  let zeroText = 0;
  let nonPdf = 0;
  let timeouts = 0;
  for (const result of results) {
    byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
    durations.push(result.milliseconds);
    const detection = result.detected ?? "unknown";
    byDetection[detection] = (byDetection[detection] ?? 0) + 1;
    if (detection !== "application/pdf") nonPdf++;
    if (result.status === "error") {
      const name = result.error ?? "UnknownError";
      byError[name] = (byError[name] ?? 0) + 1;
      if (name === "AbortError" || name === "TimeoutError") timeouts++;
    } else if (result.textLength === 0) {
      zeroText++;
    }
  }
  durations.sort((left, right) => left - right);
  return {
    filesDiscovered: discovered,
    filesTested: results.length,
    ok: byStatus.ok ?? 0,
    errors: byStatus.error ?? 0,
    zeroText,
    nonPdfDetections: nonPdf,
    timeouts,
    byError,
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
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      if (options.all || extname(absolute).toLowerCase() === ".pdf") {
        files.push(absolute);
      }
      continue;
    }
    const stack: string[] = [absolute];
    while (stack.length > 0) {
      const directory = stack.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(path);
        } else if (
          entry.isFile() &&
          (options.all || extname(entry.name).toLowerCase() === ".pdf")
        ) {
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
  let out = "artifacts/corpus/pdf-results.jsonl";
  let summary = "artifacts/corpus/pdf-summary.json";
  let all = false;
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
      case "--out":
        out = args[++index] ?? out;
        break;
      case "--summary":
        summary = args[++index] ?? summary;
        break;
      case "--all":
        all = true;
        break;
      default:
        roots.push(arg);
    }
  }
  return { roots, limit, timeout, concurrency, out, summary, all };
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
