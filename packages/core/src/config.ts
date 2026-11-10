import { parseComponentSection, type ComponentEntry, type ComponentSection } from "./component-config.ts";
import type { IsolationConfig } from "./isolation.ts";
import { jsonStructureIssues } from "./json-structure.ts";
import type { ParseLimits } from "./parse-context.ts";
import type { DigestSettings } from "./digest.ts";
import { parseParseContextSection } from "./parse-context-config.ts";
import { parsePipesSections, PIPES_SECTION_KEYS, type PipesSettings } from "./pipes-config.ts";
import { parseServerSection, type ServerSettings } from "./server-config.ts";
import type { UnpackSettings } from "./unpack-config.ts";

export interface RipstreamConfigShape {
  readonly version?: number;
  readonly isolation?: IsolationConfig;
  /** The `parsers` section, already read into entries by `loadConfig`. */
  readonly parsers?: readonly ComponentEntry[];
  /** The `detectors` section, already read into entries by `loadConfig`. */
  readonly detectors?: readonly ComponentEntry[];
  /** The limits of the `parse-context` section, already read by `loadConfig`. */
  readonly limits?: Readonly<Partial<ParseLimits>>;
  /** `parse-context` `output-limits.throwOnWriteLimit` is true. */
  readonly throwOnWriteLimit?: boolean;
  /** The `parse-context` digester factory: the digests every document gets. */
  readonly digest?: DigestSettings;
  /** The path the `custom-mimetypes` key names. */
  readonly customMimeTypes?: string;
  /** The `server` section, already read by `loadConfig`. */
  readonly server?: ServerSettings;
  /** The pipes sections (`fetchers`, `emitters`, `pipes-iterator`, `pipes-reporters`, `pipes`), already read by `loadConfig`. */
  readonly pipes?: PipesSettings;
  /** Settings the configuration had that were accepted and change nothing, each with why. */
  readonly notices?: readonly string[];
}

const ALLOWED_ROOT_KEYS = new Set([
  "version",
  "isolation",
  "parsers",
  "detectors",
  "parse-context",
  "custom-mimetypes",
  "server",
  "plugin-roots",
  ...PIPES_SECTION_KEYS,
]);

/**
 * Sections Tika's configuration has and ripstream does not apply. They are refused by name rather than accepted and
 * ignored, which would report success while changing nothing.
 */
const UNAPPLIED_SECTIONS = new Set([
  "contentHandlers",
  "metadataFilters",
  "encodingDetector",
]);

const ISOLATION_MODES: readonly string[] = ["strict", "lenient", "off"];
const ISOLATION_KEYS = new Set([
  "mode",
  "requireStrictContainment",
  "memoryPoolMb",
  "perChildMb",
  "maxInputBytes",
  "maxTaskMillis",
  "heapMb",
  "maxQueue",
  "maxDiskMb",
]);
/** Inclusive bounds. 2_147_483_647 is the largest setTimeout delay. */
const ISOLATION_NUMBER_BOUNDS = {
  memoryPoolMb: [1, 1_048_576],
  perChildMb: [1, 1_048_576],
  maxInputBytes: [1, Number.MAX_SAFE_INTEGER],
  maxTaskMillis: [1, 2_147_483_647],
  heapMb: [1, 1_048_576],
  // 0 means "no waiting room": shed load as soon as every child is busy.
  maxQueue: [0, Number.MAX_SAFE_INTEGER],
  maxDiskMb: [1, 1_048_576],
} as const;

export class RipstreamConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid ripstream configuration: ${issues.join("; ")}`);
    this.name = "RipstreamConfigError";
    this.issues = issues;
  }
}

let generationCounter = 0;

/**
 * Parsed and validated ripstream configuration. Every construction gets a new
 * generation so component caches can invalidate when configuration changes.
 */
export class RipstreamConfig {
  readonly generation: number;
  readonly version: number;
  /** null means unconfigured: the caller decides (library default is no isolation). */
  readonly isolation: IsolationConfig | null;
  /** null means no `parsers` section: every default parser. `createRipstream({ config })` applies it. */
  readonly parsers: readonly ComponentEntry[] | null;
  /** null means no `detectors` section: every default detector. `createRipstream({ config })` applies it. */
  readonly detectors: readonly ComponentEntry[] | null;
  /**
   * The ripstream limits the `parse-context` section sets, or null when it sets none. `createRipstream({ config })`
   * applies them as the defaults of every parse; a limit a call names itself wins.
   */
  readonly limits: Readonly<Partial<ParseLimits>> | null;
  /**
   * `output-limits.throwOnWriteLimit` of the `parse-context` section: true when it is set true, so reaching the output
   * limit fails the parse. Everything that applies the limits already fails there; `ripstream serve` is the one that
   * otherwise answers with the text up to the limit, and it fails instead when this is true.
   */
  readonly throwOnWriteLimit: boolean;
  /**
   * The digests the `parse-context` digester factory (`commons-digester-factory`, `bouncy-castle-digester-factory`)
   * asks for, or null when it names none. `createRipstream({ config })` applies them: every document, the container and
   * what is embedded in it, gets `tk:digest:*` keys.
   */
  readonly digest: DigestSettings | null;
  /**
   * The path of a `custom-mimetypes.xml' (Tika's file, whose property is `tika.custom-mimetypes`), or null when the
   * configuration names none. `createRipstream({ config })` reads it, relative to the working directory, and adds its
   * media types to the registry that names, magic and aliases are resolved with.
   */
  readonly customMimeTypes: string | null;
  /**
   * What the `server` section sets for `ripstream serve`, or null when it sets nothing. Only the server reads it;
   * `createRipstream` ignores it.
   */
  readonly server: ServerSettings | null;
  /**
   * What the pipes sections set, or null when there are none. Only the pipes package reads it; `createRipstream`
   * ignores it.
   */
  readonly pipes: PipesSettings | null;
  /** Settings the configuration had that were accepted and change nothing here, each with why; empty when none. */
  readonly notices: readonly string[];

  constructor(shape: RipstreamConfigShape = {}) {
    this.generation = ++generationCounter;
    this.version = shape.version ?? 1;
    this.isolation =
      shape.isolation === undefined ? null : Object.freeze({ ...shape.isolation });
    this.parsers = freezeEntries(shape.parsers);
    this.detectors = freezeEntries(shape.detectors);
    this.limits = shape.limits === undefined || Object.keys(shape.limits).length === 0 ? null : Object.freeze({ ...shape.limits });
    this.throwOnWriteLimit = shape.throwOnWriteLimit ?? false;
    this.digest = shape.digest === undefined ? null : Object.freeze({ digests: Object.freeze([...shape.digest.digests]), skipContainerDocumentDigest: shape.digest.skipContainerDocumentDigest });
    this.customMimeTypes = shape.customMimeTypes ?? null;
    this.server = shape.server === undefined || Object.keys(shape.server).length === 0 ? null : Object.freeze({ ...shape.server });
    this.pipes = shape.pipes === undefined ? null : shape.pipes;
    this.notices = Object.freeze([...(shape.notices ?? [])]);
  }

  get current(): boolean {
    return this.generation === generationCounter;
  }
}

function freezeEntries(entries: readonly ComponentEntry[] | undefined): readonly ComponentEntry[] | null {
  if (entries === undefined) return null;
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({ ...entry, ...(entry.settings === undefined ? {} : { settings: Object.freeze({ ...entry.settings }) }) }),
    ),
  );
}

/** Loads JSON configuration, failing fast with every validation issue. */
export function loadConfig(source: string | Uint8Array | unknown): RipstreamConfig {
  let value: unknown = source;
  // What JSON.parse accepts silently (a repeated key, absurd nesting) is reported with the other problems.
  let structureIssues: string[] = [];
  if (typeof source === "string" || source instanceof Uint8Array) {
    // One leading byte order mark is skipped, as Jackson does: an editor on Windows writes it. Decoding bytes drops it
    // already; a string keeps it, since a file read as text does.
    const text =
      typeof source === "string"
        ? source.startsWith("\uFEFF")
          ? source.slice(1)
          : source
        : new TextDecoder("utf-8", { fatal: false }).decode(source);
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new RipstreamConfigError([
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    structureIssues = jsonStructureIssues(text);
  }

  const { issues: valueIssues, isolation, parsers, detectors, limits, throwOnWriteLimit, digest, customMimeTypes, server, pipes, notices } = inspectConfig(value);
  const issues = [...structureIssues, ...valueIssues];
  if (issues.length > 0) throw new RipstreamConfigError(issues);
  // Build from the validated copies, never from the caller's object.
  const { version } = value as RipstreamConfigShape;
  return new RipstreamConfig({
    ...(version === undefined ? {} : { version }),
    ...(isolation === undefined ? {} : { isolation }),
    ...(parsers === undefined ? {} : { parsers }),
    ...(detectors === undefined ? {} : { detectors }),
    ...(limits === undefined ? {} : { limits }),
    ...(throwOnWriteLimit === true ? { throwOnWriteLimit } : {}),
    ...(digest === undefined ? {} : { digest }),
    ...(customMimeTypes === undefined ? {} : { customMimeTypes }),
    ...(server === undefined ? {} : { server }),
    ...(pipes === undefined ? {} : { pipes }),
    ...(notices.length === 0 ? {} : { notices }),
  });
}

export function validateConfig(value: unknown): string[] {
  return inspectConfig(value).issues;
}

interface InspectedConfig {
  readonly issues: string[];
  readonly isolation?: IsolationConfig;
  readonly parsers?: readonly ComponentEntry[];
  readonly detectors?: readonly ComponentEntry[];
  readonly limits?: Partial<ParseLimits>;
  readonly throwOnWriteLimit?: boolean;
  readonly digest?: DigestSettings;
  readonly customMimeTypes?: string;
  readonly server?: ServerSettings;
  readonly pipes?: PipesSettings;
  readonly notices: readonly string[];
}

function inspectConfig(value: unknown): InspectedConfig {
  const issues: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { issues: ["configuration root must be a JSON object"], notices: [] };
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (UNAPPLIED_SECTIONS.has(key)) {
      issues.push(`"${key}" is not supported: ripstream would ignore it`);
    } else if (!ALLOWED_ROOT_KEYS.has(key)) {
      issues.push(`unknown top-level key "${key}"`);
    }
  }

  if (record.version !== undefined) {
    if (
      typeof record.version !== "number" ||
      !Number.isInteger(record.version) ||
      record.version < 1
    ) {
      issues.push("version must be a positive integer");
    }
  }

  let isolation: IsolationConfig | undefined;
  const rawIsolation = record.isolation;
  if (rawIsolation !== undefined) {
    const result = inspectIsolation(rawIsolation);
    issues.push(...result.issues);
    if (result.issues.length === 0) isolation = result.isolation;
  }

  const sections: Partial<Record<ComponentSection, readonly ComponentEntry[]>> = {};
  for (const section of ["parsers", "detectors"] as const) {
    const raw = record[section];
    if (raw === undefined) continue;
    const result = parseComponentSection(section, raw);
    issues.push(...result.issues);
    if (result.issues.length === 0) sections[section] = result.entries;
  }

  let limits: Partial<ParseLimits> | undefined;
  let throwOnWriteLimit = false;
  let unpack: UnpackSettings | undefined;
  let digest: DigestSettings | undefined;
  if (record["parse-context"] !== undefined) {
    const result = parseParseContextSection(record["parse-context"]);
    issues.push(...result.issues);
    if (result.issues.length === 0) {
      limits = result.limits;
      throwOnWriteLimit = result.throwOnWriteLimit;
      unpack = result.unpack;
      digest = result.digest;
    }
  }
  let customMimeTypes: string | undefined;
  const rawCustom = record["custom-mimetypes"];
  if (rawCustom !== undefined) {
    if (typeof rawCustom === "string" && rawCustom.length > 0) customMimeTypes = rawCustom;
    else issues.push('"custom-mimetypes" must be the path of a custom-mimetypes.xml, a non-empty string');
  }
  let server: ServerSettings | undefined;
  if (record.server !== undefined) {
    const result = parseServerSection(record.server);
    issues.push(...result.issues);
    if (result.issues.length === 0) server = result.settings;
  }
  const notices: string[] = [];
  if (record["plugin-roots"] !== undefined) {
    if (typeof record["plugin-roots"] === "string") {
      notices.push('"plugin-roots" names where Tika finds its PF4J plugins; ripstream\'s components are built in, so it changes nothing');
    } else issues.push('"plugin-roots" must be a string');
  }
  let pipes: PipesSettings | undefined;
  const pipesResult = parsePipesSections(record);
  issues.push(...pipesResult.issues);
  if (pipesResult.issues.length === 0 && pipesResult.settings !== undefined) {
    // UNPACK mode's settings live in the parse-context section but only pipes uses them.
    // The digester factory is the same: it is a parse-context setting, and NO_PARSE is where pipes needs it.
    pipes = { ...pipesResult.settings, ...(unpack === undefined ? {} : { unpack }), ...(digest === undefined ? {} : { digest }) };
    notices.push(...pipes.notices);
  } else if (unpack !== undefined && pipesResult.issues.length === 0) {
    notices.push('"parse-context" unpack-config says what pipes\' UNPACK mode emits; the configuration has no pipes sections, so it changes nothing');
  }
  return {
    issues,
    notices,
    ...(isolation === undefined ? {} : { isolation }),
    ...(sections.parsers === undefined ? {} : { parsers: sections.parsers }),
    ...(sections.detectors === undefined ? {} : { detectors: sections.detectors }),
    ...(limits === undefined ? {} : { limits }),
    ...(throwOnWriteLimit ? { throwOnWriteLimit } : {}),
    ...(digest === undefined ? {} : { digest }),
    ...(customMimeTypes === undefined ? {} : { customMimeTypes }),
    ...(server === undefined ? {} : { server }),
    ...(pipes === undefined ? {} : { pipes }),
  };
}

/**
 * Reads the caller's object exactly once: own enumerable data properties are
 * copied into a plain object, and only that copy is validated and returned
 * (the issues list is empty exactly when the copy is valid). Inherited
 * properties, accessors and proxy traps therefore cannot show validation one
 * value and the loaded config another.
 */
function inspectIsolation(value: unknown): {
  issues: string[];
  isolation: IsolationConfig;
} {
  const issues: string[] = [];
  const copy: Record<string, unknown> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push("isolation must be an object");
    return { issues, isolation: copy as unknown as IsolationConfig };
  }

  for (const key of Object.keys(value)) {
    if (!ISOLATION_KEYS.has(key)) {
      issues.push(`unknown key "${key}" in isolation`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      issues.push(`isolation.${key} must be a plain data property`);
      continue;
    }
    copy[key] = descriptor.value;
  }

  const mode = copy.mode;
  if (typeof mode !== "string" || !ISOLATION_MODES.includes(mode)) {
    issues.push(`isolation.mode must be one of ${ISOLATION_MODES.join(", ")}`);
  }
  const strict = copy.requireStrictContainment;
  if (strict !== undefined && typeof strict !== "boolean") {
    issues.push("isolation.requireStrictContainment must be a boolean");
  } else if (strict === true && mode !== "strict") {
    issues.push("isolation.requireStrictContainment requires isolation.mode to be strict");
  }
  for (const key of Object.keys(ISOLATION_NUMBER_BOUNDS) as Array<
    keyof typeof ISOLATION_NUMBER_BOUNDS
  >) {
    const number = copy[key];
    if (number === undefined) continue;
    const [min, max] = ISOLATION_NUMBER_BOUNDS[key];
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      Object.is(number, -0) ||
      number < min ||
      number > max
    ) {
      issues.push(`isolation.${key} must be an integer from ${min} to ${max}`);
    }
  }

  const pool = copy.memoryPoolMb;
  const child = copy.perChildMb;
  const heap = copy.heapMb;
  if (isValidNumber(pool, "memoryPoolMb") && isValidNumber(child, "perChildMb") && child > pool) {
    issues.push("isolation.perChildMb must not exceed isolation.memoryPoolMb");
  }
  if (isValidNumber(child, "perChildMb") && isValidNumber(heap, "heapMb") && heap > child) {
    issues.push("isolation.heapMb must not exceed isolation.perChildMb");
  }
  return { issues, isolation: Object.freeze(copy) as unknown as IsolationConfig };
}

function isValidNumber(
  value: unknown,
  key: keyof typeof ISOLATION_NUMBER_BOUNDS,
): value is number {
  const [min, max] = ISOLATION_NUMBER_BOUNDS[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Cache key that changes whenever any configuration is loaded. */
export function configGeneration(): number {
  return generationCounter;
}
