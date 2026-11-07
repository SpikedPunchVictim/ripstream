export interface ComponentConfig {
  readonly class: string;
  readonly [key: string]: unknown;
}

export interface RipstreamConfigShape {
  readonly version?: number;
  readonly parsers?: readonly ComponentConfig[];
  readonly detectors?: readonly ComponentConfig[];
  readonly contentHandlers?: readonly ComponentConfig[];
  readonly metadataFilters?: readonly ComponentConfig[];
  readonly encodingDetector?: ComponentConfig;
}

const ALLOWED_ROOT_KEYS = new Set([
  "version",
  "parsers",
  "detectors",
  "contentHandlers",
  "metadataFilters",
  "encodingDetector",
]);

const COMPONENT_LIST_KEYS = [
  "parsers",
  "detectors",
  "contentHandlers",
  "metadataFilters",
] as const;

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
  readonly parsers: readonly ComponentConfig[];
  readonly detectors: readonly ComponentConfig[];
  readonly contentHandlers: readonly ComponentConfig[];
  readonly metadataFilters: readonly ComponentConfig[];
  readonly encodingDetector: ComponentConfig | null;

  constructor(shape: RipstreamConfigShape = {}) {
    this.generation = ++generationCounter;
    this.version = shape.version ?? 1;
    this.parsers = Object.freeze([...(shape.parsers ?? [])]);
    this.detectors = Object.freeze([...(shape.detectors ?? [])]);
    this.contentHandlers = Object.freeze([...(shape.contentHandlers ?? [])]);
    this.metadataFilters = Object.freeze([...(shape.metadataFilters ?? [])]);
    this.encodingDetector = shape.encodingDetector ?? null;
  }

  get current(): boolean {
    return this.generation === generationCounter;
  }
}

/** Loads JSON configuration, failing fast with every validation issue. */
export function loadConfig(source: string | Uint8Array | unknown): RipstreamConfig {
  let value: unknown = source;
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
  }

  const issues = validateConfig(value);
  if (issues.length > 0) throw new RipstreamConfigError(issues);
  return new RipstreamConfig(value as RipstreamConfigShape);
}

export function validateConfig(value: unknown): string[] {
  const issues: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["configuration root must be a JSON object"];
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) {
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

  for (const key of COMPONENT_LIST_KEYS) {
    const list = record[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      issues.push(`${key} must be an array`);
      continue;
    }
    list.forEach((component, index) => {
      issues.push(...validateComponent(`${key}[${index}]`, component));
    });
  }

  if (record.encodingDetector !== undefined) {
    issues.push(
      ...validateComponent("encodingDetector", record.encodingDetector),
    );
  }
  return issues;
}

function validateComponent(path: string, value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${path} must be an object`];
  }
  const component = value as Record<string, unknown>;
  if (typeof component.class !== "string" || component.class.trim().length === 0) {
    return [`${path}.class must be a non-empty string`];
  }
  return [];
}

/** Cache key that changes whenever any configuration is loaded. */
export function configGeneration(): number {
  return generationCounter;
}

/** Minimal 3.x XML config loader: parser/detector/encodingDetector class entries. */
export function loadXmlConfig(xml: string): RipstreamConfig {
  if (!/<properties[\s>]/.test(xml) && !/<ripstream-config[\s>]/.test(xml)) {
    throw new RipstreamConfigError(["XML configuration root is not <properties>"]);
  }
  const component = (tag: string): ComponentConfig[] => {
    const regex = new RegExp(
      `<${tag}[^>]*\\bclass\\s*=\\s*["']([^"']+)["'][^>]*>`,
      "gi",
    );
    const result: ComponentConfig[] = [];
    for (const match of xml.matchAll(regex)) {
      if (match[1] !== undefined) result.push({ class: match[1] });
    }
    return result;
  };
  const encoding = /<encodingDetector[^>]*\bclass\s*=\s*["']([^"']+)["']/i.exec(xml);
  return new RipstreamConfig({
    version: 1,
    parsers: component("parser"),
    detectors: component("detector"),
    ...(encoding?.[1] === undefined
      ? {}
      : { encodingDetector: { class: encoding[1] } }),
  });
}
