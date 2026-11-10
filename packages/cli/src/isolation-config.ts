import { validateConfig, type IsolationConfig, type IsolationMode } from "@spikedpunch/ripstream-core";

/** Where the effective isolation mode came from (shown in the startup log). */
export type IsolationSource = "default" | "config" | "env" | "flag";

export interface ResolvedIsolation {
  readonly config: IsolationConfig;
  readonly modeSource: IsolationSource;
}

/** A bad flag, environment variable or config value. The CLI reports it as a usage error. */
export class IsolationSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationSettingsError";
  }
}

const MODES: readonly IsolationMode[] = ["strict", "lenient", "off"];

const MODE_VARIABLE = "RIPSTREAM_ISOLATION";
const STRICT_CONTAINMENT_VARIABLE = "RIPSTREAM_ISOLATION_REQUIRE_STRICT_CONTAINMENT";
const MAX_OUTPUT_CHARS_VARIABLE = "RIPSTREAM_MAX_OUTPUT_CHARS";

const NUMBER_VARIABLES = [
  ["RIPSTREAM_ISOLATION_MEMORY_POOL_MB", "memoryPoolMb"],
  ["RIPSTREAM_ISOLATION_PER_CHILD_MB", "perChildMb"],
  ["RIPSTREAM_ISOLATION_MAX_INPUT_BYTES", "maxInputBytes"],
  ["RIPSTREAM_ISOLATION_MAX_TASK_MILLIS", "maxTaskMillis"],
  ["RIPSTREAM_ISOLATION_HEAP_MB", "heapMb"],
  ["RIPSTREAM_ISOLATION_MAX_QUEUE", "maxQueue"],
  ["RIPSTREAM_ISOLATION_MAX_DISK_MB", "maxDiskMb"],
] as const;

/** Every RIPSTREAM_* name the CLI reads. A name outside this list (and TEST_ONLY_VARIABLES) is a mistake. */
const KNOWN_VARIABLES: readonly string[] = [
  MODE_VARIABLE,
  STRICT_CONTAINMENT_VARIABLE,
  MAX_OUTPUT_CHARS_VARIABLE,
  ...NUMBER_VARIABLES.map(([variable]) => variable),
];

/** Read by the test suite (packages/parser-pdf/test/pdf.test.ts), never by the CLI, and often set in the same shell. */
const TEST_ONLY_VARIABLES: readonly string[] = ["RIPSTREAM_PDFJS_CORPUS"];

/** The most single-character edits between a misspelling and the name it is offered as a correction of. */
const MAX_SUGGESTION_DISTANCE = 3;

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    for (let column = 1; column <= b.length; column++) {
      const substitution = previous[column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1);
      current.push(Math.min(substitution, previous[column]! + 1, current[column - 1]! + 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

function nearestKnownVariable(name: string): string | null {
  let best: string | null = null;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  for (const candidate of KNOWN_VARIABLES) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Refuses a RIPSTREAM_* variable that is not a setting. A misspelled name used to be ignored, so the setting it was
 * meant to be fell back to its default, which for a limit is not the limit that was asked for. Each unknown name is
 * listed with the nearest real one.
 */
export function assertKnownVariables(env: Readonly<Record<string, string | undefined>>): void {
  const unknown = Object.keys(env)
    .filter((name) => name.startsWith("RIPSTREAM_") && !KNOWN_VARIABLES.includes(name) && !TEST_ONLY_VARIABLES.includes(name))
    .sort();
  if (unknown.length === 0) return;
  const described = unknown.map((name) => {
    const suggestion = nearestKnownVariable(name);
    return suggestion === null ? name : `${name} (did you mean ${suggestion}?)`;
  });
  const noun = unknown.length === 1 ? "variable" : "variables";
  throw new IsolationSettingsError(
    `unknown environment ${noun}: ${described.join(", ")}. The settings are ${KNOWN_VARIABLES.join(", ")}`,
  );
}

function parseMode(value: string, where: string): IsolationMode {
  const mode = MODES.find((candidate) => candidate === value);
  if (mode === undefined) throw new IsolationSettingsError(`${where} expects strict, lenient or off, got "${value}"`);
  return mode;
}

function parseInteger(value: string, where: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new IsolationSettingsError(`${where} expects a non-negative integer, got "${value}"`);
  }
  return Number(value);
}

function parseBoolean(value: string, where: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new IsolationSettingsError(`${where} expects true or false, got "${value}"`);
}

/**
 * The effective isolation settings of one CLI invocation.
 *
 * Mode: `--isolation` flag, else RIPSTREAM_ISOLATION, else the config file's `isolation.mode`, else `defaultMode`
 * (the command decides: `serve` is strict, one-shot commands are off). Every other field: its
 * RIPSTREAM_ISOLATION_* variable, else the config file. The merged result is validated with core's rules, so the
 * limits are the same whether they came from a file or from the environment. `requireStrictContainment` is dropped
 * when the mode in force is not strict.
 *
 * Request parameters never reach this function: isolation is fixed when the process starts.
 */
export function resolveIsolationConfig(input: {
  readonly defaultMode: IsolationMode;
  readonly flagMode: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fileIsolation: IsolationConfig | null;
}): ResolvedIsolation {
  const { env, fileIsolation } = input;
  let mode: IsolationMode = input.defaultMode;
  let modeSource: IsolationSource = "default";
  if (fileIsolation !== null) {
    mode = fileIsolation.mode;
    modeSource = "config";
  }
  if (env[MODE_VARIABLE] !== undefined) {
    mode = parseMode(env[MODE_VARIABLE], MODE_VARIABLE);
    modeSource = "env";
  }
  if (input.flagMode !== null) {
    mode = parseMode(input.flagMode, "--isolation");
    modeSource = "flag";
  }

  const merged: Record<string, unknown> = { ...(fileIsolation ?? {}), mode };
  for (const [variable, key] of NUMBER_VARIABLES) {
    const raw = env[variable];
    if (raw !== undefined) merged[key] = parseInteger(raw, variable);
  }
  const strictRaw = env[STRICT_CONTAINMENT_VARIABLE];
  if (strictRaw !== undefined) {
    merged.requireStrictContainment = parseBoolean(strictRaw, STRICT_CONTAINMENT_VARIABLE);
  }

  // requireStrictContainment is a refinement of strict. When flag or environment lowered the mode, it has nothing to
  // refine: drop it rather than fail on a leftover setting from a lower-precedence source.
  if (mode !== "strict") delete merged.requireStrictContainment;

  const issues = validateConfig({ isolation: merged });
  if (issues.length > 0) throw new IsolationSettingsError(`Invalid isolation settings: ${issues.join("; ")}`);
  return { config: merged as unknown as IsolationConfig, modeSource };
}

/** The server-side `maxOutputChars` ceiling: `--max-output-chars`, else RIPSTREAM_MAX_OUTPUT_CHARS, else null. */
export function resolveMaxOutputChars(input: {
  readonly flag: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
}): number | null {
  const [raw, where] =
    input.flag !== null ? [input.flag, "--max-output-chars"] : [input.env[MAX_OUTPUT_CHARS_VARIABLE], MAX_OUTPUT_CHARS_VARIABLE];
  if (raw === undefined) return null;
  const value = parseInteger(raw, where);
  if (value < 1) throw new IsolationSettingsError(`${where} expects a positive integer, got "${raw}"`);
  return value;
}
