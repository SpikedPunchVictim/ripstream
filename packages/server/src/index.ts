import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  SERVER_ENDPOINTS,
  assertValidLimits,
  httpStatusForError,
  serializeRmeta,
  IsolationError,
  RipstreamError,
  type Metadata,
  type ServerEndpoint,
} from "@spikedpunch/ripstream-core";
import { FrancLanguageDetector } from "@spikedpunch/ripstream-language";
import {
  PipesClient,
  PipesPathError,
  resolveWithinRoot,
  validatePipesConfig,
  type PipesConfig,
} from "@spikedpunch/ripstream-pipes";
import { randomUUID } from "node:crypto";
import type { ParseOptions, Ripstream, Translator } from "@spikedpunch/ripstream-core";

/** What the server calls to detect and parse. A core Ripstream satisfies it, and so does an isolated one. */
export type ServerRipstream = Pick<Ripstream, "detect" | "parse" | "parseRecursive">;

/**
 * What the server shows and reads of the isolation behind its `ripstream`. Structural, so a `NodeIsolator`'s status
 * satisfies it without this package depending on any isolation implementation.
 */
export interface ServerIsolationStatus {
  /** The mode in force: "strict", "lenient" or "off". */
  readonly mode: string;
  /** Isolation was requested but could not be provided, so documents are parsed in this process. */
  readonly degraded: boolean;
  /** The memory gate; null when nothing is actually isolated (mode "off", or degraded). */
  readonly pool: { readonly poolMb: number; readonly maxQueue: number } | null;
  /** Pool MiB one default request reserves, per output kind; null when nothing is isolated. */
  readonly defaultReservationMb: { readonly text: number; readonly records: number } | null;
  /**
   * The output cap the isolation was built for. When present and below `maxLimits.maxOutputChars`, the server warns:
   * a request at the ceiling needs more memory than the pool was sized to reserve. A NodeIsolatorStatus carries it.
   */
  readonly limits?: { readonly maxOutputChars: number } | null;
}

export interface ServerIsolation {
  status(): ServerIsolationStatus;
}

export interface RipstreamServerOptions {
  /**
   * Parses every document. Required: the server has no default engine, so it cannot parse hostile documents in
   * its own process by accident. Pass an isolated engine (build one with `createStandardIsolation` from
   * `@spikedpunch/ripstream-bundle-standard/isolation` and give its handle as `isolation`), or an in-process
   * `createRipstream()` to accept that risk.
   */
  readonly ripstream?: ServerRipstream;
  /**
   * The isolation behind `ripstream`, when it has one. The server only reads it: for the startup warnings, the
   * default concurrency gate and `/status`. The caller owns its lifecycle; `close()` does not dispose it.
   */
  readonly isolation?: ServerIsolation;
  /** Receives the startup warnings and, with `requestLogLevel`, each request (default: `console.warn` for "warn", the rest is dropped). */
  readonly log?: (level: "debug" | "info" | "warn", message: string) => void;
  /**
   * The endpoints served, by Tika's names (`SERVER_ENDPOINTS`): exactly these, so naming one is not adding it to a
   * default. `/status/<job>` belongs to `async`. `/health`, `/translate` and `/pipes` are not governed by it. Default:
   * all of them. (`ripstream serve` defaults to Tika's set, which leaves out `status` and `async`.)
   */
  readonly endpoints?: readonly ServerEndpoint[];
  /** Passes each request's method and URI to `log` at this level. Default: requests are not logged. */
  readonly requestLogLevel?: "debug" | "info";
  /**
   * How long receiving a whole request may take, in milliseconds; a request still arriving after that is answered 408.
   * Negative: no deadline. Default: `requestTimeoutMs`.
   */
  readonly maxRequestReadMillis?: number;
  /**
   * Closes a connection after this many milliseconds with no bytes moving. A request whose body has arrived and whose
   * response has not started is waiting on its parse, and is never closed by it. Default: no idle timeout.
   */
  readonly idleTimeoutMillis?: number;
  /**
   * The limits of a request that names none (and of /async and /pipes, which cannot name any), under the `maxLimits`
   * ceilings. A request's own limit wins over a default, and a ceiling over both. Must not exceed its ceiling.
   */
  readonly defaultLimits?: { readonly maxOutputChars?: number; readonly maxEmbeddedResources?: number };
  readonly maxBodyBytes?: number;
  /**
   * Requests parsed at once. Default 100; with an active `isolation`, what its memory pool can run plus what the
   * pool will queue (`max(1, floor(poolMb / defaultReservationMb.text)) + pool.maxQueue`).
   */
  readonly maxConcurrent?: number;
  /**
   * Requests held waiting for a slot before the body is read. Default 100; 0 with an active `isolation`, whose
   * memory pool queues the excess itself.
   */
  readonly maxQueue?: number;
  readonly requestTimeoutMs?: number;
  readonly corsOrigin?: string | readonly string[];
  readonly authenticate?: (request: IncomingMessage) => boolean | Promise<boolean>;
  readonly translator?: Translator;
  /**
   * Server-side maxima for client-supplied `maxOutputChars` / `maxEmbeddedResources` query params.
   * `maxOutputChars` is required with an active `isolation`: its result cap and child memory derive from it.
   */
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
  /** With an active `isolation`, a preset's `limits` may only name `maxOutputChars` and `maxEmbeddedResources`. */
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
  readonly headers: Readonly<Record<string, string>>;
  constructor(status: number, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.name = "HttpError";
  }
}

/** Seconds a client should wait before retrying a request refused because the server is full. */
const RETRY_AFTER_FULL = "1";
/** Seconds a client should wait before retrying when isolation itself is unavailable. */
const RETRY_AFTER_UNAVAILABLE = "5";

/** The handlers `?handler=` and a preset's `handler` can name. */
const HANDLERS: readonly string[] = ["meta", "json"];

const LIMIT_PARAMS = ["maxOutputChars", "maxEmbeddedResources"] as const;
/**
 * The query parameters each route reads. Any other is refused: a parameter the server does not act on would be
 * dropped with a 200, and the client would believe it had set a limit, a handler or a preset.
 */
const QUERY_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "/detect": ["filename"],
  "/tika": ["filename", "preset", "handler", ...LIMIT_PARAMS],
  "/meta": ["filename", "preset", ...LIMIT_PARAMS],
  "/rmeta": ["filename", "preset", ...LIMIT_PARAMS],
  "/unpack": ["filename", "preset", ...LIMIT_PARAMS],
  "/async": ["filename"],
  "/language": [],
  "/translate": ["target"],
  "/pipes": [],
};

function rejectUnreadRequestInput(request: IncomingMessage, url: URL): void {
  for (const name of Object.keys(request.headers)) {
    // Tika's per-request knobs (OCR language, skip-embedded, PDF options...). None is implemented: ignoring one
    // would parse the document under settings the client did not ask for.
    if (name.startsWith("x-tika-")) throw new HttpError(400, `Header ${name} is not supported`);
  }
  const allowed = Object.hasOwn(QUERY_PARAMS, url.pathname) ? QUERY_PARAMS[url.pathname] : undefined;
  if (allowed === undefined) return;
  for (const name of new Set(url.searchParams.keys())) {
    if (!allowed.includes(name)) {
      throw new HttpError(400, `Unknown query parameter "${name}"; ${url.pathname} reads: ${allowed.join(", ") || "none"}`);
    }
    if (url.searchParams.getAll(name).length > 1) {
      throw new HttpError(400, `Query parameter "${name}" was given more than once`);
    }
  }
}

/** A preset the server could not apply is a construction error, not a surprise on the first request that names it. */
function requireValidPresets(presets: RipstreamServerOptions["presets"]): void {
  for (const [name, preset] of Object.entries(presets ?? {})) {
    if (preset.handler !== undefined && !HANDLERS.includes(preset.handler)) {
      throw new Error(
        `createRipstreamServer: preset "${name}" has handler ${JSON.stringify(preset.handler)}; handlers are: ${HANDLERS.join(", ")}`,
      );
    }
    try {
      assertValidLimits(preset.limits);
    } catch (error) {
      throw new Error(`createRipstreamServer: preset "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The one place an error becomes an HTTP answer. */
function errorResponse(error: unknown): {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly code: string;
  readonly message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HttpError) return { status: error.status, headers: error.headers, code: "ERROR", message };
  if (error instanceof RipstreamError) {
    const headers: Record<string, string> = {};
    if (error instanceof IsolationError) {
      if (error.reason === "queue_full") headers["Retry-After"] = RETRY_AFTER_FULL;
      else if (error.reason === "unavailable") headers["Retry-After"] = RETRY_AFTER_UNAVAILABLE;
    }
    return { status: httpStatusForError(error), headers, code: error.code, message };
  }
  return { status: 500, headers: {}, code: "ERROR", message };
}

export interface RipstreamServer {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void;
  readonly server: ReturnType<typeof createServer>;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * Minimal synchronous Tika endpoint family: /detect, /tika, /meta, /rmeta.
 *
 * Throws unless `options.ripstream` is given (see the option), and, with an active `isolation`, unless
 * `maxLimits.maxOutputChars` is set and every preset limit can cross the isolation boundary.
 */
export function createRipstreamServer(options: RipstreamServerOptions = {}): RipstreamServer {
  if (options.pipes !== undefined && options.authenticate === undefined) {
    throw new Error("createRipstreamServer: the `pipes` option requires `authenticate`");
  }
  requireValidGateOptions(options);
  requireValidServerOptions(options);
  requireValidPresets(options.presets);
  const ripstream: ServerRipstream = options.ripstream ?? refuseToStartWithoutRipstream();
  const log = options.log ?? defaultLog;
  const isolation = options.isolation;
  const startupStatus = isolation?.status();
  const isolating = startupStatus !== undefined && startupStatus.pool !== null;
  if (isolation !== undefined) requireIsolatedOptions(options, isolating);
  warnAboutIsolation(startupStatus, options.maxLimits?.maxOutputChars, log);
  const derivedGate = startupStatus === undefined ? undefined : deriveGate(startupStatus);
  // /async and /pipes take no limit parameters: they parse under the server's ceilings, like a request without any.
  const ceilinged = withCeilings(ripstream, options.maxLimits, options.defaultLimits);
  const enabled: ReadonlySet<string> = new Set(options.endpoints ?? SERVER_ENDPOINTS);
  const maxBodyBytes = options.maxBodyBytes ?? 100 * 1024 * 1024;
  const maxConcurrent = options.maxConcurrent ?? derivedGate?.maxConcurrent ?? 100;
  const maxQueue = options.maxQueue ?? derivedGate?.maxQueue ?? 100;
  log("info", `Concurrency gate: maxConcurrent ${maxConcurrent}, maxQueue ${maxQueue}`);
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const corsOrigin = options.corsOrigin;
  const languageDetector = new FrancLanguageDetector();
  let active = 0;
  const waiters: Array<() => void> = [];
  const maxJobs = options.maxJobs ?? 1000;
  const jobTtlMs = options.jobTtlMs ?? 10 * 60_000;
  const jobs = new Map<string, Job>();

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
      return Promise.reject(new HttpError(503, "Server queue is full", { "Retry-After": RETRY_AFTER_FULL }));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(start);
        if (index !== -1) waiters.splice(index, 1);
        reject(new HttpError(408, "Request timed out waiting for a worker"));
      }, requestTimeoutMs);
      const start = (): void => {
        clearTimeout(timer);
        resolve(release);
      };
      waiters.push(start);
    });
  };

  /** The request a connection is serving, for the idle timeout. */
  const inFlight = new WeakMap<object, { request: IncomingMessage; response: ServerResponse }>();

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      if (options.requestLogLevel !== undefined) log(options.requestLogLevel, `${request.method} ${request.url}`);
      inFlight.set(request.socket, { request, response });
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
      let authorized: boolean;
      try {
        authorized = options.authenticate === undefined || (await options.authenticate(request));
      } catch {
        authorized = false; // fail closed; never echo authenticator internals
      }
      if (!authorized) {
        send(response, 401, "text/plain", "Unauthorized");
        return;
      }
      const probePath = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && (probePath === "/health" || probePath === "/version" || probePath === "/status")) {
        // Liveness/version endpoints must not be gated by the concurrency semaphore.
        try {
          await route(request, response, () => () => undefined);
        } catch {
          if (!response.headersSent) send(response, 500, "text/plain", "Internal error");
        }
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
        const { status, headers, code, message } = errorResponse(error);
        if (!response.headersSent && !response.writableEnded) {
          for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
          const wantsJson = (request.headers.accept ?? "").includes("application/json");
          if (wantsJson) {
            sendJson(response, status, { error: message, code });
          } else {
            send(response, status, "text/plain", message);
          }
        }
      } finally {
        release?.();
      }
    })().catch(() => {
      // Last-resort guard: a throw escaped the handler — e.g. a response write racing
      // Node's requestTimeout 408 (headers already sent), or `new URL` on a malformed
      // request target. Never let it become a process-killing unhandled rejection.
      if (!response.headersSent && !response.writableEnded) {
        try {
          send(response, 500, "text/plain", "Internal error");
        } catch {
          /* response already committed; nothing more to do */
        }
      }
    });
  };

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    detachSlot: () => () => void,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    const served = endpointOf(url.pathname);
    if (served !== null && !enabled.has(served)) {
      send(response, 404, "text/plain", "Not found");
      return;
    }
    rejectUnreadRequestInput(request, url);
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
      const result = await new PipesClient(config, { ripstream: ceilinged }).run();
      sendJson(response, 200, result);
      return;
    }
    if (method === "GET" && url.pathname === "/health") {
      send(response, 200, "text/plain", "ok");
      return;
    }
    if (method === "GET" && url.pathname === "/status") {
      sendJson(response, 200, {
        status: "ok",
        active,
        queued: waiters.length,
        gate: { maxConcurrent, maxQueue },
        isolation: isolation === undefined ? { mode: "off", degraded: false } : isolation.status(),
      });
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
      void ceilinged
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
    if (presetName !== null && !Object.hasOwn(presets, presetName)) {
      throw new HttpError(400, `Unknown preset ${JSON.stringify(presetName)}`);
    }
    const preset = presetName === null ? undefined : presets[presetName];
    const presetHandler = preset?.handler;
    const limits: Record<string, number> = { ...(preset?.limits ?? {}) };
    for (const key of ["maxOutputChars", "maxEmbeddedResources"] as const) {
      const requested = clientLimit(url.searchParams.get(key), key);
      const ceiling = options.maxLimits?.[key];
      const value = requested ?? limits[key] ?? options.defaultLimits?.[key];
      if (ceiling !== undefined) limits[key] = Math.min(value ?? ceiling, ceiling);
      else if (value !== undefined) limits[key] = value;
    }
    const requestedHandler = url.searchParams.get("handler");
    if (requestedHandler !== null && !HANDLERS.includes(requestedHandler)) {
      throw new HttpError(400, `Unknown handler ${JSON.stringify(requestedHandler)}; handlers are: ${HANDLERS.join(", ")}`);
    }
    const handlerOverride = requestedHandler ?? presetHandler;
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
      const records = await ripstream.parseRecursive(body, {
        ...parseOptions,
        ...(Object.keys(limits).length === 0 ? {} : { limits }),
      });
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

  // Node checks the deadline on an interval, so a short deadline needs a short interval to be kept.
  const readMillis = options.maxRequestReadMillis ?? requestTimeoutMs;
  const checkingInterval =
    options.maxRequestReadMillis !== undefined && readMillis > 0 ? Math.min(30_000, Math.max(50, Math.floor(readMillis / 2))) : 30_000;
  const server = createServer(
    { requestTimeout: readMillis < 0 ? 0 : readMillis, connectionsCheckingInterval: checkingInterval },
    handler,
  );
  const idleMillis = options.idleTimeoutMillis;
  if (idleMillis !== undefined) {
    server.setTimeout(idleMillis);
    server.on("timeout", (socket) => {
      const current = inFlight.get(socket);
      // Body in, response not begun: the server is parsing and the client is rightly silent. Look again later.
      if (current !== undefined && current.request.complete && !current.response.headersSent && !current.response.writableEnded) {
        socket.setTimeout(idleMillis);
        return;
      }
      socket.destroy();
    });
  }

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

/** The engine with the server's ceilings as the limits of any parse that does not name its own (or names more). */
function withCeilings(
  engine: ServerRipstream,
  ceilings: RipstreamServerOptions["maxLimits"],
  defaults: RipstreamServerOptions["defaultLimits"],
): ServerRipstream {
  const entries = Object.entries(ceilings ?? {}).filter(([, value]) => value !== undefined);
  const fallbacks = Object.entries(defaults ?? {}).filter(([, value]) => value !== undefined);
  if (entries.length === 0 && fallbacks.length === 0) return engine;
  const bound = (parseOptions?: ParseOptions): ParseOptions => {
    const limits: Record<string, number> = { ...parseOptions?.limits };
    for (const [key, value] of fallbacks) limits[key] ??= value as number;
    for (const [key, ceiling] of entries) limits[key] = Math.min(limits[key] ?? ceiling, ceiling);
    return { ...parseOptions, limits };
  };
  return {
    detect: (source, detectOptions) => engine.detect(source, detectOptions),
    parse: (source, parseOptions) => engine.parse(source, bound(parseOptions)),
    parseRecursive: (source, parseOptions) => engine.parseRecursive(source, bound(parseOptions)),
  };
}

/** Fail closed: the server never builds an in-process engine of its own. */
function refuseToStartWithoutRipstream(): never {
  throw new Error(
    "createRipstreamServer: no `ripstream` was given, and the server does not build one itself: it would parse " +
      "hostile documents in the server process. Either build an isolated engine (createStandardIsolation from " +
      "@spikedpunch/ripstream-bundle-standard/isolation, see the parse-isolation docs) and pass it as `ripstream` " +
      "with its handle as `isolation`, or pass an in-process createRipstream() as `ripstream` to accept the risk.",
  );
}

function defaultLog(level: "debug" | "info" | "warn", message: string): void {
  if (level === "warn") console.warn(`[ripstream-server] ${message}`);
}

/** The only limits an isolated request can carry; see createIsolatedRipstream in core. */
const CROSSING_LIMITS: ReadonlySet<string> = new Set(["maxOutputChars", "maxEmbeddedResources"]);

/** A server-side count: an integer, and at least `min`. Throws naming the option. */
function requireCount(name: string, value: number | undefined, min: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`createRipstreamServer: \`${name}\` must be an integer of at least ${min}, got ${String(value)}`);
  }
}

/** The endpoint a path belongs to, or null for a path no `endpoints` setting governs. */
function endpointOf(pathname: string): ServerEndpoint | null {
  if (pathname.startsWith("/status/")) return "async";
  const name = pathname.slice(1);
  return (SERVER_ENDPOINTS as readonly string[]).includes(name) ? (name as ServerEndpoint) : null;
}

/** The options `ripstream serve` fills from its `server` section. Throws naming the option. */
function requireValidServerOptions(options: RipstreamServerOptions): void {
  for (const name of options.endpoints ?? []) {
    if (!(SERVER_ENDPOINTS as readonly string[]).includes(name)) {
      throw new Error(`createRipstreamServer: unknown endpoint ${JSON.stringify(name)}; the endpoints are ${SERVER_ENDPOINTS.join(", ")}`);
    }
  }
  const read = options.maxRequestReadMillis;
  if (read !== undefined && (!Number.isInteger(read) || read === 0 || Math.abs(read) > 2_147_483_647)) {
    throw new RangeError("createRipstreamServer: maxRequestReadMillis must be a non-zero integer up to 2147483647 (negative: no deadline)");
  }
  const idle = options.idleTimeoutMillis;
  if (idle !== undefined && (!Number.isInteger(idle) || idle < 1 || idle > 2_147_483_647)) {
    throw new RangeError("createRipstreamServer: idleTimeoutMillis must be an integer from 1 to 2147483647");
  }
  for (const key of ["maxOutputChars", "maxEmbeddedResources"] as const) {
    const fallback = options.defaultLimits?.[key];
    const ceiling = options.maxLimits?.[key];
    // -1 is "no limit", which no ceiling holds.
    if (fallback !== undefined && ceiling !== undefined && (fallback < 0 || fallback > ceiling)) {
      throw new RangeError(`createRipstreamServer: defaultLimits.${key} (${fallback < 0 ? "unlimited" : fallback}) is above maxLimits.${key} (${ceiling})`);
    }
  }
}

function requireValidGateOptions(options: RipstreamServerOptions): void {
  requireCount("maxConcurrent", options.maxConcurrent, 1);
  requireCount("maxQueue", options.maxQueue, 0);
}

/**
 * What a server with an isolation handle must be given. The preset rules hold for any handle, even one that isolates
 * nothing today; the output ceiling is only needed when something is actually isolated. Throws, naming the option.
 */
function requireIsolatedOptions(options: RipstreamServerOptions, isolating: boolean): void {
  if (isolating && options.maxLimits?.maxOutputChars === undefined) {
    throw new Error(
      "createRipstreamServer: `maxLimits.maxOutputChars` is required with an active `isolation`: the child's result " +
        "cap and memory are derived from it, so every request needs a finite output ceiling",
    );
  }
  for (const [presetName, preset] of Object.entries(options.presets ?? {})) {
    for (const [key, value] of Object.entries(preset.limits ?? {})) {
      if (!CROSSING_LIMITS.has(key)) {
        throw new Error(
          `createRipstreamServer: preset "${presetName}" sets limit "${key}", which cannot cross the isolation ` +
            "boundary; with an `isolation` a preset may only set maxOutputChars and maxEmbeddedResources",
        );
      }
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          `createRipstreamServer: preset "${presetName}" sets ${key} to ${String(value)}; ` +
            "with an `isolation` it must be a non-negative integer",
        );
      }
    }
  }
}

/** One warning per condition, at construction. */
function warnAboutIsolation(
  status: ServerIsolationStatus | undefined,
  ceiling: number | undefined,
  log: (level: "info" | "warn", message: string) => void,
): void {
  if (status === undefined) {
    log(
      "warn",
      "Parse isolation is off for this server: hostile documents are parsed in the server process. " +
        "Pass an isolated `ripstream` and its `isolation` handle to contain them.",
    );
    return;
  }
  if (status.mode !== "strict") {
    log(
      "warn",
      `Parse isolation mode is "${status.mode}", not "strict": ` +
        (status.mode === "lenient"
          ? "if isolation cannot be provided, documents are parsed in the server process."
          : "documents are parsed in the server process."),
    );
  }
  const built = status.limits?.maxOutputChars;
  if (ceiling !== undefined && built !== undefined && ceiling > built) {
    log(
      "warn",
      `maxLimits.maxOutputChars is ${ceiling}, above the ${built} this isolation was built to cap: a request at the ` +
        "ceiling needs more memory than the pool reserves for it. Build the isolation with " +
        "`defaultMaxOutputChars` set to the ceiling.",
    );
  }
  if (status.degraded) {
    // degradedReason is not part of the structural type; a NodeIsolatorStatus carries it.
    const reason: unknown = (status as { readonly degradedReason?: unknown }).degradedReason;
    log(
      "warn",
      "Parse isolation is degraded: documents are parsed in the server process" +
        (typeof reason === "string" ? ` (${reason}).` : "."),
    );
  }
}

/**
 * The gate for an active isolation: the requests its memory pool can run at once plus the ones it will queue, with
 * no queue of our own. It is sized by the dearer of the text and records reservations, so a run of /rmeta requests
 * does not read more bodies than the pool can place. Requests beyond the gate are refused with 503 before their body
 * is read. It does not bound memory exactly: /pipes spends one slot on a run that parses several documents at once.
 * Undefined when nothing is isolated or the status cannot size it, which leaves the caller's options and the old
 * defaults in charge.
 */
function deriveGate(status: ServerIsolationStatus): { maxConcurrent: number; maxQueue: number } | undefined {
  const { pool, defaultReservationMb } = status;
  if (pool === null || defaultReservationMb === null) return undefined;
  const reservation = Math.max(defaultReservationMb.text, defaultReservationMb.records);
  if (!Number.isFinite(reservation) || reservation <= 0 || !Number.isFinite(pool.poolMb)) return undefined;
  // A status from an older or third-party isolation may not report the pool's queue: an unknown one counts as none.
  const poolQueue = Number.isSafeInteger(pool.maxQueue) && pool.maxQueue > 0 ? pool.maxQueue : 0;
  return { maxConcurrent: Math.max(1, Math.floor(pool.poolMb / reservation)) + poolQueue, maxQueue: 0 };
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
  const issues = validatePipesConfig(input);
  if (issues.length > 0) throw new HttpError(400, issues.join("; "));
  const client = input as Partial<PipesConfig>;
  // The server always walks without following symlinks; a client asking for them would be answered with the opposite.
  if (client.followSymlinks === true) throw new HttpError(400, "followSymlinks cannot be set by a client");
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
  // Buffer's "latin1" is ISO-8859-1 and round-trips all 256 byte values; TextDecoder("latin1") is windows-1252.
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("latin1");
  // The first piece is the preamble and a piece starting "--" is the closing delimiter.
  const parts = text.split(`--${boundary}`).slice(1);
  let file: { bytes: Uint8Array; filename: string } | null = null;
  for (const part of parts) {
    if (part.startsWith("--")) continue;
    const separator = part.indexOf("\r\n\r\n");
    if (separator === -1) continue;
    const headers = part.slice(0, separator);
    const filename = /filename="([^"]+)"/i.exec(headers)?.[1];
    if (filename === undefined) {
      // Tika reads a per-request parse context from a part like this; ignoring it would parse under other settings.
      const name = /[;\s]name="([^"]*)"/i.exec(headers)?.[1] ?? "";
      throw new HttpError(400, `multipart part ${JSON.stringify(name)} is not supported: send the document as the only part`);
    }
    if (file !== null) throw new HttpError(400, "multipart request has more than one file part: only one file part is supported");
    const content = part.slice(separator + 4);
    const end = content.endsWith("\r\n") ? content.length - 2 : content.length;
    file = { filename, bytes: Uint8Array.from(Buffer.from(content.slice(0, end), "latin1")) };
  }
  return file;
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
