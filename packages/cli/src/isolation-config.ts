import { validateConfig, type IsolationConfig, type IsolationMode, type IsolationReuseConfig } from "@spikedpunch/ripstream-core";
import { WORKERS_VARIABLE } from "./workers-config.ts";

/** Where the effective isolation mode came from (shown in the startup log). */
export type IsolationSource = "default" | "config" | "env" | "flag";

export interface ResolvedIsolation {
  /** Without `reuse`, which the isolator takes as an option of its own: see `reuse`. */
  readonly config: IsolationConfig;
  readonly modeSource: IsolationSource;
  /** Reuse of children, when something switched it on and a trust domain was named; absent (the default) otherwise. */
  readonly reuse?: IsolationReuseConfig & { readonly enabled: true; readonly trustDomain: string };
  /** Where `reuse` was switched on; present with it. */
  readonly reuseSource?: "flag" | "env" | "config";
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
/** Read by `bin/ripstream.js` before the CLI loads, not by the CLI: any value but "" or "0" runs `dist` instead of the bundle. */
const NO_BUNDLE_VARIABLE = "RIPSTREAM_NO_BUNDLE";

const REUSE_VARIABLE = "RIPSTREAM_ISOLATION_REUSE";
const REUSE_TRUST_DOMAIN_VARIABLE = "RIPSTREAM_ISOLATION_REUSE_TRUST_DOMAIN";
const REUSE_NUMBER_VARIABLES = [
  ["RIPSTREAM_ISOLATION_REUSE_MAX_REQUESTS", "maxRequests"],
  ["RIPSTREAM_ISOLATION_REUSE_RSS_CEILING_MB", "rssCeilingMb"],
  ["RIPSTREAM_ISOLATION_REUSE_RSS_SAMPLE_EVERY", "rssSampleEvery"],
  ["RIPSTREAM_ISOLATION_REUSE_IDLE_TIMEOUT_MS", "idleTimeoutMs"],
  ["RIPSTREAM_ISOLATION_REUSE_MAX_IDLE_CHILDREN", "maxIdleChildren"],
  ["RIPSTREAM_ISOLATION_REUSE_MAX_TRUST_DOMAINS", "maxTrustDomains"],
] as const;

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
  WORKERS_VARIABLE,
  NO_BUNDLE_VARIABLE,
  REUSE_VARIABLE,
  REUSE_TRUST_DOMAIN_VARIABLE,
  ...NUMBER_VARIABLES.map(([variable]) => variable),
  ...REUSE_NUMBER_VARIABLES.map(([variable]) => variable),
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
  /** `--isolation-reuse <trust-domain>`: switches reuse on for that domain. */
  readonly flagReuseTrustDomain?: string | null;
  /** `--isolation-reuse-max-requests <n>` as typed. */
  readonly flagReuseMaxRequests?: string | null;
  /** The command parses many documents (serve, pipes). For the others a reuse flag is refused and the variables are ignored. */
  readonly reuseApplies?: boolean;
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

  const { reuse: fileReuse, ...fileRest } = fileIsolation ?? ({} as IsolationConfig);
  const merged: Record<string, unknown> = { ...fileRest, mode };
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
  return { config: merged as unknown as IsolationConfig, modeSource, ...resolveReuse(input, fileReuse, mode) };
}

/**
 * Child reuse (docs/isolation.md, "Reusing children"), off unless something switches it on: `--isolation-reuse
 * <trust-domain>` (which also names the domain), RIPSTREAM_ISOLATION_REUSE=true, or the file's `isolation.reuse.enabled`;
 * the flag wins over the variable, which wins over the file, and `false` in a variable switches a file's `true` off.
 * Every other setting: its RIPSTREAM_ISOLATION_REUSE_* variable (`--isolation-reuse-max-requests` for maxRequests), else
 * the file. A trust domain is required, and a mode of `off` has no children to reuse: both are refused here with what to
 * do, as are settings given to a command that has no use for them. A file that enables reuse and is read by such a
 * command, or with the mode off by default, is the operator's one file for several commands, and is left alone.
 */
function resolveReuse(
  input: {
    readonly flagReuseTrustDomain?: string | null;
    readonly flagReuseMaxRequests?: string | null;
    readonly reuseApplies?: boolean;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
  fileReuse: IsolationReuseConfig | undefined,
  mode: IsolationMode,
): Pick<ResolvedIsolation, "reuse" | "reuseSource"> {
  const { env } = input;
  const flagDomain = input.flagReuseTrustDomain ?? null;
  const flagMaxRequests = input.flagReuseMaxRequests ?? null;
  const flagGiven = flagDomain !== null || flagMaxRequests !== null;
  if (!(input.reuseApplies ?? true)) {
    // The variables are ignored here, as RIPSTREAM_WORKERS is by a command that parses one document; a flag is not.
    if (flagGiven) throw new IsolationSettingsError("--isolation-reuse and --isolation-reuse-max-requests apply to serve and pipes, which parse many documents");
    return {};
  }
  const envEnabled = env[REUSE_VARIABLE] === undefined ? undefined : parseBoolean(env[REUSE_VARIABLE], REUSE_VARIABLE);
  let reuseSource: "flag" | "env" | "config" | null = null;
  if (fileReuse?.enabled === true) reuseSource = "config";
  if (envEnabled === true) reuseSource = "env";
  if (envEnabled === false) reuseSource = null;
  if (flagDomain !== null) reuseSource = "flag";
  if (reuseSource === null) {
    // Off. A flag or variable that sets a detail of what is off is a mistake, not a setting.
    const detail = [REUSE_TRUST_DOMAIN_VARIABLE, ...REUSE_NUMBER_VARIABLES.map(([variable]) => variable)].find((variable) => env[variable] !== undefined);
    if (flagMaxRequests !== null || (detail !== undefined && envEnabled !== false)) {
      throw new IsolationSettingsError(
        `${flagMaxRequests !== null ? "--isolation-reuse-max-requests" : detail} is given but reuse is not switched on: use --isolation-reuse <trust-domain> or RIPSTREAM_ISOLATION_REUSE=true`,
      );
    }
    return {};
  }
  const from = { flag: "--isolation-reuse", env: REUSE_VARIABLE, config: "isolation.reuse.enabled" }[reuseSource];
  if (mode === "off") {
    throw new IsolationSettingsError(`${from} needs isolation: there are no children to reuse while the isolation mode is off (use --isolation strict or lenient)`);
  }
  const merged: Record<string, unknown> = { ...(fileReuse ?? {}), enabled: true };
  for (const [variable, key] of REUSE_NUMBER_VARIABLES) {
    if (env[variable] !== undefined) merged[key] = parseInteger(env[variable], variable);
  }
  if (flagMaxRequests !== null) merged.maxRequests = parseInteger(flagMaxRequests, "--isolation-reuse-max-requests");
  if (env[REUSE_TRUST_DOMAIN_VARIABLE] !== undefined) merged.trustDomain = env[REUSE_TRUST_DOMAIN_VARIABLE];
  if (flagDomain !== null) merged.trustDomain = flagDomain;
  const domain = merged.trustDomain;
  if (typeof domain !== "string" || domain.length === 0 || domain.length > 256) {
    throw new IsolationSettingsError(
      `${from} needs a trust domain, a non-empty name of at most 256 characters for who owns the documents that may share a child: ` +
        "--isolation-reuse <trust-domain>, RIPSTREAM_ISOLATION_REUSE_TRUST_DOMAIN or isolation.reuse.trustDomain",
    );
  }
  const issues = validateConfig({ isolation: { mode, reuse: merged } });
  if (issues.length > 0) throw new IsolationSettingsError(`Invalid isolation settings: ${issues.join("; ")}`);
  return { reuse: merged as unknown as NonNullable<ResolvedIsolation["reuse"]>, reuseSource };
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
