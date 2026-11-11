import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzip } from "node:zlib";
import {
  Metadata,
  SERVER_ENDPOINTS,
  TIKA_KEYS,
  assertValidLimits,
  emitMetadataFilter,
  filterDocument,
  filterRmetaObjects,
  handlerTypeName,
  httpStatusForError,
  metadataJson,
  parseHandlerType,
  serializeRmeta,
  IsolationError,
  RipstreamError,
  type EmitMetadataFilters,
  type MetadataFilterServices,
  type HandlerType,
  type RmetaValue,
  type ServerEndpoint,
} from "@spikedpunch/ripstream-core";
import { CharSoupLanguageDetector, toIso6391 } from "@spikedpunch/ripstream-language";
import {
  PipesClient,
  PipesPathError,
  buildUnpackPackage,
  isFailure,
  resolveWithinRoot,
  validatePipesConfig,
  zipChunks,
  type PipesConfig,
  type PipesResult,
  type UnpackPackage,
} from "@spikedpunch/ripstream-pipes";
import { randomUUID } from "node:crypto";
import type { ParseOptions, PipesSettings, Ripstream, Translator } from "@spikedpunch/ripstream-core";
import {
  MIME_DETAIL_OFFERS,
  MIME_LIST_OFFERS,
  escapeHtml,
  findMimeType,
  mimeTypeDetailHtml,
  mimeTypeDetailJson,
  mimeTypesHtml,
  mimeTypesJson,
  mimeTypesText,
  sortMimeTypes,
  type ServerMimeType,
} from "./mime-types.ts";
import { HttpError } from "./http-error.ts";
import { readBody, readBodyPrefix } from "./request-body.ts";
import { TikaPipes, type TikaPipesAnswer } from "./tika-pipes.ts";
import { extensionFor } from "./unpack.ts";

export type { ServerMimeType } from "./mime-types.ts";
export { extensionFor } from "./unpack.ts";

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
  readonly limits?: { readonly maxOutputChars: number; readonly unpackCeiling?: number } | null;
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
  /**
   * What /tika, /meta, /rmeta and /unpack do when the text reaches `maxOutputChars`. "truncate" (default): as Tika's
   * server does with its write limit, answer 200 with the text up to it and flag the metadata
   * (`tk:exception:write-limit-reached`). "throw": fail the request with a 422, as Tika does with `throwOnWriteLimit`.
   * /async and /pipes always fail.
   */
  readonly onOutputLimit?: "truncate" | "throw";
  readonly maxBodyBytes?: number;
  /**
   * The most bytes of embedded documents one `/unpack` answer carries, summed over the whole document. A document that
   * would take the total past it is left out of the package (its record in `rmeta.json` is still there); Tika does the
   * same with its `maxUnpackBytes`, which is 10 GiB. Default 100 MiB, and with an active `isolation` no more than it
   * allows (`limits.unpackCeiling` of its status: 256 MiB, or a quarter of a child's memory if that is less); naming
   * more than that is refused when the server is built. At most 2 GiB.
   */
  readonly maxUnpackBytes?: number;
  /**
   * Requests parsed at once. Default 100; with an active `isolation`, what its memory pool can run plus what the
   * pool will queue (`max(1, floor(poolMb / defaultReservationMb.text)) + pool.maxQueue`).
   */
  readonly maxConcurrent?: number;
  /**
   * Requests held waiting for a slot, their body unread, until `requestTimeoutMs` (then 408). Default 100, with or
   * without `isolation`: a burst is queued, as Tika's server does, and only what the queue cannot hold is refused
   * with 503. 0 refuses at once whatever the slots cannot run.
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
  /**
   * Tika's `metadata-filters` (`metadataFiltersOf(loadConfig(...).config)`), run on what the endpoints answer, as Tika's
   * emit runs them: /rmeta, /unpack's `rmeta.json`, /meta (and `/meta/{field}`), /tika/json and the `handler=meta|json`
   * answers use the configured chain; the text endpoints run the parse-context chain alone. A request names no filter of
   * its own. Default: none, nothing is filtered. /pipes and /async take the filters of `pipes.settings`.
   */
  readonly metadataFilters?: EmitMetadataFilters;
  /**
   * What the metadata filters of `pipes.settings` need that core has not: the language identifier of
   * `charsoup-metadata-filter`. Default: Tika's CharSoup detector, from `@spikedpunch/ripstream-language`. A server whose
   * settings name a filter that the services cannot serve does not start.
   */
  readonly metadataFilterServices?: MetadataFilterServices;
  /**
   * The media types `/mime-types` describes. The server has no registry of its own, so it answers 404 until it is
   * given one (`ripstream serve` passes the standard bundle's).
   */
  readonly mimeTypes?: readonly ServerMimeType[];
  /** With an active `isolation`, a preset's `limits` may only name `maxOutputChars` and `maxEmbeddedResources`. */
  readonly presets?: Readonly<Record<string, { readonly handler?: string; readonly limits?: Record<string, number> }>>;
}

export interface RipstreamServerPipesOptions {
  /**
   * Directory that client `source.path` values are resolved against. Without it the batch job body of /pipes
   * (`{source, sink, ...}`) is refused, and only Tika's tuples (`settings`) are taken.
   */
  readonly sourceRoot?: string;
  /**
   * Tika's pipes sections (`loadConfig(...).pipes`). With them, POST /pipes takes one Tika FetchEmitTuple and answers
   * `{status, message?}` with Tika's HTTP status (200, 400, 413, 429, 500, 503 and a Retry-After), and POST /async takes
   * `{"tuples": [...]}` for a background run that keeps going between requests. Tuples name the settings' fetchers and
   * emitters; they cannot name paths, `parseContext` or the components the server keeps for itself (`__` ids).
   * `/pipes` does not run the settings' reporters (its answer is the report); `/async` does. Both parse under the
   * server's ceilings and isolation. `close()` waits for the tuples `/async` already took. A body that has no `source`
   * is a tuple; one that has is the batch job, so the two shapes do not clash.
   */
  readonly settings?: PipesSettings;
  /**
   * How long an /async request waits for room in the queue before it is answered 429. Default 5 000. Tika's is 60 000,
   * which is as long as this server's own request timeout, so a queue that stays full would hold every request to it.
   */
  readonly asyncMaxWaitMs?: number;
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

/** Seconds a client should wait before retrying a request refused because the server is full. */
/** The characters of a body `/language` looks at: Tika's `MAX_DETECT_CHARS`. */
const LANGUAGE_SAMPLE_CHARS = 100_000;
const RETRY_AFTER_FULL = "1";
/** Seconds a client should wait before retrying when isolation itself is unavailable. */
const RETRY_AFTER_UNAVAILABLE = "5";

/**
 * The handlers `?handler=` and a preset's `handler` can name: the two answers that are not a content format (`meta`, the
 * metadata alone; `json`, the text and the metadata), and the content formats, by Tika's spellings.
 */
const HANDLERS: readonly string[] = ["meta", "json", "text", "txt", "html", "xml", "body", "markdown", "md", "ignore"];

/** The most failed inputs `/pipes` lists in its answer; the rest are counted in `failuresOmitted`. */
const MAX_PIPES_FAILURES_LISTED = 1000;

/** What `maxUnpackBytes` is when nothing says otherwise. */
const DEFAULT_MAX_UNPACK_BYTES = 100 * 1024 * 1024;
/** The most `maxUnpackBytes` may name: the whole package has to fit one zip (4 GiB), with its compressed forms and manifests. */
const MAX_UNPACK_BYTES_OPTION = 2 * 1024 * 1024 * 1024;

/**
 * The bytes of embedded documents a request may collect: the option, else the default held under what the isolation
 * allows. An option above what the isolation allows would fail every unpack, so it is refused here. Throws, naming it.
 */
function resolveUnpackBytes(requested: number | undefined, isolationCeiling: number | undefined): number {
  if (requested !== undefined) {
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > MAX_UNPACK_BYTES_OPTION) {
      throw new RangeError(`createRipstreamServer: maxUnpackBytes must be an integer from 0 to ${MAX_UNPACK_BYTES_OPTION}, got ${String(requested)}`);
    }
    if (isolationCeiling !== undefined && requested > isolationCeiling) {
      throw new RangeError(
        `createRipstreamServer: maxUnpackBytes ${requested} is more than the isolation allows (${isolationCeiling}: the smaller ` +
          "of 256 MiB and a quarter of a child's memory). Lower it, or give the isolation children more memory (perChildMb)",
      );
    }
    return requested;
  }
  return isolationCeiling === undefined ? DEFAULT_MAX_UNPACK_BYTES : Math.min(DEFAULT_MAX_UNPACK_BYTES, isolationCeiling);
}

/** What GET / and GET /tika say; this server is not Tika, so it does not claim to be. */
const GREETING = "This is Ripstream Server (ripstream 0.0.0). Please PUT\n";

/** The routes each endpoint serves, for the welcome page. */
const ENDPOINT_ROUTES: Readonly<Record<ServerEndpoint, readonly string[]>> = {
  tika: ["PUT /tika", "PUT /tika/{text,html,xml,md}", "PUT /tika/json[/{handler}]"],
  rmeta: ["PUT /rmeta[/{handler}]", "POST /rmeta/form[/{handler}]"],
  meta: ["PUT /meta", "PUT /meta/{field}", "POST /meta/form"],
  unpack: ["PUT /unpack", "PUT /unpack/all[/{handler}]", "POST /unpack[/all[/{handler}]] (multipart)"],
  detect: ["PUT /detect"],
  language: ["PUT /language"],
  "mime-types": ["GET /mime-types", "GET /mime-types/{type}/{subtype}"],
  version: ["GET /version"],
  status: ["GET /status"],
  async: ["POST /async", "GET /status/{id}"],
};

function servedRoutes(enabled: ReadonlySet<string>): string[] {
  return SERVER_ENDPOINTS.filter((endpoint) => enabled.has(endpoint)).flatMap((endpoint) => ENDPOINT_ROUTES[endpoint]);
}

function welcomeText(enabled: ReadonlySet<string>): string {
  return `Ripstream 0.0.0\n\n${servedRoutes(enabled).join("\n")}\n`;
}

function welcomeHtml(enabled: ReadonlySet<string>): string {
  const items = servedRoutes(enabled).map((route) => `<li><code>${escapeHtml(route)}</code></li>`).join("\n");
  return `<!DOCTYPE html>\n<html><head><title>Ripstream</title></head><body>\n<h1>Ripstream 0.0.0</h1>\n<ul>\n${items}\n</ul>\n</body></html>\n`;
}

/** What `/tika/{format}` answers with, and the handler type it fixes. `/tika/text` is Tika's body-only text. */
const TIKA_FORMATS: Readonly<Record<string, HandlerType>> = { text: "body", html: "html", xml: "xml", md: "markdown" };

/** The Content-Type of a content format's answer. */
function contentTypeOf(type: HandlerType): string {
  return type === "html" ? "text/html; charset=utf-8" : type === "xml" ? "text/xml; charset=utf-8" : "text/plain; charset=utf-8";
}

/**
 * The request target as Tika's server reads it: a trailing slash is ignored; a path that starts with `//` is a 400 and
 * one with a `.` or `..` segment a 404, where `new URL` alone would take `//tika/text` for a host and fold the dots.
 */
function parseTarget(rawUrl: string | undefined): URL {
  const raw = rawUrl ?? "/";
  if (raw.startsWith("//")) throw new HttpError(400, "Bad Request");
  if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(raw.split("?")[0] ?? "")) throw new HttpError(404, "Not found");
  let url: URL;
  try {
    url = new URL(raw, "http://localhost");
  } catch {
    throw new HttpError(400, "Bad Request");
  }
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

/** What a request path asks for. */
interface Target {
  readonly endpoint: "/detect" | "/tika" | "/meta" | "/rmeta" | "/unpack";
  /** The handler the path names, as written: `/rmeta/{handler}`, `/tika/json/{handler}`, `/rmeta/form/{handler}`. */
  readonly handler: string | null;
  /** `/tika/json[/{handler}]`: the metadata and the content as one JSON object. */
  readonly json: boolean;
  /** `/tika/{text,html,xml,md}`: the handler type the route fixes. */
  readonly fixedType: HandlerType | null;
  /** `/meta/{field}`: the one metadata field answered. */
  readonly field: string | null;
  /** `/meta/form`, `/rmeta/form`: the document arrives as a multipart form. */
  readonly form: boolean;
  /** `/unpack/all`: the document itself is in the package too, as `unpacked/0`. */
  readonly all: boolean;
}

/**
 * The route of a path, as Tika lays them out; null for a path that is none. A trailing slash is ignored, as Tika's
 * JAX-RS router does. `form` is a literal, so it wins over `{handler}` and `{field}`.
 */
function resolveTarget(pathname: string): Target | null {
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  let segments: string[];
  try {
    segments = trimmed.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return null; // a malformed escape names no route
  }
  const [root, first, second, ...rest] = segments;
  if (rest.length > 0 || root === undefined) return null;
  const target = (endpoint: Target["endpoint"], extra: Partial<Target> = {}): Target => ({
    endpoint,
    handler: null,
    json: false,
    fixedType: null,
    field: null,
    form: false,
    all: false,
    ...extra,
  });
  switch (root) {
    case "detect":
      return first === undefined ? target("/detect") : null;
    case "unpack":
      if (first === undefined) return target("/unpack");
      // `all` is a literal, and there is no `/unpack/{handler}`: the handler comes after it.
      return first === "all" ? target("/unpack", { all: true, handler: second ?? null }) : null;
    case "tika":
      if (first === undefined) return target("/tika");
      if (first === "json") return target("/tika", { json: true, handler: second ?? null });
      if (second === undefined && Object.hasOwn(TIKA_FORMATS, first)) return target("/tika", { fixedType: TIKA_FORMATS[first]! });
      return null;
    case "rmeta":
      if (first === undefined) return target("/rmeta");
      if (first === "form") return target("/rmeta", { form: true, handler: second ?? null });
      return second === undefined ? target("/rmeta", { handler: first }) : null;
    case "meta":
      if (first === undefined) return target("/meta");
      if (second !== undefined) return null;
      return first === "form" ? target("/meta", { form: true }) : target("/meta", { field: first });
    default:
      return null;
  }
}

/**
 * The offer the Accept header prefers (highest q first, the more specific range first), or null when it accepts none.
 * No header, or an empty one, takes the first offer, which is the route's default.
 */
function negotiate(accept: string | undefined, offers: readonly string[]): string | null {
  if (accept === undefined || accept.trim() === "") return offers[0] ?? null;
  const ranges = accept
    .split(",")
    .map((part, order) => {
      const [range = "", ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
      const q = params.map((param) => /^q=([0-9.]+)$/.exec(param)?.[1]).find((value) => value !== undefined);
      const weight = q === undefined || Number.isNaN(Number(q)) ? 1 : Number(q);
      const specificity = range === "*/*" ? 0 : range.endsWith("/*") ? 1 : 2;
      return { range, weight, specificity, order };
    })
    .filter((entry) => entry.range !== "")
    .sort((a, b) => b.weight - a.weight || b.specificity - a.specificity || a.order - b.order);
  for (const entry of ranges) {
    if (entry.weight <= 0) continue;
    const match = offers.find((offer) =>
      entry.range === "*/*" || entry.range === offer || (entry.range.endsWith("/*") && offer.startsWith(entry.range.slice(0, -1))),
    );
    if (match !== undefined) return match;
  }
  return null;
}

/** Metadata as Tika's CSV writer does (`CSVFormat.EXCEL`): a row per key, the key then its values, CRLF-ended. */
function metadataCsv(metadata: Metadata): string {
  const field = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return metadata
    .names()
    .map((name) => `${[name, ...metadata.getAll(name)].map(field).join(",")}\r\n`)
    .join("");
}

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
  "/mime-types": [],
  "/translate": ["target"],
  "/pipes": [],
};

function rejectUnreadRequestInput(request: IncomingMessage, url: URL): void {
  for (const name of Object.keys(request.headers)) {
    // Tika's per-request knobs (OCR language, skip-embedded, PDF options...). None is implemented: ignoring one
    // would parse the document under settings the client did not ask for.
    if (name.startsWith("x-tika-")) throw new HttpError(400, `Header ${name} is not supported`);
  }
  // /tika/json and /rmeta/text read what /tika and /rmeta do: the parameters are the endpoint's, not the path's.
  const root = `/${url.pathname.split("/")[1] ?? ""}`;
  const allowed = Object.hasOwn(QUERY_PARAMS, root) ? QUERY_PARAMS[root] : undefined;
  if (allowed === undefined) return;
  for (const name of new Set(url.searchParams.keys())) {
    if (!allowed.includes(name)) {
      throw new HttpError(400, `Unknown query parameter "${name}"; ${root} reads: ${allowed.join(", ") || "none"}`);
    }
    if (url.searchParams.getAll(name).length > 1) {
      throw new HttpError(400, `Query parameter "${name}" was given more than once`);
    }
  }
}

/** A preset the server could not apply is a construction error, not a surprise on the first request that names it. */
function requireValidPresets(presets: RipstreamServerOptions["presets"]): void {
  for (const [name, preset] of Object.entries(presets ?? {})) {
    if (preset.handler !== undefined && !HANDLERS.includes(preset.handler.toLowerCase())) {
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
  if (options.pipes !== undefined && options.pipes.sourceRoot === undefined && options.pipes.settings === undefined) {
    throw new Error("createRipstreamServer: `pipes` needs `sourceRoot` (the batch job) or `settings` (Tika's tuples), or it takes nothing");
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
  // Tika's detector: /language answers from it, and so does the language filter of the settings unless it is given another.
  const languageDetector = new CharSoupLanguageDetector();
  const tikaPipes =
    options.pipes?.settings === undefined
      ? undefined
      : new TikaPipes({
          settings: options.pipes.settings,
          ripstream: ceilinged,
          // Pipes' UNPACK with `suffixStrategy: DETECTED` names files as /unpack does: by the server's media type registry.
          extensionOf: (contentType) => extensionFor(contentType, options.mimeTypes),
          metadataFilterServices: options.metadataFilterServices ?? { languageIdentifier: languageDetector },
          ...(options.pipes.asyncMaxWaitMs === undefined ? {} : { asyncMaxWaitMs: options.pipes.asyncMaxWaitMs }),
        });
  // Tika's emit: the configured chain, but the text endpoints (CONTENT_ONLY) answer for the parse-context chain alone: their
  // own default keeps the content, which is all they write.
  const metadataFilter = emitMetadataFilter(options.metadataFilters, false) ?? undefined;
  const textFilter =
    options.metadataFilters?.parseContext == null
      ? undefined
      : (emitMetadataFilter({ parseContext: options.metadataFilters.parseContext }, true) ?? undefined);
  const rmetaOptions = metadataFilter === undefined ? {} : { metadataFilter };
  // One document of an answer, with the filter run over it as the list's only member: gone from the list, it is `{}`.
  const filterObject = (object: Record<string, RmetaValue>): Record<string, RmetaValue> =>
    metadataFilter === undefined ? object : (filterRmetaObjects([object], metadataFilter)[0] ?? {});
  const enabled: ReadonlySet<string> = new Set(options.endpoints ?? SERVER_ENDPOINTS);
  const sortedMimeTypes = sortMimeTypes(options.mimeTypes ?? []);
  const maxBodyBytes = options.maxBodyBytes ?? 100 * 1024 * 1024;
  const maxUnpackBytes = resolveUnpackBytes(options.maxUnpackBytes, isolating ? startupStatus?.limits?.unpackCeiling : undefined);
  const maxConcurrent = options.maxConcurrent ?? derivedGate?.maxConcurrent ?? 100;
  const maxQueue = options.maxQueue ?? 100;
  log("info", `Concurrency gate: maxConcurrent ${maxConcurrent}, maxQueue ${maxQueue}`);
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const corsOrigin = options.corsOrigin;
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
        // Tika's answer, for every path: 200 and the one list of methods its server is built on.
        response.writeHead(200, { Allow: "POST, GET, PUT, OPTIONS, HEAD", "Content-Length": "0" });
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
      let probePath = "";
      try {
        probePath = parseTarget(request.url).pathname;
      } catch {
        /* route() answers a target that is not one */
      }
      if ((request.method === "GET" || request.method === "HEAD") && (probePath === "/health" || probePath === "/version" || probePath === "/status")) {
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
          // A body refused unread leaves the rest of it on the wire, so the connection cannot carry another request.
          if (status === 413 && !request.complete) response.setHeader("Connection", "close");
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
    const url = parseTarget(request.url);
    // A HEAD is the GET's headers: Node leaves the body off by itself.
    const method = request.method === "HEAD" ? "GET" : (request.method ?? "GET");
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
      const parsedBody = parseJsonBody(await readBody(request, maxBodyBytes));
      // A body with a `source` is the batch job; any other is a Tika tuple, so its own mistakes get the tuple's messages.
      if (tikaPipes !== undefined && !(isRecord(parsedBody) && "source" in parsedBody)) {
        sendTika(response, await tikaPipes.pipes(parsedBody));
        return;
      }
      if (options.pipes.sourceRoot === undefined) {
        throw new HttpError(400, "This server takes Tika tuples only: the batch job (a body with `source`) needs the pipes.sourceRoot option");
      }
      if (isRecord(parsedBody) && "fetcher" in parsedBody) {
        throw new HttpError(400, "This server takes batch jobs only: Tika tuples need the pipes.settings option");
      }
      const config = await buildPipesConfig(parsedBody, { ...options.pipes, sourceRoot: options.pipes.sourceRoot });
      // The run goes on after an input that fails: what each came to is in `stats.byStatus`, and the ones that failed
      // (a category other than SUCCESS) are listed, up to a cap so a run of a million bad files is not a million rows.
      const failures: PipesResult[] = [];
      let omitted = 0;
      const reporter = {
        report: (outcome: PipesResult): void => {
          if (!isFailure(outcome)) return;
          if (failures.length < MAX_PIPES_FAILURES_LISTED) failures.push(outcome);
          else omitted++;
        },
      };
      const result = await new PipesClient(config, { ripstream: ceilinged, reporter }).run();
      sendJson(response, 200, { ...result, failures, ...(omitted === 0 ? {} : { failuresOmitted: omitted }) });
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
      // With Tika's settings, a JSON object that has `tuples` is Tika's request; any other body is a document to parse.
      if (tikaPipes !== undefined && (request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        const parsedBody = tryParseJson(body);
        if (isRecord(parsedBody) && "tuples" in parsedBody) {
          sendTika(response, await tikaPipes.enqueue(parsedBody));
          return;
        }
      }
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
      sendJson(response, 202, { id });
      return;
    }
    if (method === "GET" && url.pathname === "/version") {
      if (negotiate(request.headers.accept, ["text/plain"]) === null) notAcceptable(response);
      else send(response, 200, "text/plain", "ripstream 0.0.0\n");
      return;
    }
    if (url.pathname === "/language") {
      if (method !== "PUT" && method !== "POST") {
        response.setHeader("Allow", "PUT, POST");
        send(response, 405, "text/plain", "Method not allowed");
        return;
      }
      // Tika: text/plain, the two-letter code. application/json is ripstream's, the detector's whole answer.
      const kind = negotiate(request.headers.accept, ["text/plain", "application/json"]);
      if (kind === null) {
        notAcceptable(response);
        return;
      }
      // Tika reads the first 100,000 characters and ignores the rest: detection saturates well before that, so only
      // the bytes that can hold them are kept (the rest of the body still counts against the cap).
      const body = await readBodyPrefix(request, maxBodyBytes, LANGUAGE_SAMPLE_CHARS * 4);
      const sample = new TextDecoder("utf-8", { fatal: false }).decode(body.subarray(0, LANGUAGE_SAMPLE_CHARS * 4));
      const result = languageDetector.detect(sample.slice(0, LANGUAGE_SAMPLE_CHARS));
      if (kind === "application/json") sendJson(response, 200, result);
      else send(response, 200, "text/plain; charset=utf-8", result.language === "und" ? "" : toIso6391(result.language));
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
    if (url.pathname === "/mime-types" || url.pathname.startsWith("/mime-types/")) {
      serveMimeTypes(request, response, url.pathname);
      return;
    }
    if ((method === "GET" || method === "HEAD") && url.pathname === "/") {
      const kind = negotiate(request.headers.accept, ["text/html", "text/plain"]);
      if (kind === null) {
        notAcceptable(response);
        return;
      }
      const page = kind === "text/html" ? welcomeHtml(enabled) : welcomeText(enabled);
      send(response, 200, `${kind}; charset=utf-8`, page);
      return;
    }
    if (url.pathname === "/") {
      response.setHeader("Allow", "GET, HEAD");
      send(response, 405, "text/plain", "Method not allowed");
      return;
    }
    if (method === "GET" && url.pathname.replace(/\/$/, "") === "/tika") {
      if (negotiate(request.headers.accept, ["text/plain"]) === null) notAcceptable(response);
      else send(response, 200, "text/plain; charset=utf-8", GREETING);
      return;
    }
    const target = resolveTarget(url.pathname);
    if (target === null) {
      send(response, 404, "text/plain", "Not found");
      return;
    }
    const presets = options.presets ?? {};
    const presetName = url.searchParams.get("preset");
    if (presetName !== null && !Object.hasOwn(presets, presetName)) {
      throw new HttpError(400, `Unknown preset ${JSON.stringify(presetName)}`);
    }
    const preset = presetName === null ? undefined : presets[presetName];
    const limits: Record<string, number> = { ...(preset?.limits ?? {}) };
    for (const key of ["maxOutputChars", "maxEmbeddedResources"] as const) {
      const requested = clientLimit(url.searchParams.get(key), key);
      const ceiling = options.maxLimits?.[key];
      const value = requested ?? limits[key] ?? options.defaultLimits?.[key];
      if (ceiling !== undefined) limits[key] = Math.min(value ?? ceiling, ceiling);
      else if (value !== undefined) limits[key] = value;
    }
    const requestedHandler = url.searchParams.get("handler")?.toLowerCase() ?? null;
    if (requestedHandler !== null && !HANDLERS.includes(requestedHandler)) {
      throw new HttpError(400, `Unknown handler ${JSON.stringify(requestedHandler)}; handlers are: ${HANDLERS.join(", ")}`);
    }
    if (requestedHandler !== null && (target.fixedType !== null || target.json)) {
      throw new HttpError(400, `${url.pathname} names its handler in the path; ?handler= is read by /tika alone`);
    }
    // What the request names, most specific first: ?handler=, then the preset's. (The path's own handler is read below.)
    const handlerOverride = requestedHandler ?? preset?.handler?.toLowerCase();
    const allowed = target.form ? ["POST"] : ["PUT", "POST"];
    if (!allowed.includes(method)) {
      response.setHeader("Allow", allowed.join(", "));
      send(response, 405, "text/plain", "Method not allowed");
      return;
    }
    // A handler that names a content format. `meta` and `json` are answers of /tika alone; /rmeta ignores them.
    const formatOf = (name: string | null | undefined, fallback: HandlerType): HandlerType => {
      try {
        return parseHandlerType(name === "meta" || name === "json" ? null : name, fallback);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
    };
    // A bad handler in the path is the caller's mistake, found before the document is read, as Tika's is.
    const pathType = target.handler === null ? null : formatOf(target.handler, "text");
    // Tika picks the resource by Accept before it reads the request: what the route writes is all it offers.
    const offered = ((): readonly string[] => {
      switch (target.endpoint) {
        case "/detect":
          return ["text/plain"];
        case "/meta":
          return target.field === null ? ["application/json", "text/csv"] : ["application/json", "text/csv", "text/plain"];
        case "/rmeta":
          return ["application/json"];
        case "/unpack":
          return ["application/zip"];
        case "/tika": {
          if (target.json) return ["application/json"];
          // `?handler=json` and `meta` are ripstream's own answers, the older object and the bare metadata.
          if (target.fixedType === null && (handlerOverride === "json" || handlerOverride === "meta")) return ["application/json"];
          return [contentTypeOf(target.fixedType ?? formatOf(handlerOverride, "text")).split(";")[0] ?? "text/plain"];
        }
      }
    })();
    const kind = negotiate(request.headers.accept, offered);
    if (kind === null) {
      notAcceptable(response);
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
    } else if (target.form || (target.endpoint === "/unpack" && method === "POST")) {
      throw new HttpError(415, "A form route takes a multipart/form-data request");
    }
    const name = multipartName ?? url.searchParams.get("filename") ?? dispositionName;
    const signal = AbortSignal.timeout(requestTimeoutMs);
    const parseOptions =
      name === undefined ? { signal } : { filename: name, signal };

    if (target.endpoint === "/detect") {
      const type = await ripstream.detect(body, parseOptions);
      send(response, 200, "text/plain", `${type.toString()}\n`);
      return;
    }
    // Tika answers for a document it could not read, rather than failing the request: the JSON routes (and the
    // `rmeta.json` of an unpack) carry the exception in the metadata (200), the text routes answer 422 with what was
    // extracted.
    const failures = { onDocumentFailure: "record" as const };
    // Tika's server answers with the text up to its write limit and flags it (`tk:exception:write-limit-reached`),
    // rather than failing the request. /async and /pipes keep the hard limit: they have no response to flag.
    const output = { onOutputLimit: options.onOutputLimit ?? ("truncate" as const) };
    const withLimits = Object.keys(limits).length === 0 ? {} : { limits };
    if (target.endpoint === "/rmeta" || target.endpoint === "/unpack") {
      const handlerType = pathType ?? formatOf(handlerOverride, "text");
      const unpacking = target.endpoint === "/unpack";
      const records = await ripstream.parseRecursive(body, {
        ...parseOptions,
        ...failures,
        ...output,
        ...withLimits,
        handlerType,
        ...(unpacking ? { unpackBytes: maxUnpackBytes } : {}),
      });
      if (!unpacking) {
        sendJson(response, 200, JSON.parse(serializeRmeta(records, rmetaOptions)));
        return;
      }
      // A document that could not be read at all has nothing to unpack: Tika answers 422 with the failure as the body.
      // A failure of one embedded document stays in its record of `rmeta.json`, and the package is still the answer.
      const [container] = records;
      if (container?.exception != null) {
        const noted = container.metadata.get(TIKA_KEYS.CONTAINER_EXCEPTION);
        throw new HttpError(422, noted ?? `${container.exception.name}: ${container.exception.message}`);
      }
      const pkg = buildUnpackPackage({
        records,
        container: target.all ? body : null,
        filename: name,
        rmeta: Buffer.from(`${serializeRmeta(records, rmetaOptions)}\n`, "utf8"),
        nameOf: (id, record) => `${id}${extensionFor(record.metadata.get("Content-Type"), options.mimeTypes)}`,
        now: new Date(),
      });
      await sendZip(response, pkg);
      return;
    }
    if (target.endpoint === "/meta") {
      // Metadata only, as Tika's /meta is: the ignore handler writes no content, so there is no output limit to reach.
      const result = await ripstream.parse(body, { ...parseOptions, ...failures, ...withLimits, handlerType: "ignore" });
      sendMetadata(response, result, target.field, kind);
      return;
    }
    const type =
      target.fixedType ?? (target.json ? (pathType ?? formatOf(preset?.handler?.toLowerCase(), "text")) : formatOf(handlerOverride, "text"));
    const result = await ripstream.parse(body, { ...parseOptions, ...failures, ...output, ...withLimits, handlerType: type });
    if (handlerOverride === "meta" && !target.json && target.fixedType === null) {
      sendJson(response, 200, filterObject(metadataJson(result.metadata)));
      return;
    }
    if (target.json) {
      // Tika's /tika/json: one object, the metadata with the content in `tk:content` and the handler that made it.
      const document = metadataJson(result.metadata);
      if (result.text.trim() !== "") document[TIKA_KEYS.CONTENT] = result.text;
      document[TIKA_KEYS.CONTENT_HANDLER_TYPE] = handlerTypeName(type);
      sendJson(response, 200, filterObject(document));
    } else if (target.fixedType === null && handlerOverride === "json") {
      const document = { text: result.text, metadata: metadataJson(result.metadata) };
      sendJson(response, 200, metadataFilter === undefined ? document : filterDocument(metadataFilter, document));
    } else {
      // The content is what a text answer is, so a parse-context filter that drops `tk:content` drops it. A blank text has
      // no `tk:content` to keep or to drop.
      const text = textFilter === undefined || result.text.trim() === "" ? result.text : filterDocument(textFilter, { metadata: metadataJson(result.metadata), text: result.text }).text;
      if (result.exception !== undefined) {
        send(response, 422, contentTypeOf(type), text, {
          "X-Ripstream-Error": headerText(`${result.exception.name}: ${result.exception.message}`),
        });
      } else if (result.metadata.get(TIKA_KEYS.WRITE_LIMIT_REACHED) === "true") {
        // A text answer has no metadata to carry the flag: a client that needs to know the text was cut reads this header.
        send(response, 200, contentTypeOf(type), text, { "X-Ripstream-Write-Limit-Reached": "true" });
      } else {
        send(response, 200, contentTypeOf(type), text);
      }
    }
  }

  /** /mime-types and /mime-types/{type}/{subtype}: the media types the server was given, as HTML, JSON or text. */
  function serveMimeTypes(request: IncomingMessage, response: ServerResponse, pathname: string): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      send(response, 405, "text/plain", "Method not allowed");
      return;
    }
    let segments: string[];
    try {
      segments = pathname.split("/").filter((part) => part !== "").slice(1).map(decodeURIComponent);
    } catch {
      send(response, 404, "text/plain", "Not found");
      return;
    }
    if (segments.length !== 0 && segments.length !== 2) {
      send(response, 404, "text/plain", "Not found");
      return;
    }
    if (options.mimeTypes === undefined) {
      send(response, 404, "text/plain", "This server has no media type registry");
      return;
    }
    const [type, subtype] = segments;
    const detail = type === undefined || subtype === undefined ? undefined : findMimeType(options.mimeTypes, type, subtype);
    if (type !== undefined && detail === undefined) {
      send(response, 404, "text/plain", `No media type registered for ${type}/${subtype}`);
      return;
    }
    const offers: readonly string[] = detail === undefined ? MIME_LIST_OFFERS : MIME_DETAIL_OFFERS;
    const kind = negotiate(request.headers.accept, offers);
    if (kind === null) {
      notAcceptable(response);
      return;
    }
    const types = sortedMimeTypes;
    if (detail !== undefined) {
      if (kind === "application/json") send(response, 200, "application/json", mimeTypeDetailJson(detail));
      else send(response, 200, "text/html; charset=utf-8", mimeTypeDetailHtml(detail));
    } else if (kind === "application/json") send(response, 200, "application/json", mimeTypesJson(types));
    else if (kind === "text/plain") send(response, 200, "text/plain; charset=utf-8", mimeTypesText(types));
    else send(response, 200, "text/html; charset=utf-8", mimeTypesHtml(types));
  }

  /** /meta and /meta/{field}: the metadata (or one field of it) as JSON, CSV or, for a field, plain text. */
  function sendMetadata(
    response: ServerResponse,
    result: { readonly metadata: Metadata; readonly exception?: Error },
    field: string | null,
    kind: string,
  ): void {
    let metadata = result.metadata;
    if (metadataFilter !== undefined) {
      // What the filters leave of it: a document they take out of the list is no metadata at all.
      metadata = new Metadata();
      for (const [name, value] of Object.entries(filterObject(metadataJson(result.metadata)))) {
        for (const each of Array.isArray(value) ? value : [value]) metadata.add(name, String(each));
      }
    }
    if (field !== null) {
      // A bare field value has no envelope to carry the failure of the container, so it is an error, as Tika's is.
      if (result.exception !== undefined) {
        throw new HttpError(422, `${result.exception.name}: ${result.exception.message}`);
      }
      if (metadata.get(field) === null) {
        send(response, 404, "text/plain; charset=utf-8", `Failed to get metadata field ${field}`);
        return;
      }
      const only = new Metadata();
      for (const value of metadata.getAll(field)) only.add(field, value);
      metadata = only;
    }
    if (kind === "application/json") sendJson(response, 200, metadataJson(metadata));
    else if (kind === "text/csv") send(response, 200, "text/csv; charset=UTF-8", metadataCsv(metadata));
    else send(response, 200, "text/plain; charset=utf-8", metadata.get(field ?? "") ?? "");
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
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      // After the listener is closed, so nothing new is queued while what was taken is finished.
      await tikaPipes?.close();
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
  const name = pathname.split("/")[1] ?? "";
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
  const asyncWait = options.pipes?.asyncMaxWaitMs;
  if (asyncWait !== undefined && (!Number.isInteger(asyncWait) || asyncWait < 0 || asyncWait > 2_147_483_647)) {
    throw new RangeError("createRipstreamServer: pipes.asyncMaxWaitMs must be an integer from 0 to 2147483647");
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
 * The slots for an active isolation: the requests its memory pool can run at once plus the ones it will queue. It is
 * sized by the dearer of the text and records reservations, so a run of /rmeta requests does not read more bodies than
 * the pool can place. Requests beyond the slots wait in the server's own queue with their body unread, so a burst
 * costs sockets, not memory. It does not bound memory exactly: /pipes spends one slot on a run that parses several
 * documents at once. Undefined when nothing is isolated or the status cannot size it, which leaves the caller's
 * options and the old default in charge.
 */
function deriveGate(status: ServerIsolationStatus): { maxConcurrent: number } | undefined {
  const { pool, defaultReservationMb } = status;
  if (pool === null || defaultReservationMb === null) return undefined;
  const reservation = Math.max(defaultReservationMb.text, defaultReservationMb.records);
  if (!Number.isFinite(reservation) || reservation <= 0 || !Number.isFinite(pool.poolMb)) return undefined;
  // A status from an older or third-party isolation may not report the pool's queue: an unknown one counts as none.
  const poolQueue = Number.isSafeInteger(pool.maxQueue) && pool.maxQueue > 0 ? pool.maxQueue : 0;
  return { maxConcurrent: Math.max(1, Math.floor(pool.poolMb / reservation)) + poolQueue };
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

/** The JSON in a body, or undefined when it is not JSON (a body that may be a document, not only a request). */
function tryParseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(body));
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  pipes: RipstreamServerPipesOptions & { readonly sourceRoot: string },
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

/** A document's own words in a header value: printable ASCII only, one line, bounded. */
function headerText(text: string): string {
  return text.replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 200);
}

/**
 * 406 with no body, as Tika answers when the Accept header names nothing the route can write. Tika makes the choice
 * before it reads the request, so a document that would fail to parse is still a 406.
 */
function notAcceptable(response: ServerResponse): void {
  response.writeHead(406, { "Content-Length": "0" });
  response.end();
}

/** What a response is compressed from: text, JSON and XML. The smallest body worth it is Jetty's, which Tika uses. */
const COMPRESSIBLE = /^(text\/|application\/(json|xml|rdf\+xml))/i;
const GZIP_MIN_BYTES = 32;

/** Whether an `Accept-Encoding` header allows gzip: named, or by `*`, and not at quality 0. */
function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return false;
  return header.split(",").some((part) => {
    const [name = "", ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
    if (name !== "gzip" && name !== "x-gzip" && name !== "*") return false;
    const q = params.map((param) => /^q=([0-9.]+)$/.exec(param)?.[1]).find((value) => value !== undefined);
    return q === undefined || Number(q) > 0;
  });
}

/**
 * Writes a response in one piece. Gzipped, with `Content-Encoding` and `Vary`, when the client allows it and the body
 * is a text type of at least `GZIP_MIN_BYTES`, as Tika's server does; otherwise as it is. `headers` are the response's
 * own, beyond its type.
 */
function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  const bytes = Buffer.from(body, "utf8");
  const head = { "Content-Type": contentType, ...headers };
  if (bytes.length < GZIP_MIN_BYTES || !COMPRESSIBLE.test(contentType) || !acceptsGzip(response.req.headers["accept-encoding"])) {
    response.writeHead(status, head);
    response.end(bytes);
    return;
  }
  // Off the event loop: a large answer is compressed while other requests are served.
  gzip(bytes, (error, packed) => {
    if (error !== null) {
      response.writeHead(status, head);
      response.end(bytes);
      return;
    }
    response.appendHeader("Vary", "Accept-Encoding");
    response.writeHead(status, { ...head, "Content-Encoding": "gzip" });
    response.end(packed);
  });
}

/**
 * Writes the package as a zip, a file at a time, so the answer is never held a second time beside the files it is made
 * of. Everything that can refuse the request is done before the first byte: a failure after it can only end the
 * connection, which a client reads as a failed download and not as a short zip.
 */
async function sendZip(response: ServerResponse, pkg: UnpackPackage): Promise<void> {
  const chunks = zipChunks(pkg);
  try {
    const first = await chunks.next();
    if (first.done === true) throw new Error("A package has at least its manifest");
    response.writeHead(200, { "Content-Type": "application/zip" });
    if (!response.write(first.value)) await once(response, "drain");
    for await (const chunk of chunks) {
      if (response.destroyed) return;
      if (!response.write(chunk)) await once(response, "drain");
    }
    response.end();
  } catch (error) {
    if (!response.headersSent) throw error;
    response.destroy(error instanceof Error ? error : undefined);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, "application/json", `${JSON.stringify(body)}\n`);
}

/** Tika's answer to /pipes and /async: its status, its Retry-After when it has one, and its JSON body. */
function sendTika(response: ServerResponse, answer: TikaPipesAnswer): void {
  if (answer.retryAfterSeconds !== undefined) response.setHeader("Retry-After", String(answer.retryAfterSeconds));
  sendJson(response, answer.status, answer.body);
}
