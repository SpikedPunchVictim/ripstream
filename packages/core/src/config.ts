import { parseComponentSection, type ComponentEntry, type ComponentSection } from "./component-config.ts";
import type { IsolationConfig } from "./isolation.ts";
import { jsonStructureIssues } from "./json-structure.ts";

export interface RipstreamConfigShape {
  readonly version?: number;
  readonly isolation?: IsolationConfig;
  /** The `parsers` section, already read into entries by `loadConfig`. */
  readonly parsers?: readonly ComponentEntry[];
  /** The `detectors` section, already read into entries by `loadConfig`. */
  readonly detectors?: readonly ComponentEntry[];
}

const ALLOWED_ROOT_KEYS = new Set(["version", "isolation", "parsers", "detectors"]);

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

  constructor(shape: RipstreamConfigShape = {}) {
    this.generation = ++generationCounter;
    this.version = shape.version ?? 1;
    this.isolation =
      shape.isolation === undefined ? null : Object.freeze({ ...shape.isolation });
    this.parsers = freezeEntries(shape.parsers);
    this.detectors = freezeEntries(shape.detectors);
  }

  get current(): boolean {
    return this.generation === generationCounter;
  }
}

function freezeEntries(entries: readonly ComponentEntry[] | undefined): readonly ComponentEntry[] | null {
  return entries === undefined ? null : Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

/** Loads JSON configuration, failing fast with every validation issue. */
export function loadConfig(source: string | Uint8Array | unknown): RipstreamConfig {
  let value: unknown = source;
  // What JSON.parse accepts silently (a repeated key, absurd nesting) is reported with the other problems.
  let structureIssues: string[] = [];
  if (typeof source === "string" || source instanceof Uint8Array) {
    const text =
      typeof source === "string"
        ? source
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

  const { issues: valueIssues, isolation, parsers, detectors } = inspectConfig(value);
  const issues = [...structureIssues, ...valueIssues];
  if (issues.length > 0) throw new RipstreamConfigError(issues);
  // Build from the validated copies, never from the caller's object.
  const { version } = value as RipstreamConfigShape;
  return new RipstreamConfig({
    ...(version === undefined ? {} : { version }),
    ...(isolation === undefined ? {} : { isolation }),
    ...(parsers === undefined ? {} : { parsers }),
    ...(detectors === undefined ? {} : { detectors }),
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
}

function inspectConfig(value: unknown): InspectedConfig {
  const issues: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { issues: ["configuration root must be a JSON object"] };
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
  return {
    issues,
    ...(isolation === undefined ? {} : { isolation }),
    ...(sections.parsers === undefined ? {} : { parsers: sections.parsers }),
    ...(sections.detectors === undefined ? {} : { detectors: sections.detectors }),
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
