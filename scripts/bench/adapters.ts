/**
 * The compared tools. Cold lanes start a fresh process per file (the harness's single-file
 * mode); warm lanes keep one process and send it file paths; batch lanes start one process
 * per batch of files.
 */
import { join } from "node:path";
import { LineServer, runMeasured, type CommandSpec, type Measured } from "./measure.ts";

export type Regime = "cold_process" | "warm_in_process";
export type ErrorKind = "none" | "timeout" | "framework_error" | "empty_content" | "zero_overlap" | "harness_error";

export interface Extraction {
  readonly success: boolean;
  readonly errorKind: ErrorKind;
  readonly error?: string;
  readonly content: string;
  readonly wallMs: number;
  /** ru_maxrss of the process (cold lanes), null when not attributable. */
  readonly rssBytes: number | null;
  /** The tool's own extraction time, when it reports one. */
  readonly reportedMs?: number;
}

export interface Adapter {
  readonly name: string;
  readonly regime: Regime;
  /** Tika's adapter caps the timeout at 180 s in the harness (adapters/external.rs). */
  readonly maxTimeoutMs?: number;
  setup(timeoutMs: number): Promise<void>;
  extract(path: string, timeoutMs: number): Promise<Extraction>;
  /** Peak RSS of a warm lane's long-lived process over the whole run, when known. */
  teardown(): Promise<number | null>;
}

export interface BatchItem {
  readonly success: boolean;
  readonly error?: string;
  readonly content: string;
}

export interface BatchRun {
  readonly wallMs: number;
  readonly rssBytes: number | null;
  readonly timedOut: boolean;
  readonly error?: string;
  readonly items: readonly BatchItem[];
}

export interface BatchAdapter {
  readonly name: string;
  run(paths: readonly string[], timeoutMs: number): Promise<BatchRun>;
}

export interface ToolPaths {
  readonly node: string;
  readonly java: string;
  readonly ripstreamRoot: string;
  /** Classpath holding TikaExtract and the Tika 4.2.0 parser jars. */
  readonly tikaClasspath: string;
  readonly xberg: string;
  readonly benchDir: string;
  /** ripstream configuration for the CLI (`-c`) and the worker (`--config`), or null for ripstream's defaults. */
  readonly ripstreamConfig: string | null;
  /** Parse emails with ParseOptions.emailHeaders (the header block ahead of the body). Applies to the worker lanes; the CLI has no such option. */
  readonly ripstreamEmailHeaders: boolean;
  readonly timeBinary: string | null;
  readonly scratchDir: string;
}

/** The harness's Tika JVM (adapters/external.rs). */
// stdout.encoding: TikaExtract prints non-ASCII characters raw, and without a UTF-8 locale (the
// benchmark image has none) the JVM encodes stdout as ASCII and turns each of them into '?'.
const JVM_ARGS = ["-server", "-Xms512m", "-Xmx2g", "-XX:+UseG1GC", "-Dstdout.encoding=UTF-8"];
const TIKA_MAX_TIMEOUT_MS = 180_000;

/** The harness's xberg plaintext baseline (adapters/xberg.rs) with its 1800 s - 60 s config. */
function xbergArgs(subcommand: "extract" | "batch", timeoutMs: number): string[] {
  const extractionTimeout = Math.max(1, Math.floor(timeoutMs / 1000) - 60);
  return [
    subcommand,
    "--no-config-discovery",
    "--format",
    "json",
    "--content-format",
    "plain",
    "--config-json",
    JSON.stringify({ extraction_timeout_secs: extractionTimeout, use_cache: false }),
    "--pdf-backend",
    "native",
  ];
}

const XBERG_ENV = { XBERG_EMIT_STAGE_TIMING: "1" };

export function createAdapters(paths: ToolPaths): { single: Map<string, () => Adapter>; batch: Map<string, () => BatchAdapter> } {
  const worker = join(paths.benchDir, "inproc-worker.ts");
  const cliConfig = paths.ripstreamConfig === null ? [] : ["-c", paths.ripstreamConfig];
  const workerArgs = [
    worker,
    "--root",
    paths.ripstreamRoot,
    ...(paths.ripstreamConfig === null ? [] : ["--config", paths.ripstreamConfig]),
    ...(paths.ripstreamEmailHeaders ? ["--email-headers"] : []),
  ];
  const tikaJava = (mode: string, files: readonly string[]): CommandSpec => ({
    program: paths.java,
    args: [...JVM_ARGS, "-cp", paths.tikaClasspath, "io.xberg.benchmark.TikaExtract", "--no-ocr", mode, ...files],
  });
  const measure = (name: string) => ({
    timeBinary: paths.timeBinary,
    rssFile: join(paths.scratchDir, `${name}.rss`),
  });

  const single = new Map<string, () => Adapter>([
    [
      "ripstream-cli",
      () =>
        new ColdAdapter(
          "ripstream-cli",
          (file) => ({ program: paths.node, args: [join(paths.ripstreamRoot, "packages/cli/bin/ripstream.js"), ...cliConfig, file] }),
          parsePlainText,
          measure("ripstream-cli"),
        ),
    ],
    [
      "ripstream-inproc",
      () => new WarmAdapter("ripstream-inproc", { program: paths.node, args: [...workerArgs, "server"] }),
    ],
    ["tika", () => new ColdAdapter("tika", (file) => tikaJava("sync", [file]), parseJsonExtraction, measure("tika"), TIKA_MAX_TIMEOUT_MS)],
    ["tika-warm", () => new WarmAdapter("tika-warm", tikaJava("server", []), TIKA_MAX_TIMEOUT_MS)],
    [
      "xberg",
      () =>
        new ColdAdapter(
          "xberg",
          (file, timeoutMs) => ({ program: paths.xberg, args: [...xbergArgs("extract", timeoutMs), file], env: XBERG_ENV }),
          parseJsonExtraction,
          measure("xberg"),
        ),
    ],
  ]);

  const batch = new Map<string, () => BatchAdapter>([
    [
      "xberg-batch",
      () =>
        new ProcessBatchAdapter(
          "xberg-batch",
          (files, timeoutMs) => ({ program: paths.xberg, args: [...xbergArgs("batch", timeoutMs), ...files], env: XBERG_ENV }),
          parseXbergBatch,
          measure("xberg-batch"),
        ),
    ],
    [
      "ripstream-batch",
      () =>
        new ProcessBatchAdapter(
          "ripstream-batch",
          (files) => ({ program: paths.node, args: [...workerArgs, "batch", ...files] }),
          parseJsonArrayBatch,
          measure("ripstream-batch"),
        ),
    ],
    [
      "tika-batch",
      () => new ProcessBatchAdapter("tika-batch", (files) => tikaJava("batch", files), parseJsonArrayBatch, measure("tika-batch")),
    ],
  ]);
  return { single, batch };
}

interface Parsed {
  readonly content?: string;
  readonly error?: string;
  readonly reportedMs?: number;
  readonly reportedPeakRss?: number;
}

class ColdAdapter implements Adapter {
  readonly regime = "cold_process";
  readonly name: string;
  readonly maxTimeoutMs?: number;
  readonly #command: (file: string, timeoutMs: number) => CommandSpec;
  readonly #parse: (stdout: string) => Parsed;
  readonly #measure: { timeBinary: string | null; rssFile: string };

  constructor(
    name: string,
    command: (file: string, timeoutMs: number) => CommandSpec,
    parse: (stdout: string) => Parsed,
    measure: { timeBinary: string | null; rssFile: string },
    maxTimeoutMs?: number,
  ) {
    this.name = name;
    this.#command = command;
    this.#parse = parse;
    this.#measure = measure;
    if (maxTimeoutMs !== undefined) this.maxTimeoutMs = maxTimeoutMs;
  }

  async setup(): Promise<void> {}

  async teardown(): Promise<number | null> {
    return null;
  }

  async extract(path: string, timeoutMs: number): Promise<Extraction> {
    const measured = await runMeasured(this.#command(path, timeoutMs), { timeoutMs, ...this.#measure });
    return fromProcess(measured, this.#parse);
  }
}

function fromProcess(measured: Measured, parse: (stdout: string) => Parsed): Extraction {
  const base = { wallMs: measured.wallMs, rssBytes: measured.maxRssBytes, content: "" };
  if (measured.timedOut) return { ...base, success: false, errorKind: "timeout", error: "timed out" };
  if (measured.exitCode !== 0) {
    const status = measured.signal === null ? `exit ${measured.exitCode}` : `signal ${measured.signal}`;
    return { ...base, success: false, errorKind: "framework_error", error: `${status}: ${tail(measured.stderr)}` };
  }
  let parsed: Parsed;
  try {
    parsed = parse(measured.stdout);
  } catch (error) {
    return { ...base, success: false, errorKind: "framework_error", error: `unparseable output: ${String(error)}` };
  }
  return withContent(base, parsed);
}

function withContent(base: { wallMs: number; rssBytes: number | null }, parsed: Parsed): Extraction {
  const reported = parsed.reportedMs === undefined ? {} : { reportedMs: parsed.reportedMs };
  // A tool's own peak counts when it is at least what was measured (merge_reported_metrics).
  const rssBytes =
    parsed.reportedPeakRss !== undefined && base.rssBytes !== null ? Math.max(base.rssBytes, parsed.reportedPeakRss) : base.rssBytes;
  if (parsed.error !== undefined) {
    const kind = parsed.error.includes("timed out") ? "timeout" : "framework_error";
    return { ...base, ...reported, rssBytes, content: "", success: false, errorKind: kind, error: parsed.error };
  }
  const content = parsed.content ?? "";
  if (content.trim() === "") {
    return { ...base, ...reported, rssBytes, content, success: false, errorKind: "empty_content", error: "empty content" };
  }
  return { ...base, ...reported, rssBytes, content, success: true, errorKind: "none" };
}

class WarmAdapter implements Adapter {
  readonly regime = "warm_in_process";
  readonly name: string;
  readonly maxTimeoutMs?: number;
  readonly #server: LineServer;
  #setupTimeoutMs = 120_000;
  #running = false;

  constructor(name: string, command: CommandSpec, maxTimeoutMs?: number) {
    this.name = name;
    this.#server = new LineServer(command);
    if (maxTimeoutMs !== undefined) this.maxTimeoutMs = maxTimeoutMs;
  }

  async setup(timeoutMs: number): Promise<void> {
    this.#setupTimeoutMs = timeoutMs;
    await this.#server.start(timeoutMs);
    this.#running = true;
  }

  async teardown(): Promise<number | null> {
    await this.#server.stop();
    this.#running = false;
    return this.#server.peakRssBytes || null;
  }

  async extract(path: string, timeoutMs: number): Promise<Extraction> {
    if (!this.#running) await this.setup(this.#setupTimeoutMs);
    const answer = await this.#server.request(path, timeoutMs);
    // Warm lanes report no per-file RSS: one process serves every file (as the harness's steady-state lanes).
    const base = { wallMs: answer.wallMs, rssBytes: null, content: "" };
    if (answer.timedOut || answer.line === null) {
      const stderr = this.#server.stderrTail;
      await this.#server.kill();
      this.#running = false;
      return answer.timedOut
        ? { ...base, success: false, errorKind: "timeout", error: "timed out" }
        : { ...base, success: false, errorKind: "framework_error", error: `server exited: ${tail(stderr)}` };
    }
    try {
      return withContent(base, parseJsonExtraction(answer.line));
    } catch (error) {
      return { ...base, success: false, errorKind: "framework_error", error: `unparseable output: ${String(error)}` };
    }
  }
}

class ProcessBatchAdapter implements BatchAdapter {
  readonly name: string;
  readonly #command: (files: readonly string[], timeoutMs: number) => CommandSpec;
  readonly #parse: (stdout: string, count: number) => BatchItem[];
  readonly #measure: { timeBinary: string | null; rssFile: string };

  constructor(
    name: string,
    command: (files: readonly string[], timeoutMs: number) => CommandSpec,
    parse: (stdout: string, count: number) => BatchItem[],
    measure: { timeBinary: string | null; rssFile: string },
  ) {
    this.name = name;
    this.#command = command;
    this.#parse = parse;
    this.#measure = measure;
  }

  async run(paths: readonly string[], timeoutMs: number): Promise<BatchRun> {
    const measured = await runMeasured(this.#command(paths, timeoutMs), { timeoutMs, ...this.#measure });
    const base = { wallMs: measured.wallMs, rssBytes: measured.maxRssBytes, timedOut: measured.timedOut };
    if (measured.timedOut) return { ...base, error: "timed out", items: [] };
    try {
      const items = this.#parse(measured.stdout, paths.length);
      if (measured.exitCode !== 0 && items.length === 0) {
        return { ...base, error: `exit ${measured.exitCode}: ${tail(measured.stderr)}`, items: [] };
      }
      return { ...base, items };
    } catch (error) {
      return { ...base, error: `exit ${measured.exitCode}, unparseable output: ${String(error)}; ${tail(measured.stderr)}`, items: [] };
    }
  }
}

function parsePlainText(stdout: string): Parsed {
  return { content: stdout };
}

/**
 * TikaExtract's `{content, metadata, _extraction_time_ms}`, xberg's single-file envelope
 * `{result: {content}, extraction_time_ms, peak_memory_bytes}` or a bare `{content}`.
 */
export function parseJsonExtraction(stdout: string): Parsed {
  const value = parseJsonObject(stdout);
  const result = isRecord(value.result) ? value.result : value;
  const reportedMs = numberOf(value._extraction_time_ms) ?? numberOf(value.extraction_time_ms);
  const reportedPeakRss = numberOf(value.peak_memory_bytes);
  const parsed: { content?: string; error?: string; reportedMs?: number; reportedPeakRss?: number } = {};
  if (typeof value.error === "string" && value.error !== "") parsed.error = value.error;
  else if (isRecord(value.error)) parsed.error = JSON.stringify(value.error);
  if (typeof result.content === "string") parsed.content = result.content;
  if (reportedMs !== undefined) parsed.reportedMs = reportedMs;
  if (reportedPeakRss !== undefined) parsed.reportedPeakRss = reportedPeakRss;
  return parsed;
}

/** `xberg batch`: `{results: [{content, metadata.additional.source_index}], errors: [{index, message}]}`. */
function parseXbergBatch(stdout: string, count: number): BatchItem[] {
  const value = parseJsonObject(stdout);
  if (!Array.isArray(value.results)) throw new Error("batch output has no results array");
  const contents: string[][] = Array.from({ length: count }, () => []);
  for (const item of value.results) {
    if (!isRecord(item)) continue;
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    const additional = isRecord(metadata.additional) ? metadata.additional : {};
    const index = numberOf(additional.source_index);
    if (index === undefined || index < 0 || index >= count) throw new Error("batch result without a valid source_index");
    if (typeof item.content === "string") contents[index]?.push(item.content);
  }
  const errors = new Map<number, string>();
  for (const error of Array.isArray(value.errors) ? value.errors : []) {
    if (isRecord(error) && typeof error.index === "number") errors.set(error.index, String(error.message ?? "error"));
  }
  return contents.map((parts, index) => {
    const content = parts.join("\n\n");
    const error = errors.get(index);
    if (error !== undefined) return { success: false, error, content };
    return content.trim() === "" ? { success: false, error: "empty content", content } : { success: true, content };
  });
}

/**
 * TikaExtract `batch` and inproc-worker `batch`: a JSON array in input order. TikaExtract
 * leaves failed files out of the array, so a short array cannot be matched to inputs; then
 * only the count of successes is meaningful.
 */
function parseJsonArrayBatch(stdout: string, count: number): BatchItem[] {
  const value: unknown = JSON.parse(stdout.slice(stdout.indexOf("[")));
  if (!Array.isArray(value)) throw new Error("batch output is not an array");
  const items = value.map((item): BatchItem => {
    if (!isRecord(item)) return { success: false, error: "not an object", content: "" };
    if (typeof item.error === "string") return { success: false, error: item.error, content: "" };
    const content = typeof item.content === "string" ? item.content : "";
    return content.trim() === "" ? { success: false, error: "empty content", content } : { success: true, content };
  });
  while (items.length < count) items.push({ success: false, error: "missing from batch output", content: "" });
  return items;
}

/** The JSON object in stdout; log lines a JVM writes before it are skipped. */
function parseJsonObject(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/^\{/m);
    if (start < 0) throw new Error(`no JSON object in output: ${tail(trimmed)}`);
    value = JSON.parse(trimmed.slice(start));
  }
  if (!isRecord(value)) throw new Error("output is not a JSON object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 600 ? trimmed : `...${trimmed.slice(-600)}`;
}
