import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  httpStatusForError,
  serializeRmeta,
  RipstreamError,
  type Metadata,
} from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { FrancLanguageDetector } from "@spikedpunch/ripstream-language";
import { PipesClient, PipesPathError, resolveWithinRoot, type PipesConfig } from "@spikedpunch/ripstream-pipes";
import { randomUUID } from "node:crypto";
import type { Ripstream, Translator } from "@spikedpunch/ripstream-core";

export interface RipstreamServerOptions {
  readonly ripstream?: Ripstream;
  readonly maxBodyBytes?: number;
  readonly maxConcurrent?: number;
  readonly maxQueue?: number;
  readonly requestTimeoutMs?: number;
  readonly corsOrigin?: string | readonly string[];
  readonly authenticate?: (request: IncomingMessage) => boolean | Promise<boolean>;
  readonly translator?: Translator;
  /** Server-side maxima for client-supplied `maxOutputChars` / `maxEmbeddedResources` query params. */
  readonly maxLimits?: { readonly maxOutputChars?: number; readonly maxEmbeddedResources?: number };
  /** Maximum retained /async jobs (default 1000); new jobs get 503 when all are still running. */
  readonly maxJobs?: number;
  /** How long finished /async jobs are retained (default 10 minutes). */
  readonly jobTtlMs?: number;
  /**
   * Enables POST /pipes. Disabled (404) when omitted. Requires `authenticate`. Clients may only
   * name paths relative to these roots; absolute paths, `..` and symlinks are rejected.
   */
  readonly pipes?: RipstreamServerPipesOptions;
  readonly presets?: Readonly<Record<string, { readonly handler?: string; readonly limits?: Record<string, number> }>>;
}

export interface RipstreamServerPipesOptions {
  /** Directory that client `source.path` values are resolved against. */
  readonly sourceRoot: string;
  /** Directory that client `sink.path` values are resolved against; sinks are refused when omitted. */
  readonly sinkRoot?: string;
  /** Allow `source.type: "http"` (SSRF-guarded). Default false. */
  readonly allowHttp?: boolean;
  /** Upper bound for client `concurrency` (default 4). */
  readonly maxConcurrency?: number;
  /** Upper bound for client `maxQueue` (default 64). */
  readonly maxQueue?: number;
}

interface Job {
  status: "running" | "done" | "error";
  result?: unknown;
  error?: string;
  updatedAt: number;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

export interface RipstreamServer {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void;
  readonly server: ReturnType<typeof createServer>;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/** Minimal synchronous Tika endpoint family: /detect, /tika, /meta, /rmeta. */
export function createRipstreamServer(options: RipstreamServerOptions = {}): RipstreamServer {
  const ripstream = options.ripstream ?? createRipstream();
  const maxBodyBytes = options.maxBodyBytes ?? 100 * 1024 * 1024;
  const maxConcurrent = options.maxConcurrent ?? 100;
  const maxQueue = options.maxQueue ?? 100;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const corsOrigin = options.corsOrigin;
  const languageDetector = new FrancLanguageDetector();
  let active = 0;
  const waiters: Array<() => void> = [];
  const maxJobs = options.maxJobs ?? 1000;
  const jobTtlMs = options.jobTtlMs ?? 10 * 60_000;
  const jobs = new Map<string, Job>();
  if (options.pipes !== undefined && options.authenticate === undefined) {
    throw new Error("createRipstreamServer: the `pipes` option requires `authenticate`");
  }

  /** Drops expired finished jobs, then the oldest finished jobs while at capacity. */
  const pruneJobs = (): void => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.status !== "running" && now - job.updatedAt > jobTtlMs) jobs.delete(id);
    }
    for (const [id, job] of jobs) {
      if (jobs.size < maxJobs) break;
      if (job.status !== "running") jobs.delete(id);
    }
  };

  const acquire = (): Promise<() => void> => {
    const release = (): void => {
      const next = waiters.shift();
      if (next !== undefined) next();
      else active--;
    };
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve(release);
    }
    if (waiters.length >= maxQueue) {
      return Promise.reject(new HttpError(503, "Server queue is full"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(start);
        if (index !== -1) waiters.splice(index, 1);
        reject(new HttpError(408, "Request timed out waiting for a worker"));
      }, requestTimeoutMs);
      const start = (): void => {
        clearTimeout(timer);
        active++;
        resolve(release);
      };
      waiters.push(start);
    });
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      if (corsOrigin !== undefined) {
        if (typeof corsOrigin === "string") {
          response.setHeader("Access-Control-Allow-Origin", corsOrigin);
        } else {
          // Allow-Origin accepts a single origin: echo the request origin when it is listed.
          response.setHeader("Vary", "Origin");
          const requestOrigin = request.headers.origin;
          if (requestOrigin !== undefined && corsOrigin.includes(requestOrigin)) {
            response.setHeader("Access-Control-Allow-Origin", requestOrigin);
          }
        }
        response.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
        response.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (options.authenticate !== undefined && !(await options.authenticate(request))) {
        send(response, 401, "text/plain", "Unauthorized");
        return;
      }
      let release: (() => void) | null = null;
      try {
        release = await acquire();
        await route(request, response, () => {
          const held = release;
          release = null;
          return held ?? (() => undefined);
        });
      } catch (error) {
        const status =
          error instanceof HttpError
            ? error.status
            : error instanceof RipstreamError
              ? httpStatusForError(error)
              : 500;
        const message = error instanceof Error ? error.message : String(error);
        const wantsJson = (request.headers.accept ?? "").includes("application/json");
        if (wantsJson) {
          sendJson(response, status, {
            error: message,
            code: error instanceof RipstreamError ? error.code : "ERROR",
          });
        } else {
          send(response, status, "text/plain", message);
        }
      } finally {
        release?.();
      }
    })();
  };

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    detachSlot: () => () => void,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname.startsWith("/status/")) {
      pruneJobs();
      const job = jobs.get(url.pathname.slice("/status/".length));
      if (job === undefined) {
        send(response, 404, "text/plain", "Unknown job");
        return;
      }
      const { updatedAt: _updatedAt, ...visible } = job;
      sendJson(response, 200, visible);
      return;
    }
    if (method === "POST" && url.pathname === "/pipes") {
      if (options.pipes === undefined) {
        send(response, 404, "text/plain", "Not found");
        return;
      }
      // Requiring JSON blocks cross-site "simple" POSTs (text/plain forms) that skip preflight.
      if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        throw new HttpError(415, "Content-Type must be application/json");
      }
      const config = await buildPipesConfig(
        parseJsonBody(await readBody(request, maxBodyBytes)),
        options.pipes,
      );
      const result = await new PipesClient(config).run();
      sendJson(response, 200, result);
      return;
    }
    if (method === "GET" && url.pathname === "/health") {
      send(response, 200, "text/plain", "ok");
      return;
    }
    if (method === "GET" && url.pathname === "/status") {
      sendJson(response, 200, { status: "ok", active });
      return;
    }
    if (method === "POST" && url.pathname === "/async") {
      const body = await readBody(request, maxBodyBytes);
      pruneJobs();
      if (jobs.size >= maxJobs) throw new HttpError(503, "Too many running async jobs");
      const id = randomUUID();
      jobs.set(id, { status: "running", updatedAt: Date.now() });
      const name = url.searchParams.get("filename") ?? undefined;
      // The concurrency slot stays held until the background parse settles.
      const releaseSlot = detachSlot();
      const signal = AbortSignal.timeout(requestTimeoutMs);
      void ripstream
        .parse(body, name === undefined ? { signal } : { filename: name, signal })
        .then((result) => {
          jobs.set(id, { status: "done", result: { text: result.text }, updatedAt: Date.now() });
        })
        .catch((error) => {
          jobs.set(id, { status: "error", error: String(error), updatedAt: Date.now() });
        })
        .finally(releaseSlot);
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(`${JSON.stringify({ id })}\n`);
      return;
    }
    if (method === "GET" && url.pathname === "/version") {
      send(response, 200, "text/plain", "ripstream 0.0.0\n");
      return;
    }
    if (url.pathname === "/language") {
      if (method !== "PUT" && method !== "POST") {
        response.setHeader("Allow", "PUT, POST");
        send(response, 405, "text/plain", "Method not allowed");
        return;
      }
      const body = await readBody(request, maxBodyBytes);
      const result = languageDetector.detect(
        new TextDecoder("utf-8", { fatal: false }).decode(body),
      );
      sendJson(response, 200, result);
      return;
    }
    if (url.pathname === "/translate") {
      if (method !== "PUT" && method !== "POST") {
        response.setHeader("Allow", "PUT, POST");
        send(response, 405, "text/plain", "Method not allowed");
        return;
      }
      if (options.translator === undefined) {
        send(response, 501, "text/plain", "No translator configured");
        return;
      }
      const target = url.searchParams.get("target") ?? "en";
      const body = new TextDecoder("utf-8", { fatal: false }).decode(
        await readBody(request, maxBodyBytes),
      );
      const translated = await options.translator.translate(body, target);
      send(response, 200, "text/plain; charset=utf-8", translated);
      return;
    }
    const presets = options.presets ?? {};
    const presetName = url.searchParams.get("preset");
    const preset = presetName === null ? undefined : presets[presetName];
    const presetHandler = preset?.handler;
    const limits: Record<string, number> = { ...(preset?.limits ?? {}) };
    for (const key of ["maxOutputChars", "maxEmbeddedResources"] as const) {
      const requested = clientLimit(url.searchParams.get(key), key);
      const ceiling = options.maxLimits?.[key];
      const value = requested ?? limits[key];
      if (ceiling !== undefined) limits[key] = Math.min(value ?? ceiling, ceiling);
      else if (value !== undefined) limits[key] = value;
    }
    const handlerOverride = url.searchParams.get("handler") ?? presetHandler;
    const endpoint = url.pathname === "/unpack" ? "/rmeta" : url.pathname;
    if (!["/detect", "/tika", "/meta", "/rmeta", "/unpack"].includes(url.pathname)) {
      send(response, 404, "text/plain", "Not found");
      return;
    }
    if (method !== "PUT" && method !== "POST") {
      response.setHeader("Allow", "PUT, POST");
      send(response, 405, "text/plain", "Method not allowed");
      return;
    }
    let body = await readBody(request, maxBodyBytes);
    let multipartName: string | undefined;
    const disposition = request.headers["content-disposition"];
    const dispositionName =
      typeof disposition === "string"
        ? /filename="?([^";]+)"?/.exec(disposition)?.[1]
        : undefined;
    const contentType = request.headers["content-type"] ?? undefined;
    if (contentType !== undefined && contentType.startsWith("multipart/")) {
      const parsed = extractMultipart(body, contentType);
      if (parsed === null) {
        send(response, 400, "text/plain", "Invalid multipart request");
        return;
      }
      body = parsed.bytes;
      multipartName = parsed.filename;
    }
    const name = multipartName ?? url.searchParams.get("filename") ?? dispositionName;
    const signal = AbortSignal.timeout(requestTimeoutMs);
    const parseOptions =
      name === undefined ? { signal } : { filename: name, signal };

    if (endpoint === "/detect") {
      const type = await ripstream.detect(body, parseOptions);
      send(response, 200, "text/plain", `${type.toString()}\n`);
      return;
    }
    if (endpoint === "/rmeta" || url.pathname === "/unpack") {
      const records = await ripstream.parseRecursive(body, parseOptions);
      sendJson(response, 200, JSON.parse(serializeRmeta(records)));
      return;
    }
    const result = await ripstream.parse(body, {
      ...parseOptions,
      ...(Object.keys(limits).length === 0 ? {} : { limits }),
    });
    if (endpoint === "/meta" || handlerOverride === "meta") {
      sendJson(response, 200, metadataObject(result.metadata));
      return;
    }
    if ((request.headers.accept ?? "").includes("application/json") || handlerOverride === "json") {
      sendJson(response, 200, {
        text: result.text,
        metadata: metadataObject(result.metadata),
      });
    } else {
      send(response, 200, "text/plain; charset=utf-8", result.text);
    }
  }

  const server = createServer(handler);

  return {
    handler,
    server,
    listen(port = 0, host = "127.0.0.1"): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

/** Parses a client limit: absent -> undefined; otherwise a finite integer >= 0 or HTTP 400. */
function clientLimit(raw: string | null, key: string): number | undefined {
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new HttpError(400, `Invalid ${key}: expected a non-negative integer`);
  }
  return Number(raw);
}

function parseJsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(body));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function clampCount(requested: unknown, ceiling: number, fallback: number): number {
  if (requested === undefined) return Math.min(fallback, ceiling);
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
    throw new HttpError(400, "concurrency and maxQueue must be positive integers");
  }
  return Math.min(requested, ceiling);
}

/** Maps a client pipes request onto server-configured roots; never trusts client paths. */
async function buildPipesConfig(
  input: unknown,
  pipes: RipstreamServerPipesOptions,
): Promise<PipesConfig> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HttpError(400, "Pipes config must be a JSON object");
  }
  const client = input as Partial<PipesConfig>;
  const source = client.source;
  if (typeof source !== "object" || source === null) throw new HttpError(400, "Missing source");
  try {
    let resolvedSource: PipesConfig["source"];
    if (source.type === "http") {
      if (pipes.allowHttp !== true) throw new HttpError(403, "HTTP pipe sources are disabled");
      resolvedSource = { type: "http", urls: source.urls ?? [] };
    } else if (source.type === "filesystem") {
      if (source.path !== undefined && typeof source.path !== "string") {
        throw new HttpError(400, "source.path must be a string");
      }
      resolvedSource = {
        type: "filesystem",
        path: await resolveWithinRoot(pipes.sourceRoot, source.path ?? "."),
      };
    } else {
      throw new HttpError(400, "Unsupported source type");
    }
    let sink: PipesConfig["sink"];
    if (client.sink !== undefined) {
      if (pipes.sinkRoot === undefined) throw new HttpError(403, "Pipe sinks are disabled");
      if (typeof client.sink.path !== "string") throw new HttpError(400, "sink.path must be a string");
      sink = { type: "filesystem", path: await resolveWithinRoot(pipes.sinkRoot, client.sink.path) };
    }
    return {
      ...(client.mode === undefined ? {} : { mode: client.mode }),
      ...(client.ordered === undefined ? {} : { ordered: client.ordered === true }),
      concurrency: clampCount(client.concurrency, pipes.maxConcurrency ?? 4, 4),
      maxQueue: clampCount(client.maxQueue, pipes.maxQueue ?? 64, 64),
      source: resolvedSource,
      ...(sink === undefined ? {} : { sink }),
      followSymlinks: false,
    };
  } catch (error) {
    if (error instanceof PipesPathError) throw new HttpError(403, error.message);
    throw error;
  }
}

async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) {
      throw new RipstreamError("REQUEST_TOO_LARGE", `Request exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function extractMultipart(
  body: Uint8Array,
  contentType: string,
): { bytes: Uint8Array; filename?: string } | null {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (boundary === undefined) return null;
  const text = new TextDecoder("latin1").decode(body);
  const parts = text.split(`--${boundary}`);
  for (const part of parts) {
    if (part.startsWith("--")) continue;
    const separator = part.indexOf("\r\n\r\n");
    if (separator === -1) continue;
    const headers = part.slice(0, separator);
    const filename = /filename="([^"]+)"/i.exec(headers)?.[1];
    if (filename === undefined) continue;
    const content = part.slice(separator + 4);
    const end = content.endsWith("\r\n") ? content.length - 2 : content.length;
    return {
      filename,
      bytes: Uint8Array.from(Buffer.from(content.slice(0, end), "latin1")),
    };
  }
  return null;
}

function metadataObject(metadata: Metadata): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = {};
  for (const name of metadata.names()) result[name] = metadata.getAll(name);
  return result;
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, { "Content-Type": contentType });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, "application/json", `${JSON.stringify(body)}\n`);
}
