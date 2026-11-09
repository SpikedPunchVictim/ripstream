import { readFileSync } from "node:fs";

/**
 * Container memory limits, read from cgroupfs. Pure logic: the file reader is
 * injected so tests need no real cgroup.
 */

const MIB = 1024 * 1024;
const GIB_MB = 1024;
/** cgroup v1 reports "no limit" as a huge page-aligned number near 2^63. */
const CGROUP_V1_UNLIMITED = 2 ** 60;

export const DEFAULT_PARENT_HEADROOM_MB = 512;

export type CgroupSource = "cgroup2" | "cgroup1" | "host";

export interface CgroupLimits {
  /** Hard memory limit in bytes; null when unlimited or unknown. */
  readonly memoryMaxBytes: number | null;
  /** Current usage of the cgroup in bytes; null when unknown. */
  readonly memoryCurrentBytes: number | null;
  /**
   * memory.oom.group: true means an OOM kill takes the whole cgroup (parent
   * included). null when unknown (v1, host, unreadable).
   */
  readonly oomGroup: boolean | null;
  readonly source: CgroupSource;
}

/** Returns the file's text; throws when the file is missing or unreadable. */
export type ReadTextFile = (path: string) => string;

const readUtf8: ReadTextFile = (path) => readFileSync(path, "utf8");

function tryRead(readFile: ReadTextFile, path: string): string | null {
  try {
    return readFile(path).trim();
  } catch {
    // Missing or unreadable cgroup files are expected (non-Linux, no
    // controller, restricted mount). The caller falls back to the next source.
    return null;
  }
}

function parseBytes(text: string | null): number | null {
  if (text === null || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** The cgroup directories to read, own directory first, ending at the controller's mount root. */
function directoriesUp(root: string, cgroupPath: string): string[] {
  const segments = cgroupPath.split("/").filter((segment) => segment !== "" && segment !== ".");
  // "..": the process sits OUTSIDE its namespace root; nothing below the root can be trusted to be its own.
  if (segments.includes("..")) return [root];
  const dirs: string[] = [];
  for (let depth = segments.length; depth >= 0; depth--) {
    dirs.push(`${root}${segments.slice(0, depth).map((segment) => `/${segment}`).join("")}`);
  }
  return dirs;
}

/**
 * The process's own cgroup paths from /proc/self/cgroup (`hierarchy:controllers:path`): the cgroup v2 path
 * (`0::/path`) and the v1 `memory` controller path. Either is "/" when absent, which reads the mount root, the
 * right place inside a container with its own cgroup namespace (there the mount root IS the container's cgroup).
 */
function ownCgroupPaths(readFile: ReadTextFile): { v2: string; v1: string } {
  const paths = { v2: "/", v1: "/" };
  const text = tryRead(readFile, "/proc/self/cgroup");
  if (text === null) return paths;
  for (const line of text.split("\n")) {
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first === -1 || second === -1) continue;
    const controllers = line.slice(first + 1, second);
    const path = line.slice(second + 1);
    if (line.slice(0, first) === "0" && controllers === "") paths.v2 = path;
    else if (controllers.split(",").includes("memory")) paths.v1 = path;
  }
  return paths;
}

interface LimitFile {
  /** Parses the limit file's text; null = no finite limit at this level. */
  readonly parse: (text: string) => number | null;
  readonly limitName: string;
  readonly currentName: string;
  readonly oomGroupName?: string;
}

/**
 * Walks from the process's own cgroup up to the mount root and returns the SMALLEST finite limit: any ancestor
 * can be the one that triggers the OOM kill. `found` is false when no level had a readable limit file at all.
 * Usage and oom.group are read from the cgroup that binds (or, with no finite limit, from the own cgroup).
 */
function walkLimits(
  readFile: ReadTextFile,
  root: string,
  cgroupPath: string,
  file: LimitFile,
): { found: boolean; limits: Pick<CgroupLimits, "memoryMaxBytes" | "memoryCurrentBytes" | "oomGroup"> } {
  let found = false;
  let firstReadable: string | null = null;
  let bindingDir: string | null = null;
  let best: number | null = null;
  for (const dir of directoriesUp(root, cgroupPath)) {
    const text = tryRead(readFile, `${dir}/${file.limitName}`);
    if (text === null) continue;
    found = true;
    firstReadable ??= dir;
    const limit = file.parse(text);
    if (limit !== null && (best === null || limit < best)) {
      best = limit;
      bindingDir = dir;
    }
  }
  const dir = bindingDir ?? firstReadable;
  const oom = dir === null || file.oomGroupName === undefined ? null : tryRead(readFile, `${dir}/${file.oomGroupName}`);
  return {
    found,
    limits: {
      memoryMaxBytes: best,
      memoryCurrentBytes: dir === null ? null : parseBytes(tryRead(readFile, `${dir}/${file.currentName}`)),
      oomGroup: oom === "1" ? true : oom === "0" ? false : null,
    },
  };
}

// "max" means unlimited; anything else unparseable is treated the same (unknown limit), never as a made-up number.
const V2_FILES: LimitFile = {
  parse: (text) => (text === "max" ? null : parseBytes(text)),
  limitName: "memory.max",
  currentName: "memory.current",
  oomGroupName: "memory.oom.group",
};

const V1_FILES: LimitFile = {
  parse: (text) => {
    const bytes = parseBytes(text);
    return bytes === null || bytes >= CGROUP_V1_UNLIMITED ? null : bytes;
  },
  limitName: "memory.limit_in_bytes",
  currentName: "memory.usage_in_bytes",
};

/**
 * Reads memory limits for the cgroup this process lives in, found through /proc/self/cgroup, taking the smallest
 * limit between it and the root. Without a cgroup namespace (systemd `MemoryMax=`, `docker --cgroupns=host`) the
 * limit is NOT at /sys/fs/cgroup/memory.max (the real root has none); with one, /proc/self/cgroup says "/" and the
 * root is the container's own cgroup. Never throws: anything missing or unparseable degrades to `source: "host"`
 * with null limits.
 *
 * `platform` is injectable for tests; only Linux has cgroups.
 */
export function readCgroupLimits(
  readFile: ReadTextFile = readUtf8,
  platform: NodeJS.Platform = process.platform,
): CgroupLimits {
  const host: CgroupLimits = {
    memoryMaxBytes: null,
    memoryCurrentBytes: null,
    oomGroup: null,
    source: "host",
  };
  if (platform !== "linux") return host;

  const paths = ownCgroupPaths(readFile);
  const v2 = walkLimits(readFile, "/sys/fs/cgroup", paths.v2, V2_FILES);
  if (v2.found) return { ...v2.limits, source: "cgroup2" };

  const v1 = walkLimits(readFile, "/sys/fs/cgroup/memory", paths.v1, V1_FILES);
  if (v1.found) return { ...v1.limits, oomGroup: null, source: "cgroup1" };

  return host;
}

function requireNonNegativeInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
}

/**
 * Default pool size in MiB: the smaller of cgroup memory.max and host total
 * memory (a cgroup limit above the machine's RAM limits nothing), minus the
 * memory reserved for the parent process, floored at 0.
 *
 * Throws RangeError when the result is below 1 GiB: one child needs more than
 * that (cap plus L3 overshoot), so such a pool could never admit anything. The
 * caller decides how to surface it (refuse to start, or disable isolation).
 */
export function defaultPoolMb(args: {
  readonly limits: CgroupLimits;
  readonly hostTotalBytes: number;
  readonly parentHeadroomMb?: number;
}): number {
  const headroomMb = args.parentHeadroomMb ?? DEFAULT_PARENT_HEADROOM_MB;
  requireNonNegativeInt("parentHeadroomMb", headroomMb);
  if (!Number.isFinite(args.hostTotalBytes) || args.hostTotalBytes < 0) {
    throw new RangeError(`hostTotalBytes must be a non-negative number, got ${String(args.hostTotalBytes)}`);
  }

  // A cgroup limit above the machine's RAM limits nothing (a 200 GiB limit on a 16 GiB host): the smaller wins.
  const cgroupMax = args.limits.memoryMaxBytes;
  const fromCgroup = cgroupMax !== null && cgroupMax < args.hostTotalBytes;
  const totalBytes = cgroupMax === null ? args.hostTotalBytes : Math.min(cgroupMax, args.hostTotalBytes);
  const totalMb = Math.floor(totalBytes / MIB);
  const poolMb = Math.max(0, totalMb - headroomMb);
  if (poolMb < GIB_MB) {
    throw new RangeError(
      `Isolation memory pool would be ${poolMb} MiB (${fromCgroup ? `cgroup memory.max` : "host memory"} ` +
        `${totalMb} MiB minus ${headroomMb} MiB parent headroom), below the ${GIB_MB} MiB minimum ` +
        `needed to run a single isolated child. Raise the memory limit or set memoryPoolMb explicitly.`,
    );
  }
  return poolMb;
}

export interface PoolValidation {
  /** Pool size to use, never larger than memory.max minus headroom. */
  readonly poolMb: number;
  /** Set when the request was clamped; null when it was accepted as is. */
  readonly warning: string | null;
}

/**
 * Startup check of a configured pool against the cgroup limit. When
 * `requestedPoolMb + headroom` exceeds memory.max the pool is clamped to
 * `memory.max - headroom` (floored at 0) and a warning is returned, so the
 * pool can never admit more than the cgroup allows. The result may still be
 * too small to run anything; the caller checks that. No cgroup limit means
 * nothing to validate against.
 */
export function validatePoolAgainstCgroup(args: {
  readonly requestedPoolMb: number;
  readonly limits: CgroupLimits;
  readonly parentHeadroomMb?: number;
  /**
   * Total RAM of the machine. When given, a cgroup limit above it is capped at it (the host is the real ceiling).
   * It only ever lowers a cgroup limit: with no cgroup limit there is still nothing to validate against.
   */
  readonly hostTotalBytes?: number;
}): PoolValidation {
  const headroomMb = args.parentHeadroomMb ?? DEFAULT_PARENT_HEADROOM_MB;
  requireNonNegativeInt("parentHeadroomMb", headroomMb);
  requireNonNegativeInt("requestedPoolMb", args.requestedPoolMb);
  if (args.hostTotalBytes !== undefined && (!Number.isFinite(args.hostTotalBytes) || args.hostTotalBytes < 0)) {
    throw new RangeError(`hostTotalBytes must be a non-negative number, got ${String(args.hostTotalBytes)}`);
  }

  const cgroupMax = args.limits.memoryMaxBytes;
  if (cgroupMax === null) return { poolMb: args.requestedPoolMb, warning: null };
  const maxBytes = args.hostTotalBytes === undefined ? cgroupMax : Math.min(cgroupMax, args.hostTotalBytes);
  const limitName = maxBytes < cgroupMax ? "host memory" : "the cgroup memory.max";

  const maxMb = Math.floor(maxBytes / MIB);
  if (args.requestedPoolMb + headroomMb <= maxMb) {
    return { poolMb: args.requestedPoolMb, warning: null };
  }
  const poolMb = Math.max(0, maxMb - headroomMb);
  return {
    poolMb,
    warning:
      `Requested isolation memory pool ${args.requestedPoolMb} MiB plus ${headroomMb} MiB parent headroom ` +
      `exceeds ${limitName} of ${maxMb} MiB; clamped the pool to ${poolMb} MiB.`,
  };
}
