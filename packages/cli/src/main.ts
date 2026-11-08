import { readFile } from "node:fs/promises";
import {
  EncryptedDocumentError,
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
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { FrancLanguageDetector } from "@spikedpunch/ripstream-language";
import { createRipstreamServer } from "@spikedpunch/ripstream-server";

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

export async function main(
  argv: readonly string[],
  io: CliIO = defaultIO,
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
  if (options.command === "serve") {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      io.stderr("ripstream: --port expects an integer between 0 and 65535\n");
      return EXIT_USAGE;
    }
    const instance = createRipstreamServer({ ripstream: createRipstream() });
    const port = await instance.listen(options.port, options.host);
    io.stdout(`ripstream server listening on http://${options.host}:${port}\n`);
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    await instance.close();
    return 0;
  }
  if (options.config !== null) {
    try {
      loadConfig(await readFile(options.config, "utf8"));
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }

  try {
    const bytes =
      options.file === null || options.file === "-"
        ? await io.readStdin()
        : new Uint8Array(await readFile(options.file));
    const filename =
      options.file === null || options.file === "-" ? undefined : options.file;
    const ripstream = createRipstream(
      options.password === null ? {} : { pdfPassword: options.password },
    );

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
    else if (argument.startsWith("-") && argument !== "-") {
      throw new Error(`Unknown option: ${argument}`);
    } else if (file === null) file = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!["parse", "detect", "metadata", "language", "serve", "help", "version"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  return { command, file, json, metadataOnly, recursive, output, config, password, port, host };
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
    "  -p, --password <pw>  Document password",
    "  -h, --help           Show help",
    "  -V, --version        Show version",
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
