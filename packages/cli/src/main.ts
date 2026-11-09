import { readFile } from "node:fs/promises";
import {
  EncryptedDocumentError,
  DEFAULT_LIMITS,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  MissingDependencyError,
  RipstreamError,
  UnsupportedFormatError,
  loadConfig,
  rmetaObject,
  serializeRmeta,
  type Metadata,
  type ParseRecord,
} from "@spikedpunch/ripstream-core";
import { createStandardIsolation, type StandardIsolation } from "@spikedpunch/ripstream-bundle-standard/isolation";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { FrancLanguageDetector } from "@spikedpunch/ripstream-language";
import { createRipstreamServer } from "@spikedpunch/ripstream-server";
import {
  IsolationSettingsError,
  resolveIsolationConfig,
  resolveMaxOutputChars,
  type ResolvedIsolation,
} from "./isolation-config.ts";

export interface CliIO {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly readStdin: () => Promise<Uint8Array>;
}

const defaultIO: CliIO = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return new Uint8Array(Buffer.concat(chunks));
  },
};

interface Options {
  readonly command: string;
  readonly file: string | null;
  readonly json: boolean;
  readonly metadataOnly: boolean;
  readonly recursive: boolean;
  readonly output: "text" | "json" | "jsonl";
  readonly config: string | null;
  readonly password: string | null;
  readonly port: number;
  readonly host: string;
  /** `--isolation` as typed; validated by resolveIsolationConfig. */
  readonly isolation: string | null;
  /** `--max-output-chars` as typed; validated by resolveMaxOutputChars. */
  readonly maxOutputChars: string | null;
}

/** Exit codes: 0 ok, 1 internal error, 2 usage error, 3 bad input data, 4 environment. */
const EXIT_INTERNAL = 1;
const EXIT_USAGE = 2;
const EXIT_DATA = 3;
const EXIT_ENVIRONMENT = 4;

function exitCodeFor(error: unknown): number {
  if (
    error instanceof MalformedDocumentError ||
    error instanceof UnsupportedFormatError ||
    error instanceof EncryptedDocumentError ||
    error instanceof LimitExceededError
  ) {
    return EXIT_DATA;
  }
  if (error instanceof IsolationSettingsError) return EXIT_USAGE;
  if (error instanceof MissingDependencyError) return EXIT_ENVIRONMENT;
  if (error instanceof IsolationError) {
    // queue_full/unavailable are infrastructure conditions; an unexplained
    // crash is an internal error, not a verdict on the document.
    return error.reason === "crash" ? EXIT_INTERNAL : EXIT_ENVIRONMENT;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return EXIT_ENVIRONMENT;
  }
  return EXIT_INTERNAL;
}

/** What a test (or an embedder) can replace: the process environment and how isolation is built. */
export interface CliDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly createIsolation?: typeof createStandardIsolation;
}

export async function main(
  argv: readonly string[],
  io: CliIO = defaultIO,
  deps: CliDeps = {},
): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }
  if (options.command === "help") {
    io.stdout(usage());
    return 0;
  }
  if (options.command === "version") {
    io.stdout("ripstream 0.0.0\n");
    return 0;
  }
  let settings: CliSettings;
  try {
    settings = await resolveSettings(options, deps.env ?? process.env);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }
  if (options.command === "serve") {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      io.stderr("ripstream: --port expects an integer between 0 and 65535\n");
      return EXIT_USAGE;
    }
    return serve(options, settings, deps, io);
  }
  if (settings.isolation.config.mode !== "off" && options.password !== null && ["parse", "metadata"].includes(options.command)) {
    io.stderr("ripstream: --password cannot be used with isolation: the password cannot cross the isolation boundary\n");
    return EXIT_USAGE;
  }

  let isolation: StandardIsolation | null = null;
  try {
    const bytes =
      options.file === null || options.file === "-"
        ? await io.readStdin()
        : new Uint8Array(await readFile(options.file));
    const filename =
      options.file === null || options.file === "-" ? undefined : options.file;
    const inProcess = createRipstream(
      options.password === null ? {} : { pdfPassword: options.password },
    );
    // Only the commands that run a parser are isolated; detection and language stay in this process.
    isolation =
      settings.isolation.config.mode !== "off" && (options.command === "parse" || options.command === "metadata")
        ? await openIsolation(settings, deps, io)
        : null;
    const ripstream = isolation === null ? inProcess : isolation.ripstream;

    if (options.command === "detect") {
      const result = await ripstream.detect(bytes, filename === undefined ? {} : { filename });
      if (options.json || options.output === "json") {
        io.stdout(`${JSON.stringify({ mediaType: result.toString() })}\n`);
      } else {
        io.stdout(`${result.toString()}\n`);
      }
      return 0;
    }

    if (options.command === "language") {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const result = new FrancLanguageDetector().detect(text);
      if (options.json || options.output === "json") {
        io.stdout(`${JSON.stringify(result)}\n`);
      } else {
        io.stdout(`${result.language}\n`);
      }
      return 0;
    }

    if (options.command === "metadata") {
      const result = await ripstream.parse(bytes, filename === undefined ? {} : { filename });
      io.stdout(`${JSON.stringify(metadataObject(result.metadata), null, options.json ? 2 : 0)}\n`);
      return 0;
    }

    if (options.recursive) {
      const records = await ripstream.parseRecursive(
        bytes,
        filename === undefined ? {} : { filename },
      );
      if (options.output === "jsonl") {
        io.stdout(records.map((record) => `${JSON.stringify(rmetaObject(record))}\n`).join(""));
      } else {
        io.stdout(`${serializeRmeta(records)}\n`);
      }
      return 0;
    }

    const result = await ripstream.parse(bytes, filename === undefined ? {} : { filename });
    if (options.metadataOnly) {
      io.stdout(`${JSON.stringify(metadataObject(result.metadata), null, options.json ? 2 : 0)}\n`);
    } else if (options.output === "jsonl") {
      io.stdout(
        `${JSON.stringify({
          ...metadataObject(result.metadata),
          "X-TIKA:content": result.text,
        })}\n`,
      );
    } else if (options.output === "json" || options.json) {
      io.stdout(
        `${JSON.stringify({
          text: result.text,
          metadata: metadataObject(result.metadata),
        }, null, 2)}\n`,
      );
    } else {
      io.stdout(result.text);
    }
    return 0;
  } catch (error) {
    if (options.json || options.output === "json") {
      io.stderr(
        `${JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof RipstreamError ? error.code : "ERROR",
        })}\n`,
      );
    } else {
      io.stderr(`ripstream: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return exitCodeFor(error);
  } finally {
    await isolation?.isolator.dispose();
  }
}

/**
 * The server product. Isolation is on unless the operator turned it off, and a strict server that cannot isolate does
 * not start (exit 4): it never falls back to parsing hostile documents in its own process.
 */
async function serve(options: Options, settings: CliSettings, deps: CliDeps, io: CliIO): Promise<number> {
  let isolation: StandardIsolation | null = null;
  try {
    // The ceiling is also the default: a request that names no cap gets it. With isolation it is required, because the
    // child's result cap and memory derive from it, so the isolation is built for exactly that cap.
    const isolating = settings.isolation.config.mode !== "off";
    const maxOutputChars = settings.maxOutputChars ?? (isolating ? DEFAULT_LIMITS.maxOutputChars : null);
    if (isolating) isolation = await openIsolation(settings, deps, io, maxOutputChars ?? undefined);
    const instance = createRipstreamServer({
      ripstream: isolation === null ? createRipstream() : isolation.ripstream,
      ...(isolation === null ? {} : { isolation: isolation.isolator }),
      ...(maxOutputChars === null ? {} : { maxLimits: { maxOutputChars } }),
      log: (level, message) => {
        if (level === "warn") io.stderr(`ripstream: WARN: ${message}\n`);
      },
    });
    try {
      let port: number;
      try {
        port = await instance.listen(options.port, options.host);
      } catch (error) {
        io.stderr(`ripstream: cannot listen on ${options.host}:${options.port}: ${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_ENVIRONMENT;
      }
      io.stdout(`ripstream server listening on http://${options.host}:${port}\n`);
      io.stdout(`${describeIsolation(settings, isolation)}\n`);
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          resolve();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      });
    } finally {
      await instance.close();
    }
    return 0;
  } catch (error) {
    if (error instanceof IsolationError || error instanceof IsolationSettingsError) {
      io.stderr(`ripstream: ${error.message}\n`);
      return exitCodeFor(error);
    }
    throw error;
  } finally {
    await isolation?.isolator.dispose();
  }
}

/** One line for the operator: the mode, where it came from and, when isolating, what the pool allows. */
function describeIsolation(settings: CliSettings, isolation: StandardIsolation | null): string {
  const configured = `${settings.isolation.config.mode} (${settings.isolation.modeSource})`;
  if (isolation === null) return `ripstream: isolation ${configured}: documents are parsed in this process`;
  const status = isolation.isolator.status();
  if (status.pool === null || status.defaultReservationMb === null) {
    return `ripstream: isolation ${configured}, in force: ${status.mode}${status.degraded ? " (degraded)" : ""}`;
  }
  return (
    `ripstream: isolation ${configured}; memory pool ${status.pool.poolMb} MiB, ` +
    `${status.defaultReservationMb.text} MiB reserved per request, containment ${JSON.stringify(status.containment)}`
  );
}

/**
 * Builds the isolation for this invocation; its warnings go to stderr. Strict refusal is an IsolationError. A setting
 * the isolation rejects (a RangeError, e.g. an output ceiling no child could hold) is the operator's mistake, so it
 * becomes a usage error.
 */
async function openIsolation(
  settings: CliSettings,
  deps: CliDeps,
  io: CliIO,
  defaultMaxOutputChars?: number,
): Promise<StandardIsolation> {
  const create = deps.createIsolation ?? createStandardIsolation;
  try {
    return await create({
      config: settings.isolation.config,
      ...(defaultMaxOutputChars === undefined ? {} : { defaultMaxOutputChars }),
      log: (level, message) => {
        if (level === "warn") io.stderr(`ripstream: WARN: ${message}\n`);
      },
    });
  } catch (error) {
    if (error instanceof RangeError) throw new IsolationSettingsError(error.message);
    throw error;
  }
}

interface CliSettings {
  readonly isolation: ResolvedIsolation;
  /** The server-side output ceiling from `--max-output-chars` / RIPSTREAM_MAX_OUTPUT_CHARS, or null. */
  readonly maxOutputChars: number | null;
}

/**
 * Reads the configuration file (any command may pass `--config`), then merges flag, environment and file into the
 * isolation settings. `serve` is the server product and isolates by default; the one-shot commands do not.
 */
async function resolveSettings(
  options: Options,
  env: Readonly<Record<string, string | undefined>>,
): Promise<CliSettings> {
  const fileIsolation = options.config === null ? null : loadConfig(await readFile(options.config, "utf8")).isolation;
  // detect and language run in this process whatever is set, so what is set cannot make them fail.
  if (options.command === "detect" || options.command === "language") {
    return { isolation: { config: { mode: "off" }, modeSource: "default" }, maxOutputChars: null };
  }
  try {
    return {
      isolation: resolveIsolationConfig({
        defaultMode: options.command === "serve" ? "strict" : "off",
        flagMode: options.isolation,
        env,
        fileIsolation,
      }),
      // Only the server has an output ceiling; a one-shot command ignores it.
      maxOutputChars: options.command === "serve" ? resolveMaxOutputChars({ flag: options.maxOutputChars, env }) : null,
    };
  } catch (error) {
    if (error instanceof IsolationSettingsError) throw new Error(`ripstream: ${error.message}`);
    throw error;
  }
}

function parseArgs(argv: readonly string[]): Options {
  const known = ["parse", "detect", "metadata", "language", "serve", "help", "version"];
  const command = argv[0] !== undefined && known.includes(argv[0]) ? argv[0] : "parse";
  const rest = argv[0] !== undefined && known.includes(argv[0]) ? argv.slice(1) : argv;
  let json = false;
  let metadataOnly = false;
  let recursive = false;
  let output: "text" | "json" | "jsonl" = "text";
  let config: string | null = null;
  let password: string | null = null;
  let file: string | null = null;
  let port = 9998;
  let host = "127.0.0.1";
  let isolation: string | null = null;
  let maxOutputChars: string | null = null;

  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]!;
    if (argument === "--json" || argument === "-j") json = true;
    else if (argument === "--metadata" || argument === "-m") metadataOnly = true;
    else if (argument === "--recursive" || argument === "-r") recursive = true;
    else if (argument === "--help" || argument === "-h") return { ...defaultOptions(), command: "help" };
    else if (argument === "--version" || argument === "-V") return { ...defaultOptions(), command: "version" };
    else if (argument === "--output" || argument === "-o") {
      const value = rest[++index];
      if (value !== "text" && value !== "json" && value !== "jsonl") {
        throw new Error("--output expects text, json or jsonl");
      }
      output = value;
    } else if (argument === "--config" || argument === "-c") config = rest[++index] ?? null;
    else if (argument === "--password" || argument === "-p") password = rest[++index] ?? null;
    else if (argument === "--port") port = Number(rest[++index] ?? "9998");
    else if (argument === "--host") host = rest[++index] ?? "127.0.0.1";
    else if (argument === "--isolation") isolation = requireValue(rest[++index], "--isolation");
    else if (argument === "--max-output-chars") maxOutputChars = requireValue(rest[++index], "--max-output-chars");
    else if (argument.startsWith("-") && argument !== "-") {
      throw new Error(`Unknown option: ${argument}`);
    } else if (file === null) file = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!["parse", "detect", "metadata", "language", "serve", "help", "version"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  return { command, file, json, metadataOnly, recursive, output, config, password, port, host, isolation, maxOutputChars };
}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`${flag} expects a value`);
  return value;
}

function defaultOptions(): Options {
  return {
    command: "parse",
    file: null,
    json: false,
    metadataOnly: false,
    recursive: false,
    output: "text",
    config: null,
    password: null,
    port: 9998,
    host: "127.0.0.1",
    isolation: null,
    maxOutputChars: null,
  };
}

function metadataObject(metadata: Metadata): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = {};
  for (const name of metadata.names()) result[name] = metadata.getAll(name);
  return result;
}

function usage(): string {
  return [
    "Usage: ripstream [command] [options] [file|-]",
    "",
    "Commands:",
    "  parse       Extract text (default)",
    "  detect      Detect media type",
    "  metadata    Print metadata JSON",
    "  language    Detect text language",
    "  serve       Start the HTTP server (--port, --host)",
    "",
    "Options:",
    "  -j, --json           JSON output",
    "  -m, --metadata       Metadata only",
    "  -r, --recursive      Recursive metadata JSON",
    "  -o, --output <mode>  text, json or jsonl",
    "  -c, --config <file>  Validate JSON configuration",
    "  -p, --password <pw>  Document password (not available with --isolation)",
    "      --isolation <mode>  strict, lenient or off: parse each document in its own child process",
    "                          (serve: strict unless set; other commands: off unless set)",
    "      --max-output-chars <n>  serve: ceiling on extracted characters per request",
    "  -h, --help           Show help",
    "  -V, --version        Show version",
    "",
    "Environment (flags win): RIPSTREAM_ISOLATION, RIPSTREAM_ISOLATION_MEMORY_POOL_MB, _PER_CHILD_MB,",
    "  _MAX_INPUT_BYTES, _MAX_TASK_MILLIS, _HEAP_MB, _MAX_QUEUE, _REQUIRE_STRICT_CONTAINMENT, RIPSTREAM_MAX_OUTPUT_CHARS",
    "",
    "Exit codes:",
    "  0  success",
    "  1  internal error",
    "  2  usage error (bad arguments or configuration)",
    "  3  bad input data (malformed, unsupported, encrypted or over-limit document)",
    "  4  environment problem (file not found, missing optional dependency)",
    "",
  ].join("\n");
}
