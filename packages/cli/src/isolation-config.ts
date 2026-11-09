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

const NUMBER_VARIABLES = [
  ["RIPSTREAM_ISOLATION_MEMORY_POOL_MB", "memoryPoolMb"],
  ["RIPSTREAM_ISOLATION_PER_CHILD_MB", "perChildMb"],
  ["RIPSTREAM_ISOLATION_MAX_INPUT_BYTES", "maxInputBytes"],
  ["RIPSTREAM_ISOLATION_MAX_TASK_MILLIS", "maxTaskMillis"],
  ["RIPSTREAM_ISOLATION_HEAP_MB", "heapMb"],
  ["RIPSTREAM_ISOLATION_MAX_QUEUE", "maxQueue"],
  ["RIPSTREAM_ISOLATION_MAX_DISK_MB", "maxDiskMb"],
] as const;

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
  if (env.RIPSTREAM_ISOLATION !== undefined) {
    mode = parseMode(env.RIPSTREAM_ISOLATION, "RIPSTREAM_ISOLATION");
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
  const strictRaw = env.RIPSTREAM_ISOLATION_REQUIRE_STRICT_CONTAINMENT;
  if (strictRaw !== undefined) {
    merged.requireStrictContainment = parseBoolean(strictRaw, "RIPSTREAM_ISOLATION_REQUIRE_STRICT_CONTAINMENT");
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
    input.flag !== null ? [input.flag, "--max-output-chars"] : [input.env.RIPSTREAM_MAX_OUTPUT_CHARS, "RIPSTREAM_MAX_OUTPUT_CHARS"];
  if (raw === undefined) return null;
  const value = parseInteger(raw, where);
  if (value < 1) throw new IsolationSettingsError(`${where} expects a positive integer, got "${raw}"`);
  return value;
}
