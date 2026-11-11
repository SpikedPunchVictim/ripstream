import { readFile } from "node:fs/promises";
import {
  EncryptedDocumentError,
  DEFAULT_LIMITS,
  DEFAULT_SERVER_ENDPOINTS,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  MissingDependencyError,
  RipstreamConfigError,
  RipstreamError,
  UnsupportedFormatError,
  emitMetadataFilter,
  loadConfig,
  metadataFiltersOf,
  metadataJson,
  rmetaObjects,
  serializeRmeta,
  type Metadata,
  type MetadataFilterServices,
  type ParseLimits,
  type ParseRecord,
  type RipstreamConfig,
} from "@spikedpunch/ripstream-core";
import { createStandardIsolation, type StandardIsolation } from "@spikedpunch/ripstream-bundle-standard/isolation";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { CharSoupLanguageDetector, FrancLanguageDetector } from "@spikedpunch/ripstream-language";
import { CheckpointStore, createEngineFromSettings, isFailure, type Reporter } from "@spikedpunch/ripstream-pipes";
import { createRipstreamServer, extensionFor, type ServerMimeType } from "@spikedpunch/ripstream-server";
import { serverMimeTypes } from "./mime-types.ts";
import {
  IsolationSettingsError,
  assertKnownVariables,
  resolveIsolationConfig,
  resolveMaxOutputChars,
  type ResolvedIsolation,
} from "./isolation-config.ts";

export interface CliIO {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly readStdin: () => Promise<Uint8Array>;
}

/** What a configuration's metadata filters need that core has not: Tika's CharSoup for `charsoup-metadata-filter`. The model is read when a document first needs it. */
const METADATA_FILTER_SERVICES: MetadataFilterServices = { languageIdentifier: new CharSoupLanguageDetector() };

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
  /** `--port`, or null when not given: the configuration's `server.port`, then 9998. */
  readonly port: number | null;
  /** `--host`, or null when not given: the configuration's `server.host`, then 127.0.0.1. `*` is every interface. */
  readonly host: string | null;
  /** `--isolation` as typed; validated by resolveIsolationConfig. */
  readonly isolation: string | null;
  /** `--max-output-chars` as typed; validated by resolveMaxOutputChars. */
  readonly maxOutputChars: string | null;
  /** `--maxEmbeddedDepth` and `--maxEmbeddedCount` as typed; validated by embeddedLimit. */
  readonly maxEmbeddedDepth: string | null;
  readonly maxEmbeddedCount: string | null;
  /** `--checkpoint`, pipes only: the file that records which inputs are done, so a run that stopped can be started again. */
  readonly checkpoint: string | null;
  /** `--retry-attempts` as typed, pipes only; validated by retryAttempts. */
  readonly retryAttempts: string | null;
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
  // A configuration that names what ripstream cannot apply is the operator's mistake, like a bad flag.
  if (error instanceof IsolationSettingsError || error instanceof RipstreamConfigError) return EXIT_USAGE;
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
    if (options.port !== null && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
      io.stderr("ripstream: --port expects an integer between 0 and 65535\n");
      return EXIT_USAGE;
    }
    return serve(options, settings, deps, io);
  }
  if (options.command === "pipes") return pipes(options, settings, deps, io);
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
    const inProcess = createRipstream({
      ...(options.password === null ? {} : { pdfPassword: options.password }),
      ...(settings.config === null ? {} : { config: settings.config }),
      ...(settings.limits === null ? {} : { limits: settings.limits }),
    });
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
      io.stdout(`${JSON.stringify(metadataJson(result.metadata), null, options.json ? 2 : 0)}\n`);
      return 0;
    }

    if (options.recursive) {
      const records = await ripstream.parseRecursive(
        bytes,
        filename === undefined ? {} : { filename },
      );
      // Tika's CLI runs the configured `metadata-filters` over the list it writes as recursive JSON, and nowhere else.
      const metadataFilter =
        settings.config === null ? null : emitMetadataFilter({ ...metadataFiltersOf(settings.config, METADATA_FILTER_SERVICES), parseContext: null }, false);
      const written = metadataFilter === null ? {} : { metadataFilter };
      if (options.output === "jsonl") {
        io.stdout(rmetaObjects(records, written).map((object) => `${JSON.stringify(object)}\n`).join(""));
      } else {
        io.stdout(`${serializeRmeta(records, written)}\n`);
      }
      return 0;
    }

    const result = await ripstream.parse(bytes, filename === undefined ? {} : { filename });
    if (options.metadataOnly) {
      io.stdout(`${JSON.stringify(metadataJson(result.metadata), null, options.json ? 2 : 0)}\n`);
    } else if (options.output === "jsonl") {
      io.stdout(
        `${JSON.stringify({
          ...metadataJson(result.metadata),
          "tk:content": result.text,
        })}\n`,
      );
    } else if (options.output === "json" || options.json) {
      io.stdout(
        `${JSON.stringify({
          text: result.text,
          metadata: metadataJson(result.metadata),
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
    // The flags are Tika's -p and -h, which outrank the file. Tika's `-h *` and `host: "*"` mean every interface.
    const server = settings.config?.server ?? {};
    const host = options.host === null ? (server.host ?? "127.0.0.1") : options.host === "*" ? "0.0.0.0" : options.host;
    const wantedPort = options.port ?? server.port ?? 9998;
    const defaults = settings.config?.limits;
    const defaultLimits = {
      ...(defaults?.maxOutputChars === undefined ? {} : { maxOutputChars: defaults.maxOutputChars }),
      ...(defaults?.maxEmbeddedResources === undefined ? {} : { maxEmbeddedResources: defaults.maxEmbeddedResources }),
    };
    // Info and debug lines are shown when the section asks for request logging, down to the level it names.
    const shown = server.requestLogLevel === "debug" ? ["warn", "info", "debug"] : server.requestLogLevel === "info" ? ["warn", "info"] : ["warn"];
    let instance: ReturnType<typeof createRipstreamServer>;
    try {
      instance = createRipstreamServer({
        ripstream:
          isolation === null
            ? createRipstream(settings.config === null ? {} : { config: settings.config })
            : isolation.ripstream,
        ...(isolation === null ? {} : { isolation: isolation.isolator }),
        ...(maxOutputChars === null ? {} : { maxLimits: { maxOutputChars } }),
        ...(Object.keys(defaultLimits).length === 0 ? {} : { defaultLimits }),
        // `throwOnWriteLimit: true` in the file asks for a failure at the limit; without it the server answers as Tika does.
        ...(settings.config?.throwOnWriteLimit === true ? { onOutputLimit: "throw" as const } : {}),
        endpoints: server.endpoints ?? DEFAULT_SERVER_ENDPOINTS,
        mimeTypes: serverMimeTypes(settings.config?.customMimeTypes ?? null),
        ...(settings.config === null ? {} : { metadataFilters: metadataFiltersOf(settings.config, METADATA_FILTER_SERVICES) }),
        ...(server.cors === undefined ? {} : { corsOrigin: server.cors }),
        ...(server.maxRequestSizeBytes === undefined ? {} : { maxBodyBytes: server.maxRequestSizeBytes }),
        ...(server.requestLogLevel === undefined ? {} : { requestLogLevel: server.requestLogLevel }),
        ...(server.maxRequestReadMillis === undefined ? {} : { maxRequestReadMillis: server.maxRequestReadMillis }),
        ...(server.idleTimeoutMillis === undefined ? {} : { idleTimeoutMillis: server.idleTimeoutMillis }),
        log: (level, message) => {
          if (!shown.includes(level)) return;
          io.stderr(level === "warn" ? `ripstream: WARN: ${message}\n` : `ripstream: ${message}\n`);
        },
      });
    } catch (error) {
      // A setting the server rejects (a default above the ceiling) is the operator's mistake.
      if (error instanceof RangeError) throw new IsolationSettingsError(error.message);
      throw error;
    }
    try {
      let port: number;
      try {
        port = await instance.listen(wantedPort, host);
      } catch (error) {
        io.stderr(`ripstream: cannot listen on ${host}:${wantedPort}: ${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_ENVIRONMENT;
      }
      io.stdout(`ripstream server listening on http://${host}:${port}\n`);
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
    if (error instanceof IsolationError || error instanceof IsolationSettingsError || error instanceof RipstreamConfigError) {
      io.stderr(`ripstream: ${error.message}\n`);
      return exitCodeFor(error);
    }
    throw error;
  } finally {
    await isolation?.isolator.dispose();
  }
}

/** The most failed inputs `pipes` names on stderr; the run's reporters have all of them. */
const MAX_FAILURES_SHOWN = 100;

/**
 * Runs the pipes sections of a Tika configuration (tikajs-68os.6.5): the pipes-iterator lists the tuples, the fetchers
 * read them, each document is parsed and the emitters write it, and the reporters hear every result. A failed input
 * does not stop the run; it is named on stderr and the exit code is 3 when there was one.
 *
 * `--checkpoint <file>` makes the run one that can be started again after it was stopped, however it was stopped:
 * the inputs that are in the file are left out. `--retry-attempts <n>` tries a fetch or an emit that failed in a way
 * that may not happen again (a reset connection, a 503) up to n times in all.
 */
async function pipes(options: Options, settings: CliSettings, deps: CliDeps, io: CliIO): Promise<number> {
  let isolation: StandardIsolation | null = null;
  try {
    const pipesSettings = settings.config?.pipes;
    if (pipesSettings === null || pipesSettings === undefined) {
      io.stderr("ripstream: pipes needs --config with the pipes sections (fetchers, emitters and a pipes-iterator)\n");
      return EXIT_USAGE;
    }
    for (const notice of pipesSettings.notices) io.stderr(`ripstream: NOTE: ${notice}\n`);
    let checkpoint: CheckpointStore | undefined;
    if (options.checkpoint !== null) {
      try {
        checkpoint = await CheckpointStore.open(options.checkpoint);
      } catch (error) {
        io.stderr(`ripstream: ${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_USAGE;
      }
      // Emitting and recording are two steps, so a run that is killed between them emits that input again on resume.
      const strict = pipesSettings.emitters
        .filter((emitter) => emitter.type === "file-system-emitter" && emitter.onExists === "EXCEPTION")
        .map((emitter) => emitter.id);
      if (strict.length > 0) {
        io.stderr(
          `ripstream: WARN: emitter ${strict.join(", ")} has onExists EXCEPTION (Tika's default): an input that was emitted just before a run was ` +
            "killed fails with EMIT_EXCEPTION when the run is resumed, and is done again on the next one. Set onExists to SKIP or REPLACE for a clean resume\n",
        );
      }
    }
    isolation = settings.isolation.config.mode !== "off" ? await openIsolation(settings, deps, io) : null;
    const ripstream =
      isolation === null
        ? createRipstream({
            ...(settings.config === null ? {} : { config: settings.config }),
            ...(settings.limits === null ? {} : { limits: settings.limits }),
          })
        : isolation.ripstream;
    let shown = 0;
    const reporter: Reporter = {
      report: (result) => {
        if (!isFailure(result)) return;
        if (++shown <= MAX_FAILURES_SHOWN) io.stderr(`ripstream: ${result.status} ${result.id}${result.message === undefined ? "" : `: ${result.message}`}\n`);
      },
    };
    // Read when a file is first named by its media type, once.
    let mimeTypes: ServerMimeType[] | undefined;
    const engine = createEngineFromSettings(pipesSettings, {
      ripstream,
      reporter,
      metadataFilterServices: METADATA_FILTER_SERVICES,
      // UNPACK with `suffixStrategy: DETECTED` names files as `ripstream serve` and /unpack do: by the media type registry.
      extensionOf: (contentType) => extensionFor(contentType, (mimeTypes ??= serverMimeTypes(settings.config?.customMimeTypes ?? null))),
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(settings.retryAttempts === null ? {} : { retry: { attempts: settings.retryAttempts } }),
    });
    await engine.run();
    const stats = engine.stats;
    if (shown > MAX_FAILURES_SHOWN) io.stderr(`ripstream: and ${shown - MAX_FAILURES_SHOWN} more failed inputs (the reporters have all of them)\n`);
    if (options.json || options.output === "json") {
      io.stdout(`${JSON.stringify(stats)}\n`);
    } else {
      io.stdout(
        `ripstream: pipes: fetched ${stats.fetched}, resumed ${stats.resumed}, emitted ${stats.emitted}, failed ${stats.failed} (${Math.round(stats.durationMs)} ms)\n`,
      );
    }
    return stats.failed === 0 ? 0 : EXIT_DATA;
  } catch (error) {
    io.stderr(`ripstream: ${error instanceof Error ? error.message : String(error)}\n`);
    return exitCodeFor(error);
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
      // The child, the routing detector and the in-process parsers all build from the configuration's sections; its
      // limits, with the flags laid over them, are the defaults of every parse.
      ...(settings.config === null ? {} : { ripstreamConfig: settings.config }),
      ...(settings.limits === null ? {} : { limits: settings.limits }),
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
  /** The loaded `--config` file, or null. Its `parsers`, `detectors` and `parse-context` sections apply in this process and in the isolation child. */
  readonly config: RipstreamConfig | null;
  /** The server-side output ceiling from `--max-output-chars` / RIPSTREAM_MAX_OUTPUT_CHARS, or null. */
  readonly maxOutputChars: number | null;
  /** The limits of `--maxEmbeddedDepth` / `--maxEmbeddedCount`, which win over the configuration's, or null. */
  readonly limits: Partial<ParseLimits> | null;
  /** `--retry-attempts` (tries in all, the first included), or null: no retry. */
  readonly retryAttempts: number | null;
}

/** Digits only, at least 1: `--retry-attempts 1` is one try, so no retry. */
function retryAttempts(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    throw new Error(`ripstream: --retry-attempts expects a positive integer (tries in all, the first included), got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

/** Digits only, as for --port: `Number("")` is 0 and `Number(" 3 ")` is 3, neither of which is what was typed. */
function embeddedLimit(flag: string, raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`ripstream: ${flag} expects a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

/**
 * Reads the configuration file (any command may pass `--config`), then merges flag, environment and file into the
 * isolation settings. `serve` is the server product and isolates by default; the one-shot commands do not.
 */
async function resolveSettings(
  options: Options,
  env: Readonly<Record<string, string | undefined>>,
): Promise<CliSettings> {
  const config = options.config === null ? null : loadConfig(await readFile(options.config, "utf8"));
  const fileIsolation = config === null ? null : config.isolation;
  const depth = embeddedLimit("--maxEmbeddedDepth", options.maxEmbeddedDepth);
  const count = embeddedLimit("--maxEmbeddedCount", options.maxEmbeddedCount);
  const flagged = [
    ...(depth === null ? [] : ["--maxEmbeddedDepth"]),
    ...(count === null ? [] : ["--maxEmbeddedCount"]),
  ];
  if (flagged.length > 0 && options.command !== "parse" && options.command !== "metadata") {
    // A flag that changes nothing for the command it is given to must not look as if it did.
    throw new Error(`ripstream: ${flagged.join(" and ")} applies to parse and metadata, not ${options.command}`);
  }
  const pipesOnly = [...(options.checkpoint === null ? [] : ["--checkpoint"]), ...(options.retryAttempts === null ? [] : ["--retry-attempts"])];
  if (pipesOnly.length > 0 && options.command !== "pipes") {
    throw new Error(`ripstream: ${pipesOnly.join(" and ")} applies to pipes, not ${options.command}`);
  }
  const attempts = retryAttempts(options.retryAttempts);
  const limits: Partial<ParseLimits> | null =
    flagged.length === 0
      ? null
      : { ...(depth === null ? {} : { maxNodeDepth: depth }), ...(count === null ? {} : { maxEmbeddedResources: count }) };
  // detect and language run in this process whatever is set, so what is set cannot make them fail. Detection reads the
  // `detectors` section; neither runs a parser, so a `parsers` section has nothing to change for them.
  if (options.command === "detect" || options.command === "language") {
    return {
      isolation: { config: { mode: "off" }, modeSource: "default" },
      config: options.command === "detect" ? config : null,
      maxOutputChars: null,
      limits: null,
      retryAttempts: null,
    };
  }
  try {
    // After detect and language, which read no setting: a misspelling there changes nothing.
    assertKnownVariables(env);
    const isolation = resolveIsolationConfig({
      defaultMode: options.command === "serve" ? "strict" : "off",
      flagMode: options.isolation,
      env,
      fileIsolation,
    });
    return {
      isolation,
      config,
      limits,
      retryAttempts: attempts,
      // Only the server has an output ceiling; a one-shot command ignores it.
      maxOutputChars: options.command === "serve" ? resolveMaxOutputChars({ flag: options.maxOutputChars, env }) : null,
    };
  } catch (error) {
    if (error instanceof IsolationSettingsError) throw new Error(`ripstream: ${error.message}`);
    throw error;
  }
}

const COMMANDS: readonly string[] = ["parse", "detect", "metadata", "language", "serve", "pipes", "help", "version"];

function parseArgs(argv: readonly string[]): Options {
  const command = argv[0] !== undefined && COMMANDS.includes(argv[0]) ? argv[0] : "parse";
  const rest = argv[0] !== undefined && COMMANDS.includes(argv[0]) ? argv.slice(1) : argv;
  let json = false;
  let metadataOnly = false;
  let recursive = false;
  let output: "text" | "json" | "jsonl" = "text";
  let config: string | null = null;
  let password: string | null = null;
  let file: string | null = null;
  let port: number | null = null;
  let host: string | null = null;
  let isolation: string | null = null;
  let maxOutputChars: string | null = null;
  let maxEmbeddedDepth: string | null = null;
  let maxEmbeddedCount: string | null = null;
  let checkpoint: string | null = null;
  let retryAttemptsFlag: string | null = null;

  for (let index = 0; index < rest.length; index++) {
    const written = rest[index]!;
    // `--name=value` is `--name value`, split at the first `=`. Short options and flags that take no value do not
    // have the form: `-c=x` is not an option, and `--json=yes` is not a way to say --json.
    const equals = written.startsWith("--") ? written.indexOf("=") : -1;
    const argument = equals > 2 ? written.slice(0, equals) : written;
    const inline = equals > 2 ? written.slice(equals + 1) : null;
    if (inline !== null && !VALUE_FLAGS.has(argument)) {
      throw new Error(FLAGS.has(argument) ? `${argument} does not take a value` : `Unknown option: ${written}`);
    }
    const takeValue = (): string => {
      if (inline === null) return requireValue(rest[++index], argument);
      // The value was written after the `=`, so it is taken as it is even when it looks like a flag.
      if (inline === "") throw new Error(`${argument} expects a value`);
      return inline;
    };
    if (argument === "--json" || argument === "-j") json = true;
    else if (argument === "--metadata" || argument === "-m") metadataOnly = true;
    else if (argument === "--recursive" || argument === "-r") recursive = true;
    // Tika's serve takes -h as the host and -p as the port; everywhere else -h is help and -p the password.
    else if (argument === "--help" || argument === "-?" || (argument === "-h" && command !== "serve")) {
      return { ...defaultOptions(), command: "help" };
    }
    else if (argument === "--version" || argument === "-V") return { ...defaultOptions(), command: "version" };
    else if (argument === "--output" || argument === "-o") {
      const value = inline ?? rest[++index];
      if (value !== "text" && value !== "json" && value !== "jsonl") {
        throw new Error("--output expects text, json or jsonl");
      }
      output = value;
    } else if (argument === "--config" || argument === "-c") config = takeValue();
    else if (argument === "--password" || (argument === "-p" && command !== "serve")) password = takeValue();
    else if (argument === "--port" || argument === "-p") port = parsePort(takeValue());
    else if (argument === "--host" || argument === "-h") host = takeValue();
    else if (argument === "--isolation") isolation = takeValue();
    else if (argument === "--max-output-chars") maxOutputChars = takeValue();
    else if (argument === "--maxEmbeddedDepth") maxEmbeddedDepth = takeValue();
    else if (argument === "--maxEmbeddedCount") maxEmbeddedCount = takeValue();
    else if (argument === "--checkpoint") checkpoint = takeValue();
    else if (argument === "--retry-attempts") retryAttemptsFlag = takeValue();
    else if (argument.startsWith("-") && argument !== "-") {
      throw new Error(`Unknown option: ${argument}`);
    } else if (file === null) file = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!COMMANDS.includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  if (command === "pipes" && file !== null) {
    throw new Error("ripstream pipes takes no file: its inputs come from the configuration's pipes-iterator");
  }
  return {
    command, file, json, metadataOnly, recursive, output, config, password, port, host, isolation, maxOutputChars,
    maxEmbeddedDepth, maxEmbeddedCount, checkpoint, retryAttempts: retryAttemptsFlag,
  };
}

/** Every flag parseArgs knows. One of these in the place of a flag's value means the value was left out. */
const FLAGS: ReadonlySet<string> = new Set([
  "--json", "-j", "--metadata", "-m", "--recursive", "-r", "--help", "-h", "-?", "--version", "-V",
  "--output", "-o", "--config", "-c", "--password", "-p", "--port", "--host", "--isolation", "--max-output-chars",
  "--maxEmbeddedDepth", "--maxEmbeddedCount", "--checkpoint", "--retry-attempts",
]);

/** The long options that take a value: the ones `--name=value` is for. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--output", "--config", "--password", "--port", "--host", "--isolation", "--max-output-chars",
  "--maxEmbeddedDepth", "--maxEmbeddedCount", "--checkpoint", "--retry-attempts",
]);

/** The value after a flag. A missing one, or another flag in its place, is an error: it must not become a default. */
function requireValue(value: string | undefined, flag: string): string {
  // serve's -h is Tika's host; someone who typed it for help is told where help is.
  if (value === undefined) throw new Error(flag === "-h" ? "-h expects a value, the host (--help prints help)" : `${flag} expects a value`);
  if (FLAGS.has(value)) throw new Error(`${flag} expects a value, got the option ${value}`);
  return value;
}

/** Digits only: `Number("")` is 0 and `Number(" 80 ")` is 80, neither of which is what was typed. */
function parsePort(raw: string): number {
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
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
    port: null,
    host: null,
    isolation: null,
    maxOutputChars: null,
    maxEmbeddedDepth: null,
    maxEmbeddedCount: null,
    checkpoint: null,
    retryAttempts: null,
  };
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
    "  serve       Start the HTTP server (-p/--port, -h/--host; Tika's spellings)",
    "  pipes       Run the pipes sections of --config: the iterator's inputs, fetched, parsed and emitted",
    "",
    "Options:",
    "  -j, --json           JSON output",
    "  -m, --metadata       Metadata only",
    "  -r, --recursive      Recursive metadata JSON",
    "  -o, --output <mode>  text, json or jsonl",
    "  -c, --config <file>  JSON configuration (isolation, parsers, detectors, parse-context, metadata-filters, custom-mimetypes, server)",
    "  -p, --password <pw>  Document password (not available with --isolation; serve: -p is the port)",
    "      --isolation <mode>  strict, lenient or off: parse each document in its own child process",
    "                          (serve: strict unless set; other commands: off unless set)",
    "      --max-output-chars <n>  serve: ceiling on extracted characters per request",
    "      --maxEmbeddedDepth <n>  parse, metadata: fail (exit 3) when an embedded document is nested deeper than n",
    "      --maxEmbeddedCount <n>  parse, metadata: fail (exit 3) when more than n documents are embedded",
    "      --checkpoint <file>     pipes: record the inputs that are done, and leave them out when the run is started again",
    "      --retry-attempts <n>    pipes: try a fetch or an emit that failed in a way that may not happen again up to n times",
    "  -h, --help           Show help (serve: -h is the host; help is --help or -?)",
    "  -V, --version        Show version",
    "",
    "A long option that takes a value also accepts --name=value (--config=ripstream.json).",
    "",
    "Environment (flags win): RIPSTREAM_ISOLATION, RIPSTREAM_ISOLATION_MEMORY_POOL_MB, _PER_CHILD_MB,",
    "  _MAX_INPUT_BYTES, _MAX_TASK_MILLIS, _HEAP_MB, _MAX_QUEUE, _MAX_DISK_MB, _REQUIRE_STRICT_CONTAINMENT,",
    "  RIPSTREAM_MAX_OUTPUT_CHARS. Any other RIPSTREAM_* name is an error.",
    "",
    "Exit codes:",
    "  0  success",
    "  1  internal error",
    "  2  usage error (bad arguments or configuration)",
    "  3  bad input data (malformed, unsupported, encrypted or over-limit document; pipes: an input failed)",
    "  4  environment problem (file not found, missing optional dependency)",
    "",
  ].join("\n");
}
