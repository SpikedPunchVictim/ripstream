import { stat } from "node:fs/promises";
import { totalmem } from "node:os";
import { isAbsolute } from "node:path";
import {
  AbortError,
  DEFAULT_LIMITS,
  IsolationError,
  LimitExceededError,
  ParseTimeoutError,
  validateConfig,
  type IsolatedParseRecord,
  type IsolatedParseRequest,
  type IsolatedParseResult,
  type IsolationConfig,
  type IsolationMode,
  type Metadata,
  type ParseIsolator,
  type ParseLimits,
  type ParseOptions,
  type ParseRecord,
  type Ripstream,
} from "@spikedpunch/ripstream-core";
import { defaultPoolMb, readCgroupLimits, validatePoolAgainstCgroup } from "./cgroup.ts";
import type { Containment } from "./containment.ts";
import { requireTempDir } from "./disk.ts";
import { deriveLimits, type DerivedLimits } from "./limits.ts";
import { DEFAULT_OVERSHOOT_MB, MemoryPool, type PoolStats } from "./pool.ts";
import { probeIsolation } from "./probe.ts";
import { DEFAULT_IN_PROCESS_MAX_BYTES, DEFAULT_IN_PROCESS_TYPES, routeRequest } from "./routing.ts";
import { ChildRunner, parentResultMb, type ChildRunnerOptions } from "./runner.ts";

/**
 * The parent-side isolation facade (`ParseIsolator` from core) for Node: routes each request to an in-process parse
 * or to a supervised child, and answers with the child's result unchanged.
 *
 * The decision "do we isolate at all" is taken ONCE, in `createNodeIsolator`, and never again:
 *   off      passthrough; never spawns anything.
 *   strict   probe once; unavailable (or `requireStrictContainment` unmet) rejects construction.
 *   lenient  probe once; unavailable returns a DEGRADED isolator that parses everything in-process, logs a WARN and
 *            says so in `status()`.
 * Once constructed as isolating, every `isolate()` either runs in a child or throws. There is NO per-call
 * fallback: a spawn failure, a crash, a full queue, a disposed runner are errors for that call, never a reason to
 * parse the (hostile) bytes in this process. The only requests parsed in-process are those the routing allowlist
 * names (routing.ts) and, for a degraded or `off` isolator, everything.
 */

/** What the facade needs from a Ripstream. The core class satisfies it; tests pass scripted stand-ins. */
export type IsolatorRipstream = Pick<Ripstream, "detect" | "parse" | "parseRecursive">;

export type IsolatorLogLevel = "info" | "warn";

/** Runner knobs the composition root (or a test) may set. The limits derived from the config cannot be overridden. */
export type IsolatorRunnerOptions = Pick<
  ChildRunnerOptions,
  | "execArgv"
  | "vmemKb"
  | "pollMs"
  | "diskPollMs"
  | "readyTimeoutMs"
  | "graceMs"
  | "maxFrames"
  | "stderrBudgetBytes"
  | "disposeWaitMs"
  | "parentEnv"
  | "onRunSettled"
  | "onTempCleanupError"
  | "spawnFn"
  | "reapWaitMs"
>;

export interface NodeIsolatorOptions {
  /** Copied and frozen at construction; later changes to the caller's object have no effect. */
  readonly config: IsolationConfig;
  /**
   * Used for detection (routing), and for the in-process path unless `inProcessRipstream` is given. Only
   * `detect`, `parse` and `parseRecursive` are called.
   */
  readonly ripstream: IsolatorRipstream;
  /**
   * Parses the requests that stay in this process (allowlisted types, and everything for an `off` or degraded
   * isolator). It re-detects on the whole input, so the composition root should pass a Ripstream restricted to the
   * parsers behind the allowlist (see routing.ts, "Polyglot risk"). Default: `ripstream`.
   */
  readonly inProcessRipstream?: IsolatorRipstream;
  /** Absolute path of the child entry script. Not used (or checked) when the mode is `off`. */
  readonly childModule: string;
  readonly childArgs?: readonly string[];
  readonly nodePath?: string;
  /**
   * Where each call's private directory (the child's TMPDIR) is made, and where the probe makes its own. Absolute and
   * existing, or construction throws. Default os.tmpdir(). Every call's directory is removed when its child is gone;
   * a removal that fails is logged as a warning (or reaches `runner.onTempCleanupError`). Library-only: the CLI and
   * the server expose no such setting.
   */
  readonly tempDir?: string;
  /**
   * The memory gate. Pass one pool to every isolator in the process so they share it; this isolator disposes a
   * pool it created, never one it was given. A given pool decides: `config.memoryPoolMb` and `config.maxQueue`
   * are then ignored (with a warning). Default: a pool sized from the cgroup limit / host memory, or from
   * `config.memoryPoolMb`.
   */
  readonly pool?: MemoryPool;
  /** Exact base media types parsed in-process. Default DEFAULT_IN_PROCESS_TYPES. Copied at construction. */
  readonly inProcessTypes?: ReadonlySet<string>;
  /** Inputs above this are isolated whatever their type. Default DEFAULT_IN_PROCESS_MAX_BYTES. */
  readonly inProcessMaxBytes?: number;
  /** Per-request detection budget in ms. Default DEFAULT_DETECT_TIMEOUT_MS. */
  readonly detectTimeoutMs?: number;
  /**
   * The output cap of a default request, and of any request that names none. `status().limits`,
   * `defaultReservationMb` and the check that the pool can hold one child all derive from it, so a caller that
   * enforces a larger ceiling (a server's `maxLimits.maxOutputChars`) passes it here and finds out at construction,
   * not on every request, that the pool is too small for it. Default: core's `DEFAULT_LIMITS.maxOutputChars`.
   */
  readonly defaultMaxOutputChars?: number;
  /** Default: warnings go to console.warn, the rest is dropped. */
  readonly log?: (level: IsolatorLogLevel, message: string) => void;
  /** @internal Test seam: replaces the availability probe. */
  readonly probe?: typeof probeIsolation;
  /** Target platform for the probe and the strict-containment rule. Default process.platform. */
  readonly platform?: NodeJS.Platform;
  readonly runner?: IsolatorRunnerOptions;
}

/** Plain, JSON-serialisable: the shape the server shows on /status. */
export interface NodeIsolatorStatus {
  /** The mode in force. A lenient isolator that found isolation unavailable reports "off". */
  readonly mode: IsolationMode;
  readonly configuredMode: IsolationMode;
  /** The configured mode could not be honoured at construction and everything is parsed in-process. */
  readonly degraded: boolean;
  /** Why, when `degraded`. */
  readonly degradedReason: string | null;
  readonly disposed: boolean;
  /** What the probe showed this platform enforces; null unless isolating. */
  readonly containment: Containment | null;
  readonly requireStrictContainment: boolean;
  /** The memory gate (shared by every isolator that was given the same pool); null unless isolating. */
  readonly pool: PoolStats | null;
  /** Children whose caller was answered but that the kernel has not reaped. Should be 0. */
  readonly unreapedChildren: number;
  /** Derived limits of a default request (text output, default output cap); null unless isolating. */
  readonly limits: DerivedLimits | null;
  /**
   * Pool MiB one default request reserves (child + overshoot + parent copy of the result), per output kind; null
   * unless isolating. A kind above `pool.poolMb` can never run: every such request is refused as a limit error.
   */
  readonly defaultReservationMb: { readonly text: number; readonly records: number } | null;
  readonly maxInputBytes: number;
  readonly inProcessTypes: readonly string[];
  readonly inProcessMaxBytes: number;
}

export interface NodeIsolator extends ParseIsolator {
  status(): NodeIsolatorStatus;
}

/** Tasks that may wait for a free child when neither the config nor a given pool says otherwise. */
export const DEFAULT_MAX_QUEUE = 16;

const CONFIG_KEYS = [
  "mode",
  "requireStrictContainment",
  "memoryPoolMb",
  "perChildMb",
  "maxInputBytes",
  "maxTaskMillis",
  "heapMb",
  "maxQueue",
  "maxDiskMb",
] as const;

/**
 * Layers a platform must enforce to count as "strict": a separate process, the heap cap, the wall-clock kill and
 * an RSS poll (macOS passes with its weaker `ps` poll); on Linux also the address-space cap and the CPU limit.
 * Returns the names of the missing ones.
 */
export function missingStrictContainment(containment: Containment, platform: NodeJS.Platform): string[] {
  const missing: string[] = [];
  if (!containment.processIsolation) missing.push("processIsolation");
  if (!containment.heapLimit) missing.push("heapLimit");
  if (!containment.wallClock) missing.push("wallClock");
  if (containment.rssPoll === "none") missing.push("rssPoll");
  if (platform === "linux") {
    if (!containment.addressSpaceCap) missing.push("addressSpaceCap");
    if (!containment.cpuLimit) missing.push("cpuLimit");
  }
  return missing;
}

/**
 * Reads every config key exactly once into a frozen plain object (an accessor or proxy cannot show validation one
 * value and the isolator another) and validates the copy with core's own rules, then adds what only this package
 * knows: the heap must stay below the child's RSS limit.
 */
function snapshotConfig(config: IsolationConfig): IsolationConfig {
  if (typeof config !== "object" || config === null) throw new TypeError("isolation config must be an object");
  const copy: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const value = (config as unknown as Record<string, unknown>)[key];
    if (value !== undefined) copy[key] = value;
  }
  const unknownKeys = Object.keys(config).filter((key) => !(CONFIG_KEYS as readonly string[]).includes(key));
  const issues = [...unknownKeys.map((key) => `unknown key "${key}" in isolation`), ...validateConfig({ isolation: copy })];
  if (issues.length > 0) throw new RangeError(`Invalid isolation config: ${issues.join("; ")}`);
  const frozen = Object.freeze(copy) as unknown as IsolationConfig;
  deriveLimits(frozen); // heapMb < perChildMb, with the numbers in the message
  return frozen;
}

function checkRequest(request: IsolatedParseRequest): void {
  if (typeof request !== "object" || request === null) throw new TypeError("isolate: request must be an object");
  const { input, output, filename } = request;
  const path = (input as { path?: unknown } | null)?.path;
  const valid =
    input instanceof Uint8Array || (typeof input === "object" && input !== null && typeof path === "string" && path.length > 0);
  if (!valid) throw new TypeError("isolate: request.input must be a Uint8Array or { path: non-empty string }");
  if (output !== undefined && output !== "text" && output !== "records") {
    throw new TypeError(`isolate: request.output must be "text" or "records", got ${String(output)}`);
  }
  if (filename !== undefined && typeof filename !== "string") {
    throw new TypeError("isolate: request.filename must be a string");
  }
}

/** The facade rule for an aborted signal: a TimeoutError becomes ParseTimeoutError, anything else AbortError. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof ParseTimeoutError) return reason;
  if (reason instanceof Error && reason.name === "TimeoutError") {
    return new ParseTimeoutError("Parse timed out", { cause: reason });
  }
  return new AbortError();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}

function metadataToRecord(metadata: Metadata): Record<string, readonly string[]> {
  // fromEntries defines own properties, so a key named "__proto__" stays data.
  return Object.fromEntries(metadata.names().map((name) => [name, [...metadata.getAll(name)]]));
}

function toIsolatedRecord(record: ParseRecord): IsolatedParseRecord {
  const { exception } = record;
  const code = exception !== null && "code" in exception && typeof exception.code === "string" ? exception.code : undefined;
  return {
    metadata: metadataToRecord(record.metadata),
    content: record.content,
    embeddedResourcePath: record.embeddedResourcePath,
    depth: record.depth,
    mediaType: record.mediaType.toString(),
    exception:
      exception === null
        ? null
        : { name: exception.name, message: exception.message, ...(code === undefined ? {} : { code }) },
  };
}

interface Isolating {
  readonly runner: ChildRunner;
  readonly pool: MemoryPool;
  readonly ownsPool: boolean;
  readonly containment: Containment;
  readonly defaultLimits: DerivedLimits;
}

interface Plan {
  readonly config: IsolationConfig;
  readonly ripstream: IsolatorRipstream;
  readonly inProcess: IsolatorRipstream;
  readonly inProcessTypes: ReadonlySet<string>;
  readonly inProcessMaxBytes: number;
  readonly detectTimeoutMs: number | undefined;
  readonly defaultMaxOutputChars: number | undefined;
  /** null: nothing is ever spawned (off, or degraded). */
  readonly isolating: Isolating | null;
  readonly degradedReason: string | null;
}

class NodeIsolatorImpl implements NodeIsolator {
  readonly #plan: Plan;
  readonly #maxInputBytes: number;
  readonly #maxTaskMillis: number;
  #disposing: Promise<void> | null = null;

  constructor(plan: Plan) {
    this.#plan = plan;
    this.#maxInputBytes = plan.config.maxInputBytes ?? deriveLimits(plan.config).maxInputBytes;
    this.#maxTaskMillis = plan.config.maxTaskMillis ?? DEFAULT_LIMITS.maxTaskMillis;
  }

  async isolate(request: IsolatedParseRequest, options: { readonly signal?: AbortSignal } = {}): Promise<IsolatedParseResult> {
    if (this.#disposing !== null) throw new IsolationError("unavailable", "The isolator was disposed");
    checkRequest(request);
    const { signal } = options;
    throwIfAborted(signal);

    const size = await this.#measure(request);
    const plan = this.#plan;
    if (plan.isolating === null) return this.#parseInProcess(withDefaultCap(request, plan.defaultMaxOutputChars), signal);

    // Rejects maxOutputChars -1 and absurd caps for every route, so the answer does not depend on the file type.
    const limits = deriveLimits(plan.config, withDefaultCap(request, plan.defaultMaxOutputChars));
    const route = await routeRequest({
      ripstream: plan.ripstream,
      input: request.input,
      size,
      inProcessTypes: plan.inProcessTypes,
      inProcessMaxBytes: plan.inProcessMaxBytes,
      ...(request.filename === undefined ? {} : { filename: request.filename }),
      ...(plan.detectTimeoutMs === undefined ? {} : { detectTimeoutMs: plan.detectTimeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(signal);
    return route === "in-process"
      ? this.#parseInProcess(withDefaultCap(request, plan.defaultMaxOutputChars), signal)
      : this.#runIsolated(plan.isolating, request, limits, signal);
  }

  async dispose(): Promise<void> {
    this.#disposing ??= this.#dispose();
    return this.#disposing;
  }

  status(): NodeIsolatorStatus {
    const plan = this.#plan;
    const isolating = plan.isolating;
    return {
      mode: isolating === null ? "off" : plan.config.mode,
      configuredMode: plan.config.mode,
      degraded: plan.degradedReason !== null,
      degradedReason: plan.degradedReason,
      disposed: this.#disposing !== null,
      containment: isolating === null ? null : { ...isolating.containment },
      requireStrictContainment: plan.config.requireStrictContainment === true,
      pool: isolating === null ? null : isolating.pool.stats(),
      unreapedChildren: isolating === null ? 0 : isolating.runner.unreapedChildren,
      limits: isolating === null ? null : { ...isolating.defaultLimits },
      defaultReservationMb:
        isolating === null ? null : defaultReservations(plan.config, isolating.pool.overshootMb, plan.defaultMaxOutputChars),
      maxInputBytes: this.#maxInputBytes,
      inProcessTypes: [...plan.inProcessTypes].sort(),
      inProcessMaxBytes: plan.inProcessMaxBytes,
    };
  }

  async #dispose(): Promise<void> {
    const { isolating } = this.#plan;
    if (isolating === null) return;
    await isolating.runner.dispose();
    if (isolating.ownsPool) isolating.pool.dispose();
  }

  /** The input's size, refused above `maxInputBytes` before anything is read, detected or spawned. */
  async #measure(request: IsolatedParseRequest): Promise<number> {
    const { input } = request;
    const size = input instanceof Uint8Array ? input.length : (await stat(input.path)).size;
    if (size > this.#maxInputBytes) {
      throw new LimitExceededError(`Input of ${size} bytes exceeds the maximum of ${this.#maxInputBytes} bytes`);
    }
    return size;
  }

  async #runIsolated(
    isolating: Isolating,
    request: IsolatedParseRequest,
    limits: DerivedLimits,
    signal: AbortSignal | undefined,
  ): Promise<IsolatedParseResult> {
    // A request that could never fit the pool is the caller's (too large a cap, or a pool too small for the default
    // caps), not an outage: refuse it as a limit rather than let the pool call it "unavailable" (503).
    const { overshootMb } = isolating.pool;
    const { poolMb } = isolating.pool.stats();
    const needMb = limits.perChildMb + overshootMb + parentResultMb(limits.maxResultBytes, limits.output);
    if (needMb > poolMb) {
      throw new LimitExceededError(
        `A ${limits.output} request with maxOutputChars ${limits.maxOutputChars} and maxEmbeddedResources ` +
          `${limits.maxEmbeddedResources} (the defaults unless the caller set them) needs ${needMb} MiB ` +
          `(${limits.perChildMb} per child + ${overshootMb} overshoot + the result), more than the whole memory ` +
          `pool of ${poolMb} MiB. Lower the caps or enlarge the pool`,
      );
    }
    // The child is told the effective caps, not "unset", so what it enforces is what the result cap was sized for.
    const effective: IsolatedParseRequest = {
      input: request.input,
      ...(request.filename === undefined ? {} : { filename: request.filename }),
      output: limits.output,
      maxOutputChars: limits.maxOutputChars,
      maxEmbeddedResources: limits.maxEmbeddedResources,
    };
    return isolating.runner.run(effective, {
      ...(signal === undefined ? {} : { signal }),
      limits: {
        heapMb: limits.heapMb,
        maxResultBytes: limits.maxResultBytes,
        maxFrameBytes: limits.maxFrameBytes,
        maxParseMillis: limits.maxParseMillis,
      },
    });
  }

  async #parseInProcess(request: IsolatedParseRequest, signal: AbortSignal | undefined): Promise<IsolatedParseResult> {
    const limits: Partial<ParseLimits> = {
      maxParseMillis: this.#maxTaskMillis,
      ...(request.maxOutputChars === undefined ? {} : { maxOutputChars: request.maxOutputChars }),
      ...(request.maxEmbeddedResources === undefined ? {} : { maxEmbeddedResources: request.maxEmbeddedResources }),
    };
    const parseOptions: ParseOptions = {
      limits,
      ...(request.filename === undefined ? {} : { filename: request.filename }),
      ...(signal === undefined ? {} : { signal }),
    };
    const { inProcess } = this.#plan;
    try {
      if (request.output === "records") {
        const records = await inProcess.parseRecursive(request.input, parseOptions);
        return { kind: "records", records: records.map(toIsolatedRecord) };
      }
      const { metadata, text } = await inProcess.parse(request.input, parseOptions);
      return { kind: "text", metadata: metadataToRecord(metadata), text };
    } catch (error) {
      // The facade's rule for an aborted signal, whatever the parser threw because of it.
      throwIfAborted(signal);
      throw error;
    }
  }
}

/**
 * The limits of a default request. A bad `defaultMaxOutputChars` is the caller's configuration mistake, so it is a
 * RangeError here; the same number on a single request is a document-level LimitExceededError (422 at the server).
 */
function deriveDefaultLimits(config: IsolationConfig, defaultMaxOutputChars: number | undefined): DerivedLimits {
  if (defaultMaxOutputChars === undefined) return deriveLimits(config);
  try {
    const text = deriveLimits(config, { maxOutputChars: defaultMaxOutputChars });
    // A records result carries more metadata than a text one, so a cap can fit the first and not the second.
    deriveLimits(config, { output: "records", maxOutputChars: defaultMaxOutputChars });
    return text;
  } catch (error) {
    if (error instanceof LimitExceededError) {
      throw new RangeError(`defaultMaxOutputChars ${defaultMaxOutputChars} is rejected: ${error.message}`);
    }
    throw error;
  }
}

function requireValidOutputCap(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`defaultMaxOutputChars must be a non-negative integer, got ${String(value)}`);
  }
}

/** The request with the isolator's default output cap filled in when it names none. */
function withDefaultCap(request: IsolatedParseRequest, defaultMaxOutputChars: number | undefined): IsolatedParseRequest {
  return request.maxOutputChars === undefined && defaultMaxOutputChars !== undefined
    ? { ...request, maxOutputChars: defaultMaxOutputChars }
    : request;
}

function defaultReservations(
  config: IsolationConfig,
  overshootMb: number,
  defaultMaxOutputChars: number | undefined,
): { text: number; records: number } {
  const reserve = (output: "text" | "records"): number => {
    const limits = deriveLimits(config, {
      output,
      ...(defaultMaxOutputChars === undefined ? {} : { maxOutputChars: defaultMaxOutputChars }),
    });
    return limits.perChildMb + overshootMb + parentResultMb(limits.maxResultBytes, output);
  };
  return { text: reserve("text"), records: reserve("records") };
}

function defaultLog(level: IsolatorLogLevel, message: string): void {
  if (level === "warn") console.warn(`[ripstream-isolation] ${message}`);
}

function requireChildModule(childModule: string): void {
  if (typeof childModule !== "string" || !isAbsolute(childModule)) {
    throw new TypeError(`childModule must be an absolute path, got ${JSON.stringify(childModule)}`);
  }
}

type PoolChoice = { readonly pool: MemoryPool; readonly ownsPool: boolean } | { readonly unavailable: string };

/**
 * The pool this isolator draws on. A pool that is too small to run one child is an environment problem when we
 * sized it (a small cgroup: unavailable) and a wiring bug when the caller gave it to us (RangeError).
 */
function choosePool(options: NodeIsolatorOptions, config: IsolationConfig, defaults: DerivedLimits, log: NonNullable<NodeIsolatorOptions["log"]>): PoolChoice {
  const resultMb = parentResultMb(defaults.maxResultBytes, "text");
  if (options.pool !== undefined) {
    if (config.memoryPoolMb !== undefined || config.maxQueue !== undefined) {
      log("warn", "config.memoryPoolMb and config.maxQueue are ignored: the isolator was given a shared memory pool");
    }
    const { overshootMb } = options.pool;
    const { poolMb } = options.pool.stats();
    const needMb = defaults.perChildMb + overshootMb + resultMb;
    if (poolMb < needMb) {
      throw new RangeError(
        `The given memory pool of ${poolMb} MiB cannot hold one child: ${defaults.perChildMb} MiB per child + ` +
          `${overshootMb} MiB overshoot + ${resultMb} MiB for its result = ${needMb} MiB`,
      );
    }
    return { pool: options.pool, ownsPool: false };
  }

  const limits = readCgroupLimits();
  const hostTotalBytes = totalmem();
  let poolMb: number;
  try {
    if (config.memoryPoolMb === undefined) {
      poolMb = defaultPoolMb({ limits, hostTotalBytes });
    } else {
      const validated = validatePoolAgainstCgroup({ requestedPoolMb: config.memoryPoolMb, limits, hostTotalBytes });
      if (validated.warning !== null) log("warn", validated.warning);
      poolMb = validated.poolMb;
    }
  } catch (error) {
    if (error instanceof RangeError) return { unavailable: error.message };
    throw error;
  }
  const needMb = defaults.perChildMb + DEFAULT_OVERSHOOT_MB + resultMb;
  if (poolMb < needMb) {
    return {
      unavailable:
        `The memory pool of ${poolMb} MiB cannot hold one child: ${defaults.perChildMb} MiB per child + ` +
        `${DEFAULT_OVERSHOOT_MB} MiB overshoot + ${resultMb} MiB for its result = ${needMb} MiB`,
    };
  }
  return { pool: new MemoryPool({ poolMb, maxQueue: config.maxQueue ?? DEFAULT_MAX_QUEUE }), ownsPool: true };
}

export async function createNodeIsolator(options: NodeIsolatorOptions): Promise<NodeIsolator> {
  const log = options.log ?? defaultLog;
  const config = snapshotConfig(options.config);
  const platform = options.platform ?? process.platform;
  requireValidOutputCap(options.defaultMaxOutputChars);
  const inProcessMaxBytes = options.inProcessMaxBytes ?? DEFAULT_IN_PROCESS_MAX_BYTES;
  const base = {
    config,
    ripstream: options.ripstream,
    inProcess: options.inProcessRipstream ?? options.ripstream,
    inProcessTypes: new Set(options.inProcessTypes ?? DEFAULT_IN_PROCESS_TYPES),
    inProcessMaxBytes,
    detectTimeoutMs: options.detectTimeoutMs,
    defaultMaxOutputChars: options.defaultMaxOutputChars,
  };
  if (config.mode === "off") return new NodeIsolatorImpl({ ...base, isolating: null, degradedReason: null });

  requireChildModule(options.childModule);
  if (options.tempDir !== undefined) requireTempDir(options.tempDir);
  const defaults = deriveDefaultLimits(config, options.defaultMaxOutputChars);

  // Isolation cannot be provided: strict refuses, lenient carries on without it, loudly, and says so in status().
  const unavailable = (reason: string): NodeIsolator => {
    if (config.mode === "strict") throw new IsolationError("unavailable", reason);
    log("warn", `Isolation is unavailable (${reason}); every document will be parsed in-process`);
    return new NodeIsolatorImpl({ ...base, isolating: null, degradedReason: reason });
  };

  const chosen = choosePool(options, config, defaults, log);
  if ("unavailable" in chosen) return unavailable(chosen.unavailable);

  const probed = await (options.probe ?? probeIsolation)({
    platform,
    cpuSecs: defaults.cpuSecs,
    heapMb: defaults.heapMb,
    ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
    ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
    onTempCleanupError: (message: string) => log("warn", message),
  });
  if (!probed.available) return unavailable(probed.reason);

  // choosePool sized the pool for a text request. A pool between the two reservations runs those and refuses every
  // recursive request that reaches a child, so say so now rather than on the first /rmeta.
  const reservations = defaultReservations(config, chosen.pool.overshootMb, options.defaultMaxOutputChars);
  const { poolMb } = chosen.pool.stats();
  if (reservations.records > poolMb) {
    log(
      "warn",
      `The memory pool of ${poolMb} MiB holds a text request (${reservations.text} MiB) but not a recursive one ` +
        `(${reservations.records} MiB): recursive parses that reach a child will be refused. Raise the pool to at ` +
        `least ${reservations.records} MiB to run them.`,
    );
  }

  if (config.requireStrictContainment === true) {
    const missing = missingStrictContainment(probed.containment, platform);
    if (missing.length > 0) {
      throw new IsolationError(
        "unavailable",
        `requireStrictContainment is set, but this platform (${platform}) does not enforce: ${missing.join(", ")}`,
      );
    }
  }

  const runner = new ChildRunner({
    pool: chosen.pool,
    childScript: options.childModule,
    perChildMb: defaults.perChildMb,
    heapMb: defaults.heapMb,
    cpuSecs: defaults.cpuSecs,
    maxTaskMillis: defaults.maxTaskMillis,
    maxInputBytes: defaults.maxInputBytes,
    maxResultBytes: defaults.maxResultBytes,
    rssLimitMb: defaults.rssLimitMb,
    maxFrameBytes: defaults.maxFrameBytes,
    maxDiskMb: defaults.maxDiskMb,
    onTempCleanupError: (message) => log("warn", message),
    platform,
    ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
    ...(options.childArgs === undefined ? {} : { childArgs: options.childArgs }),
    ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
    ...options.runner,
  });
  return new NodeIsolatorImpl({
    ...base,
    isolating: { runner, pool: chosen.pool, ownsPool: chosen.ownsPool, containment: { ...probed.containment }, defaultLimits: defaults },
    degradedReason: null,
  });
}
