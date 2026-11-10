import { assertValidLimits, RipstreamConfigError, type ParseLimits } from "@spikedpunch/ripstream-core";

export const PIPE_MODES = ["CONTENT_ONLY", "CONCATENATE", "RMETA", "NO_PARSE", "UNPACK"] as const;

const ROOT_KEYS = new Set(["mode", "concurrency", "maxQueue", "ordered", "source", "sink", "followSymlinks"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveInteger = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const isNonEmptyString = (value: unknown): boolean => typeof value === "string" && value.length > 0;

function unknownKeys(object: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): string[] {
  return Object.keys(object)
    .filter((key) => !allowed.has(key))
    .map((key) => `unknown key "${key}"${where === "" ? "" : ` in ${where}`}`);
}

function modeIssue(value: unknown): string | null {
  return PIPE_MODES.includes(value as never) ? null : `mode must be one of ${PIPE_MODES.join(", ")}`;
}

/**
 * Everything wrong with a pipes configuration, as messages naming the key. Unknown keys, a `source.type` or
 * `sink.type` the engine does not implement, and values of the wrong kind used to be dropped, coerced or silently
 * treated as the filesystem; they are refused instead.
 */
export function validatePipesConfig(config: unknown): string[] {
  if (!isObject(config)) return ["configuration must be an object"];
  const issues = unknownKeys(config, ROOT_KEYS, "");

  if (config.mode !== undefined) {
    const issue = modeIssue(config.mode);
    if (issue !== null) issues.push(issue);
  }
  for (const key of ["concurrency", "maxQueue"] as const) {
    if (config[key] !== undefined && !isPositiveInteger(config[key])) {
      issues.push(`${key} must be a positive integer, got ${String(config[key])}`);
    }
  }
  for (const key of ["ordered", "followSymlinks"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") issues.push(`${key} must be a boolean`);
  }

  issues.push(...sourceIssues(config.source));
  if (config.sink !== undefined) issues.push(...sinkIssues(config.sink));
  return issues;
}

function sourceIssues(source: unknown): string[] {
  if (source === undefined) return ["source is required"];
  if (!isObject(source)) return ["source must be an object"];
  if (source.type === "filesystem") {
    const issues = unknownKeys(source, new Set(["type", "path"]), "source");
    if (source.path !== undefined && !isNonEmptyString(source.path)) issues.push("source.path must be a non-empty string");
    return issues;
  }
  if (source.type === "http") {
    const issues = unknownKeys(source, new Set(["type", "urls"]), "source");
    if (
      source.urls !== undefined &&
      !(Array.isArray(source.urls) && source.urls.every((url) => typeof url === "string"))
    ) {
      issues.push("source.urls must be an array of strings");
    }
    return issues;
  }
  return [`source.type must be "filesystem" or "http", got ${String(source.type)}`];
}

function sinkIssues(sink: unknown): string[] {
  if (!isObject(sink)) return ["sink must be an object"];
  const issues = unknownKeys(sink, new Set(["type", "path"]), "sink");
  if (sink.type !== "filesystem") issues.push(`sink.type must be "filesystem", got ${String(sink.type)}`);
  if (!isNonEmptyString(sink.path)) issues.push("sink.path must be a non-empty string");
  return issues;
}

/** Throws a RipstreamConfigError listing every issue. */
export function assertValidPipesConfig(config: unknown): void {
  const issues = validatePipesConfig(config);
  if (issues.length > 0) throw new RipstreamConfigError(issues);
}

/** The options a PipesEngine runs on, checked where a `Math.max(1, NaN)` would otherwise leave it with no workers. */
export function assertValidEngineOptions(options: {
  readonly mode?: unknown;
  readonly concurrency?: unknown;
  readonly maxQueue?: unknown;
  readonly maxBuffered?: unknown;
  readonly ordered?: unknown;
  readonly limits?: Partial<ParseLimits> | undefined;
}): void {
  const issues: string[] = [];
  if (options.mode !== undefined) {
    const issue = modeIssue(options.mode);
    if (issue !== null) issues.push(issue);
  }
  for (const key of ["concurrency", "maxQueue", "maxBuffered"] as const) {
    if (options[key] !== undefined && !isPositiveInteger(options[key])) {
      issues.push(`${key} must be a positive integer, got ${String(options[key])}`);
    }
  }
  if (options.ordered !== undefined && typeof options.ordered !== "boolean") issues.push("ordered must be a boolean");
  if (issues.length > 0) throw new RangeError(`invalid pipes options: ${issues.join("; ")}`);
  assertValidLimits(options.limits);
}
