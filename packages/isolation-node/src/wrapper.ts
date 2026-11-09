import { supportsAddressSpaceCap } from "./containment.ts";

/**
 * Builds the `/bin/sh` launcher that applies OS resource limits and then
 * `exec`s the node child. Pure data in, pure data out: nothing is spawned here.
 *
 * Productionised from test/chaos/reference.sh. Differences, all deliberate:
 * - Limits arrive as positional parameters ($1 soft CPU secs, $2 hard CPU secs,
 *   $3 vmem KB) instead of REF_* env vars, so the script text is a constant and
 *   no caller-supplied value is ever interpolated into it.
 * - Numeric validation and the `hard = soft + 2` arithmetic happen in JS before
 *   the command exists; the shell `num()` guard is therefore not needed.
 * - The node command line (executable, --max-old-space-size, flags, script,
 *   script args) is also positional and run via `exec "$@"` (reference.sh
 *   did `exec node --max-old-space-size=... "$@"`); the executable is the
 *   caller's path, not a PATH lookup of `node`.
 * - MALLOC_ARENA_MAX=1 is returned in `env` rather than exported in the script.
 * - The REF_NO_OOM_ADJ test knob is gone; the oom_score_adj step is always
 *   attempted and its failure is only logged to stderr.
 * - Platform: `ulimit -v` (RLIMIT_AS) and /proc exist only on Linux. On any
 *   other platform a second constant script runs without the vmem and
 *   oom_score_adj steps and the vmem positional is not passed at all.
 */

export const DEFAULT_VMEM_KB = 6_291_456; // 6144 MB
export const MIN_VMEM_KB = 4_194_304; // 4096 MB: below this WASM parsers start to fail non-monotonically

const MAX_VMEM_KB = 1_073_741_824; // 1 TiB
const MAX_CPU_SECS = 86_400;
const MAX_HEAP_MB = 65_536;

/** The only parent variables the child may inherit. NODE_OPTIONS is deliberately absent. */
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TZ"] as const;

/** Linux: $1 soft CPU secs, $2 hard CPU secs, $3 vmem KB, then the node command line. */
export const WRAPPER_SCRIPT = [
  'ulimit -S -t "$1" || exit 126',
  'ulimit -H -t "$2" || exit 126',
  'ulimit -v "$3" || exit 126',
  "shift 3",
  '{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null || echo "ripstream-wrapper: oom_score_adj not set" >&2',
  'exec "$@"',
].join("\n");

/** Non-Linux (macOS): $1 soft CPU secs, $2 hard CPU secs, then the node command line. No vmem, no oom_score_adj. */
export const WRAPPER_SCRIPT_NO_VMEM = [
  'ulimit -S -t "$1" || exit 126',
  'ulimit -H -t "$2" || exit 126',
  "shift 2",
  'exec "$@"',
].join("\n");

export interface WrapperOptions {
  /** Node executable (absolute path preferred). */
  readonly nodePath: string;
  /** Child entry script. */
  readonly scriptPath: string;
  /** Arguments for the child script. */
  readonly scriptArgs?: readonly string[];
  /** Soft RLIMIT_CPU in seconds; the hard limit is this plus 2. */
  readonly cpuSecs: number;
  /** Coarse RLIMIT_AS in KB (L4). Default 6291456; must be at least 4194304. */
  readonly vmemKb?: number;
  /** V8 old-space size in MB (L1). */
  readonly heapMb: number;
  /** Extra node flags placed before the script. May not set the heap size. */
  readonly execArgv?: readonly string[];
  /** Environment to filter. Defaults to process.env. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Target platform. Default process.platform. Only Linux gets the vmem cap. */
  readonly platform?: NodeJS.Platform;
  /**
   * The child's TMPDIR: its private per-call directory. Set here and never inherited, so a parent TMPDIR cannot
   * send the child's spool files somewhere the disk budget does not look.
   */
  readonly tmpDir?: string;
}

export interface WrapperCommand {
  readonly file: "/bin/sh";
  readonly args: string[];
  readonly env: Record<string, string>;
}

function checkInteger(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer number, got ${describe(value)}`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function checkString(name: string, value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be a ${allowEmpty ? "" : "non-empty "}string, got ${describe(value)}`);
  }
  if (value.includes("\0")) throw new TypeError(`${name} must not contain NUL`);
  return value;
}

/** A path that sh or node could mistake for an option. */
function checkNotOption(name: string, value: unknown): string {
  const text = checkString(name, value);
  if (text.startsWith("-")) throw new TypeError(`${name} must not start with "-": ${text}`);
  return text;
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * execArgv is checked by SHAPE and by ALLOWLIST, never by a denylist of known bad flags (node and V8 have hundreds
 * of flags and a list that has to be complete will not be).
 *
 * Node (and V8) take `--flag value` as well as `--flag=value` for any flag that needs a value. In the launcher's
 * argument list a bare value-taking flag swallows the NEXT word: another option, or the script path itself, after
 * which node falls back to reading a script from stdin. Whether a bare `--name` is boolean is knowledge about node
 * that we cannot keep complete, so:
 *  - every entry is `--long-flag` or `--long-flag=value` (short flags such as `-e`, `-p`, `-r`, `-i`, `-C`, `-pe`,
 *    `-` and `--` are refused);
 *  - a BARE flag must be on BARE_FLAGS below, a short list of flags known to be boolean;
 *  - anything else must state its value with `=`.
 * Independently, the heap, stack and memory shaping families are refused by NAME in either form: heapMb is the one
 * way to size the child's heap, and the pool, the RSS limit and the cgroup arithmetic all assume it (a stray
 * `--max-heap-size=4000` overrides `--max-old-space-size`, `--max-semi-space-size` and `--initial-heap-size` add
 * to it).
 */
const LONG_FLAG = /^--[A-Za-z][A-Za-z0-9_-]*(=.*)?$/s;

/** Known-boolean flags that may be written bare. Keep it minimal; each entry needs a reason. */
/** Flags that read more options (NODE_OPTIONS, nodeOptions) from a file the allowlist and heap rule never see. */
const CONFIG_LOADING_FLAGS: ReadonlySet<string> = new Set(["env-file", "env-file-if-exists", "experimental-config-file", "config-file"]);

const BARE_FLAGS: ReadonlySet<string> = new Set([
  "no-warnings", // quiet process warnings on stderr (they would only fill the stderr budget)
  "no-deprecation", // the same for deprecation notices
  "enable-source-maps", // readable stack traces in the stderr tail of a crash
  "experimental-strip-types", // run a .ts child entry on node versions where type stripping is not yet the default
  "experimental-wasm-modules", // a child entry that imports .wasm modules directly
  "experimental-vm-modules", // a child entry that uses vm.SourceTextModule
]);

/** Heap / stack / memory shaping, matched against the lower-cased flag NAME (underscores read as hyphens). */
const MEMORY_SHAPING = /heap|space|stack-size|memory|old-gen|young-gen/;

function checkExecArgv(execArgv: readonly string[]): string[] {
  return execArgv.map((arg, index) => {
    const text = checkString(`execArgv[${index}]`, arg);
    const where = `execArgv[${index}]`;
    if (!LONG_FLAG.test(text)) {
      throw new TypeError(`${where} must be a long node flag (--flag or --flag=value), got ${describe(text)}`);
    }
    const equals = text.indexOf("=");
    const name = (equals === -1 ? text : text.slice(0, equals)).slice(2).toLowerCase().replaceAll("_", "-");
    if (CONFIG_LOADING_FLAGS.has(name)) {
      throw new TypeError(`${where} ${describe(text)} loads options from a file, which would bypass the environment allowlist and the heap rule`);
    }
    if (name === "max-old-space-size") {
      throw new TypeError("execArgv must not set the heap size; use heapMb");
    }
    if (MEMORY_SHAPING.test(name)) {
      throw new TypeError(`${where} ${describe(text)} shapes the heap, stack or memory; use heapMb, the only supported way to size the child`);
    }
    if (equals === -1 && !BARE_FLAGS.has(name)) {
      throw new TypeError(`${where} ${describe(text)} is not a known boolean flag: write a flag that takes a value as ${text}=<value>, never as a separate word`);
    }
    // Pass the normalised spelling on: node itself rejects upper-case flag names.
    return `--${name}${equals === -1 ? "" : text.slice(equals)}`;
  });
}

function buildEnv(parentEnv: Readonly<Record<string, string | undefined>>, tmpDir: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = parentEnv[name];
    if (typeof value === "string" && !value.includes("\0")) env[name] = value;
  }
  env.MALLOC_ARENA_MAX = "1";
  if (tmpDir !== undefined) env.TMPDIR = tmpDir;
  return env;
}

export function buildWrapperCommand(options: WrapperOptions): WrapperCommand {
  const cpuSecs = checkInteger("cpuSecs", options.cpuSecs, 1, MAX_CPU_SECS);
  const vmemKb = checkInteger("vmemKb", options.vmemKb === undefined ? DEFAULT_VMEM_KB : options.vmemKb, MIN_VMEM_KB, MAX_VMEM_KB);
  const heapMb = checkInteger("heapMb", options.heapMb, 1, MAX_HEAP_MB);
  const nodePath = checkNotOption("nodePath", options.nodePath);
  const scriptPath = checkNotOption("scriptPath", options.scriptPath);
  const execArgv = checkExecArgv(options.execArgv ?? []);
  const scriptArgs = (options.scriptArgs ?? []).map((arg, index) => checkString(`scriptArgs[${index}]`, arg, true));
  const tmpDir = options.tmpDir === undefined ? undefined : checkString("tmpDir", options.tmpDir);

  const withVmem = supportsAddressSpaceCap(options.platform ?? process.platform);

  return {
    file: "/bin/sh",
    args: [
      "-c",
      withVmem ? WRAPPER_SCRIPT : WRAPPER_SCRIPT_NO_VMEM,
      "sh",
      String(cpuSecs),
      String(cpuSecs + 2),
      ...(withVmem ? [String(vmemKb)] : []),
      nodePath,
      `--max-old-space-size=${heapMb}`,
      ...execArgv,
      scriptPath,
      ...scriptArgs,
    ],
    env: buildEnv(options.parentEnv ?? process.env, tmpDir),
  };
}
