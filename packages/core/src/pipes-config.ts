import { parseSearchEmitter, type SearchEmitterSettings } from "./pipes-search-config.ts";
import {
  parseS3Emitter,
  parseS3Fetcher,
  parseS3Iterator,
  type S3EmitterSettings,
  type S3FetcherSettings,
  type S3IteratorSettings,
} from "./pipes-s3-config.ts";
import type { UnpackSettings } from "./unpack-config.ts";

/*
 * The pipes sections of a Tika configuration (`fetchers`, `emitters`, `pipes-iterator`, `pipes-reporters`, `pipes`),
 * read the way server-config.ts reads `server`: what ripstream has is applied, what changes nothing is accepted and
 * said so, and the rest is refused by name with the reason (tikajs-68os.6.2). The pipes package builds the components.
 */

/** Tika's PipesResult.RESULT_STATUS values, each with its CATEGORY (tika-pipes-api PipesResult.java). */
export const PIPES_RESULT_STATUSES = {
  FAILED_TO_INITIALIZE: "FATAL",
  FETCHER_INITIALIZATION_EXCEPTION: "INITIALIZATION_FAILURE",
  EMITTER_INITIALIZATION_EXCEPTION: "INITIALIZATION_FAILURE",
  CLIENT_UNAVAILABLE_WITHIN_MS: "INITIALIZATION_FAILURE",
  FETCH_EXCEPTION: "TASK_EXCEPTION",
  EMIT_EXCEPTION: "TASK_EXCEPTION",
  FETCHER_NOT_FOUND: "TASK_EXCEPTION",
  EMITTER_NOT_FOUND: "TASK_EXCEPTION",
  PRESET_NOT_FOUND: "TASK_EXCEPTION",
  PAYLOAD_LIMIT_EXCEEDED: "TASK_EXCEPTION",
  OOM: "PROCESS_CRASH",
  TIMEOUT: "PROCESS_CRASH",
  UNSPECIFIED_CRASH: "PROCESS_CRASH",
  EMPTY_OUTPUT: "SUCCESS",
  PARSE_SUCCESS: "SUCCESS",
  PARSE_SUCCESS_WITH_EXCEPTION: "SUCCESS",
  PARSE_EXCEPTION_NO_EMIT: "SUCCESS",
  EMIT_SUCCESS: "SUCCESS",
  EMIT_SUCCESS_PARSE_EXCEPTION: "SUCCESS",
  EMIT_SUCCESS_PASSBACK: "SUCCESS",
  PARTIAL_TIMEOUT: "SUCCESS",
} as const;

export type PipesResultStatus = keyof typeof PIPES_RESULT_STATUSES;
export type PipesResultCategory = (typeof PIPES_RESULT_STATUSES)[PipesResultStatus];

/** Tika's ParseMode. */
export const PIPES_PARSE_MODES = ["RMETA", "CONCATENATE", "CONTENT_ONLY", "NO_PARSE", "UNPACK"] as const;
export type PipesParseMode = (typeof PIPES_PARSE_MODES)[number];

/** Tika's FetchEmitTuple.ON_PARSE_EXCEPTION. */
export type PipesOnParseException = "EMIT" | "SKIP";

/** Tika's ComponentIds: what an id may be, and the prefix kept for components the system supplies. */
export const COMPONENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const SYSTEM_COMPONENT_PREFIX = "__";

export type PipesFetcherSettings =
  | { readonly id: string; readonly type: "file-system-fetcher"; readonly basePath?: string; readonly allowAbsolutePaths: boolean }
  | { readonly id: string; readonly type: "http-fetcher" }
  | S3FetcherSettings;

export type PipesEmitterSettings = FileSystemEmitterSettings | S3EmitterSettings | SearchEmitterSettings;

/** Tika's FileSystemEmitterConfig, with its defaults applied: onExists EXCEPTION, atomicWrites true, compression NONE. */
export interface FileSystemEmitterSettings {
  readonly id: string;
  readonly type: "file-system-emitter";
  readonly basePath?: string;
  readonly allowAbsolutePaths: boolean;
  readonly fileExtension?: string;
  readonly onExists: "EXCEPTION" | "SKIP" | "REPLACE";
  readonly atomicWrites: boolean;
  readonly compression: "NONE" | "GZIP";
  readonly prettyPrint: boolean;
}

export interface FileSystemIteratorSettings {
  readonly type: "file-system-pipes-iterator";
  readonly basePath: string;
  readonly fetcherId: string;
  readonly emitterId: string;
}

export type PipesIteratorSettings = FileSystemIteratorSettings | S3IteratorSettings;

export interface PipesReporterSettings {
  readonly type: "file-system-jsonl-reporter";
  readonly path: string;
  readonly includes?: readonly PipesResultStatus[];
  readonly excludes?: readonly PipesResultStatus[];
  /** Tika's default is EXCEPTION: a report file that is already there is an error. */
  readonly onExists: "EXCEPTION" | "APPEND" | "REPLACE";
  readonly maxMessageLength: number;
}

/** The pipes sections as ripstream applies them. A key the sections leave out is absent here. */
export interface PipesSettings {
  readonly fetchers: readonly PipesFetcherSettings[];
  readonly emitters: readonly PipesEmitterSettings[];
  readonly iterator?: PipesIteratorSettings;
  readonly reporters: readonly PipesReporterSettings[];
  readonly parseMode?: PipesParseMode;
  readonly onParseException?: PipesOnParseException;
  /** `pipes.numClients`: how many inputs are parsed at once. */
  readonly concurrency?: number;
  /** `pipes.queueSize`. */
  readonly maxQueue?: number;
  /** The `unpack-config` of the `parse-context` section: what UNPACK mode emits. Set by `loadConfig`, not by the pipes sections. */
  readonly unpack?: UnpackSettings;
  /** Settings that were accepted and change nothing here, each with why: for the operator, not an error. */
  readonly notices: readonly string[];
}

export const PIPES_SECTION_KEYS = ["fetchers", "emitters", "pipes-iterator", "pipes-reporters", "pipes"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const whole = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\u0000");

const CLOUD =
  "ripstream's pipes have the file-system, http and S3 fetchers, the file-system, S3, Elasticsearch and OpenSearch emitters, the file-system and S3 iterators and the jsonl reporter; the other cloud, database and search components are not implemented (docs/migration.md says which, and why)";

/** A `{ type: config }` object as Tika writes a component: exactly one key, whose value is an object. */
function oneComponent(value: unknown, where: string, issues: string[]): { type: string; config: Record<string, unknown> } | null {
  if (!isObject(value)) {
    issues.push(`${where} must be an object with one key, the component type`);
    return null;
  }
  const types = Object.keys(value);
  if (types.length !== 1) {
    issues.push(`${where} must name exactly one component type, got ${types.length === 0 ? "none" : types.map((t) => JSON.stringify(t)).join(", ")}`);
    return null;
  }
  const type = types[0]!;
  const config = value[type];
  if (!isObject(config)) {
    issues.push(`${where}.${type} must be an object`);
    return null;
  }
  return { type, config };
}

function checkId(id: string, where: string, issues: string[]): void {
  if (!COMPONENT_ID_PATTERN.test(id)) issues.push(`${where}: id ${JSON.stringify(id)} may only use letters, digits, '.', '_' and '-'`);
  else if (id.startsWith(SYSTEM_COMPONENT_PREFIX)) issues.push(`${where}: id ${JSON.stringify(id)} starts with "${SYSTEM_COMPONENT_PREFIX}", which is kept for components the system supplies`);
}

function unknownKeys(config: Record<string, unknown>, known: readonly string[], where: string, reasons: Readonly<Record<string, string>>, issues: string[]): void {
  for (const key of Object.keys(config)) {
    if (known.includes(key)) continue;
    issues.push(`${where}.${key} ${reasons[key] ?? `is not a setting ripstream has (it reads ${known.join(", ")})`}`);
  }
}

/** A switch that opens a feature ripstream does not have: off is what ripstream does, so off is accepted. */
function offSwitch(config: Record<string, unknown>, key: string, where: string, why: string, issues: string[]): void {
  const value = config[key];
  if (value === undefined || value === false) return;
  issues.push(value === true ? `${where}.${key} is true, which ${why}` : `${where}.${key} must be a boolean`);
}

function fetchers(raw: unknown, issues: string[], notices: string[]): PipesFetcherSettings[] {
  const found: PipesFetcherSettings[] = [];
  if (!isObject(raw)) {
    issues.push("fetchers must be an object of fetcher ids");
    return found;
  }
  for (const [id, entry] of Object.entries(raw)) {
    const where = `fetchers.${id}`;
    checkId(id, where, issues);
    const one = oneComponent(entry, where, issues);
    if (one === null) continue;
    const { type, config } = one;
    const at = `${where}.${type}`;
    if (type === "file-system-fetcher") {
      unknownKeys(config, ["basePath", "allowAbsolutePaths", "extractFileSystemMetadata"], at, {}, issues);
      offSwitch(config, "extractFileSystemMetadata", at, "asks for file times in the metadata, which ripstream's fetcher does not add", issues);
      const allow = config.allowAbsolutePaths;
      if (allow !== undefined && typeof allow !== "boolean") issues.push(`${at}.allowAbsolutePaths must be a boolean`);
      const base = config.basePath;
      if (base !== undefined && !nonEmpty(base)) issues.push(`${at}.basePath must be a non-empty string`);
      else if (typeof base === "string" && /^(https?|ftp|s3):\/\//.test(base)) issues.push(`${at}.basePath is not a local directory: file-system-fetcher reads the local file system only`);
      if (base === undefined && allow !== true) {
        issues.push(`${at} needs basePath, or allowAbsolutePaths true: without basePath a tuple can read any file this process can`);
      }
      found.push({ id, type, ...(typeof base === "string" ? { basePath: base } : {}), allowAbsolutePaths: allow === true });
    } else if (type === "http-fetcher") {
      unknownKeys(config, [], at, Object.fromEntries(Object.keys(config).map((key) => [key, "is not supported: ripstream's http-fetcher reads a URL with the SSRF guard and takes no settings (tikajs-68os.6.6)"])), issues);
      found.push({ id, type });
    } else if (type === "s3-fetcher") {
      const settings = parseS3Fetcher(id, config, { at, issues, notices });
      if (settings !== undefined) found.push(settings);
    } else {
      issues.push(`${at} is not a fetcher ripstream has: ${CLOUD}`);
    }
  }
  return found;
}

function emitters(raw: unknown, issues: string[], notices: string[]): PipesEmitterSettings[] {
  const found: PipesEmitterSettings[] = [];
  if (!isObject(raw)) {
    issues.push("emitters must be an object of emitter ids");
    return found;
  }
  for (const [id, entry] of Object.entries(raw)) {
    const where = `emitters.${id}`;
    checkId(id, where, issues);
    const one = oneComponent(entry, where, issues);
    if (one === null) continue;
    const { type, config } = one;
    const at = `${where}.${type}`;
    if (type === "s3-emitter") {
      const settings = parseS3Emitter(id, config, { at, issues, notices });
      if (settings !== undefined) found.push(settings);
      continue;
    }
    if (type === "es-emitter" || type === "opensearch-emitter") {
      const settings = parseSearchEmitter(id, type, config, { at, issues, notices });
      if (settings !== undefined) found.push(settings);
      continue;
    }
    if (type !== "file-system-emitter") {
      issues.push(`${at} is not an emitter ripstream has: ${CLOUD}`);
      continue;
    }
    const before = issues.length;
    unknownKeys(config, ["basePath", "allowAbsolutePaths", "fileExtension", "onExists", "atomicWrites", "compression", "prettyPrint"], at, {}, issues);
    const base = config.basePath;
    if (base !== undefined && !nonEmpty(base)) issues.push(`${at}.basePath must be a non-empty string`);
    const flag = (key: "allowAbsolutePaths" | "atomicWrites" | "prettyPrint", fallback: boolean): boolean => {
      const value = config[key];
      if (value === undefined) return fallback;
      if (typeof value !== "boolean") issues.push(`${at}.${key} must be a boolean`);
      return value === true;
    };
    const allowAbsolutePaths = flag("allowAbsolutePaths", false);
    const atomicWrites = flag("atomicWrites", true);
    const prettyPrint = flag("prettyPrint", false);
    if (base === undefined && !allowAbsolutePaths) {
      issues.push(`${at} needs basePath, or allowAbsolutePaths true: without basePath an emit key can name any file this process can write`);
    }
    const extension = config.fileExtension;
    if (extension !== undefined && typeof extension !== "string") issues.push(`${at}.fileExtension must be a string`);
    else if (typeof extension === "string" && /[\\/\u0000]/.test(extension)) issues.push(`${at}.fileExtension must not contain a path separator or a NUL byte`);
    const onExists = choice(config, "onExists", ["EXCEPTION", "SKIP", "REPLACE"], "EXCEPTION", at, issues);
    const compression = choice(config, "compression", ["NONE", "GZIP"], "NONE", at, issues);
    if (issues.length > before) continue;
    found.push({
      id,
      type,
      ...(typeof base === "string" ? { basePath: base } : {}),
      allowAbsolutePaths,
      ...(typeof extension === "string" && extension.trim() !== "" ? { fileExtension: extension.trim() } : {}),
      onExists,
      atomicWrites,
      compression,
      prettyPrint,
    });
  }
  return found;
}

/** A setting that is one of a fixed set of names, in the case Tika's enums are read in. */
function choice<T extends string>(config: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T, where: string, issues: string[]): T {
  const value = config[key] ?? fallback;
  if (allowed.includes(value as T)) return value as T;
  issues.push(`${where}.${key} must be ${allowed.slice(0, -1).join(", ")} or ${allowed[allowed.length - 1]}`);
  return fallback;
}

function statusList(value: unknown, where: string, issues: string[]): PipesResultStatus[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${where} must be an array of result statuses`);
    return undefined;
  }
  const names: PipesResultStatus[] = [];
  value.forEach((item: unknown, index) => {
    if (typeof item === "string" && item in PIPES_RESULT_STATUSES) names.push(item as PipesResultStatus);
    else issues.push(`${where}[${index}] ${JSON.stringify(item)} is not a result status (Tika's are ${Object.keys(PIPES_RESULT_STATUSES).join(", ")})`);
  });
  return names;
}

function reporters(raw: unknown, issues: string[]): PipesReporterSettings[] {
  const found: PipesReporterSettings[] = [];
  if (!isObject(raw)) {
    issues.push("pipes-reporters must be an object keyed by reporter type");
    return found;
  }
  for (const [type, config] of Object.entries(raw)) {
    const at = `pipes-reporters.${type}`;
    if (type !== "file-system-jsonl-reporter") {
      issues.push(`${at} is not a reporter ripstream has: ${CLOUD}`);
      continue;
    }
    if (!isObject(config)) {
      issues.push(`${at} must be an object`);
      continue;
    }
    unknownKeys(config, ["path", "includes", "excludes", "onExists", "maxMessageLength"], at, {}, issues);
    if (!nonEmpty(config.path)) issues.push(`${at}.path is required and must be a non-empty string`);
    const includes = config.includes === undefined ? undefined : statusList(config.includes, `${at}.includes`, issues);
    const excludes = config.excludes === undefined ? undefined : statusList(config.excludes, `${at}.excludes`, issues);
    if ((includes?.length ?? 0) > 0 && (excludes?.length ?? 0) > 0) issues.push(`${at} may set includes or excludes, not both`);
    const onExists = config.onExists ?? "EXCEPTION";
    if (onExists !== "EXCEPTION" && onExists !== "APPEND" && onExists !== "REPLACE") issues.push(`${at}.onExists must be EXCEPTION, APPEND or REPLACE`);
    const max = config.maxMessageLength ?? 0;
    if (!whole(max, 0, 2 ** 31 - 1)) issues.push(`${at}.maxMessageLength must be a whole number from 0 (the default, 10000) up`);
    if (nonEmpty(config.path) && (onExists === "EXCEPTION" || onExists === "APPEND" || onExists === "REPLACE") && whole(max, 0, 2 ** 31 - 1)) {
      found.push({
        type: "file-system-jsonl-reporter",
        path: config.path,
        ...(includes === undefined || includes.length === 0 ? {} : { includes }),
        ...(excludes === undefined || excludes.length === 0 ? {} : { excludes }),
        onExists,
        maxMessageLength: max === 0 ? 10_000 : max,
      });
    }
  }
  return found;
}

/** `pipes` keys that tune Tika's forked JVMs. ripstream has none: its parsers run in-process or in isolated children. */
const PROCESS_KNOBS: Readonly<Record<string, string>> = {
  forkedJvmArgs: "sets JVM arguments for Tika's forked server; ripstream has no JVM (isolation limits are under `isolation`)",
  javaPath: "names the java binary Tika forks; ripstream has none",
  useSharedServer: "chooses how Tika's forked servers are shared; ripstream's isolation has its own pool",
  heartbeatIntervalMillis: "tunes the heartbeat of Tika's forked server",
  socketTimeoutMillis: "tunes the socket to Tika's forked server",
  startupTimeoutMillis: "tunes the startup of Tika's forked server",
};

/** Emit batching that cannot change what is emitted: there is no process boundary to batch across. */
const EMIT_KNOBS: Readonly<Record<string, string>> = {
  emitWithinMillis: "batches emits for Tika's async emitter; ripstream emits each input as it is done",
  numEmitters: "sets Tika's emitter threads; ripstream emits from the workers that parse",
  emitMaxEstimatedBytes: "batches emits for Tika's async emitter; ripstream emits each input as it is done",
};

const PIPES_REFUSED: Readonly<Record<string, string>> = {
  maxFilesProcessedPerProcess: "restarts Tika's forked server after so many files; isolation recycles its children by its own limits",
  maxFilesWaitingInQueue: "is not a setting ripstream has (queueSize is)",
  configStoreType: "chooses where Tika keeps per-request configuration; ripstream takes none with a request",
  configStoreParams: "chooses where Tika keeps per-request configuration; ripstream takes none with a request",
};

function pipesKeys(raw: unknown, issues: string[], notices: string[]): Pick<PipesSettings, "parseMode" | "onParseException" | "concurrency" | "maxQueue"> {
  const out: { parseMode?: PipesParseMode; onParseException?: PipesOnParseException; concurrency?: number; maxQueue?: number } = {};
  if (!isObject(raw)) {
    issues.push("pipes must be an object");
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    const at = `pipes.${key}`;
    if (key === "parseMode") {
      const mode = typeof value === "string" ? value.toUpperCase() : value;
      if ((PIPES_PARSE_MODES as readonly unknown[]).includes(mode)) out.parseMode = mode as PipesParseMode;
      else issues.push(`${at} must be one of ${PIPES_PARSE_MODES.join(", ")}`);
    } else if (key === "onParseException") {
      if (value === "EMIT" || value === "SKIP") out.onParseException = value;
      else issues.push(`${at} must be EMIT or SKIP`);
    } else if (key === "numClients") {
      if (whole(value, 1, 1_048_576)) out.concurrency = value;
      else issues.push(`${at} must be a positive whole number`);
    } else if (key === "queueSize") {
      if (whole(value, 1, 2 ** 31 - 1)) out.maxQueue = value;
      else issues.push(`${at} must be a positive whole number`);
    } else if (key in PROCESS_KNOBS) {
      notices.push(`${at} ${PROCESS_KNOBS[key]}, so it changes nothing`);
    } else if (key in EMIT_KNOBS) {
      if (whole(value, -1, 2 ** 53 - 1)) notices.push(`${at} ${EMIT_KNOBS[key]}, so it changes nothing`);
      else issues.push(`${at} must be a whole number`);
    } else if (key === "emitStrategy") {
      const type = isObject(value) ? value.type : value;
      if (type === "EMIT_ALL" || type === "DYNAMIC") notices.push(`${at} ${type} splits Tika's emits between its server and its client; ripstream's engine emits every input itself, so it changes nothing`);
      else if (type === "PASSBACK_ALL") issues.push(`${at} PASSBACK_ALL returns the parse to the caller instead of emitting it, which ripstream's pipes do not do (tikajs-68os.6.5)`);
      else issues.push(`${at} must be EMIT_ALL, PASSBACK_ALL or DYNAMIC, or an object whose type is`);
    } else if (key === "emitIntermediateResults") {
      if (value === false) continue;
      issues.push(value === true ? `${at} is true, which emits what a timed-out parse had read (PARTIAL_TIMEOUT); ripstream's timeout emits nothing` : `${at} must be a boolean`);
    } else {
      issues.push(`${at} ${PIPES_REFUSED[key] ?? "is not a setting ripstream has"}`);
    }
  }
  return out;
}

function iterator(raw: unknown, issues: string[], notices: string[]): PipesIteratorSettings | undefined {
  const one = oneComponent(raw, "pipes-iterator", issues);
  if (one === null) return undefined;
  const { type, config } = one;
  const at = `pipes-iterator.${type}`;
  if (type === "s3-pipes-iterator") return parseS3Iterator(config, { at, issues, notices });
  if (type !== "file-system-pipes-iterator") {
    issues.push(`${at} is not an iterator ripstream has: ${CLOUD}`);
    return undefined;
  }
  unknownKeys(config, ["basePath", "countTotal", "fetcherId", "emitterId"], at, {}, issues);
  if (config.countTotal !== undefined) {
    if (typeof config.countTotal !== "boolean") issues.push(`${at}.countTotal must be a boolean`);
    else if (config.countTotal) notices.push(`${at}.countTotal asks for the total ahead of the run; ripstream does not count ahead, so it changes nothing`);
  }
  for (const key of ["basePath", "fetcherId", "emitterId"] as const) {
    if (!nonEmpty(config[key])) issues.push(`${at}.${key} is required and must be a non-empty string`);
  }
  if (![config.basePath, config.fetcherId, config.emitterId].every(nonEmpty)) return undefined;
  return { type, basePath: config.basePath as string, fetcherId: config.fetcherId as string, emitterId: config.emitterId as string };
}

/**
 * Reads the pipes sections of a configuration. `undefined` settings when the configuration has none; otherwise the
 * issues are empty exactly when the settings are usable.
 */
export function parsePipesSections(record: Record<string, unknown>): { issues: string[]; settings: PipesSettings | undefined } {
  if (!PIPES_SECTION_KEYS.some((key) => record[key] !== undefined)) return { issues: [], settings: undefined };
  const issues: string[] = [];
  const notices: string[] = [];
  const fetcherList = record.fetchers === undefined ? [] : fetchers(record.fetchers, issues, notices);
  const emitterList = record.emitters === undefined ? [] : emitters(record.emitters, issues, notices);
  const reporterList = record["pipes-reporters"] === undefined ? [] : reporters(record["pipes-reporters"], issues);
  const iteratorSettings = record["pipes-iterator"] === undefined ? undefined : iterator(record["pipes-iterator"], issues, notices);
  const keys = record.pipes === undefined ? {} : pipesKeys(record.pipes, issues, notices);
  if (iteratorSettings !== undefined) {
    if (!fetcherList.some((fetcher) => fetcher.id === iteratorSettings.fetcherId)) issues.push(`pipes-iterator.${iteratorSettings.type}.fetcherId ${JSON.stringify(iteratorSettings.fetcherId)} is not in fetchers`);
    if (!emitterList.some((emitter) => emitter.id === iteratorSettings.emitterId)) issues.push(`pipes-iterator.${iteratorSettings.type}.emitterId ${JSON.stringify(iteratorSettings.emitterId)} is not in emitters`);
  }
  return {
    issues,
    settings: {
      fetchers: fetcherList,
      emitters: emitterList,
      ...(iteratorSettings === undefined ? {} : { iterator: iteratorSettings }),
      reporters: reporterList,
      ...keys,
      notices,
    },
  };
}
