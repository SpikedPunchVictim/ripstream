import { rssPollKind } from "./containment.ts";

/**
 * Opt-in reuse of isolated children ("warm" children, warm.ts). Off by default, and off means nothing changes: every
 * request gets a fresh child, exactly as before.
 *
 * On, a child that answered a request cleanly may answer the next request of the SAME trust domain, until it has
 * answered `maxRequests`, its memory passes `rssCeilingMb`, or anything about its last request looked wrong (see
 * docs/isolation.md, "Reusing children"). This trades some of the isolation between documents for speed: a parser
 * that a document compromised can see, and tamper with, the documents that the same child parses after it. The trust
 * domain is how the caller says which documents may share a child; documents of different owners must never share
 * one.
 */
export interface ChildReuseOptions {
  /** Default false. */
  readonly enabled?: boolean;
  /**
   * Required when `enabled`: the trust domain of a request that names none (`NodeIsolateOptions.trustDomain`). A child
   * only ever serves requests of the domain it was started for. A non-empty string of at most 256 characters.
   */
  readonly trustDomain?: string;
  /** Requests one child answers before it is retired. Default 100. */
  readonly maxRequests?: number;
  /**
   * A child whose memory (RSS, macOS: the larger of RSS and the physical footprint) is above this many MiB after a
   * request is retired instead of kept. Default: half of the child's RSS kill limit. Must be below that limit.
   */
  readonly rssCeilingMb?: number;
  /** The memory is measured after every this many requests of a child (sampling costs ~50 ms on macOS). Default 10. */
  readonly rssSampleEvery?: number;
  /** An idle child is retired after this many ms without a request. Default 30000. */
  readonly idleTimeoutMs?: number;
  /** Most idle children kept, over all trust domains; the least recently used goes first. Default 4. */
  readonly maxIdleChildren?: number;
  /**
   * Most trust domains with live children. A request of another domain gets a child that is retired after it,
   * unless a domain whose children are all idle can be cleared to make room. Default 8.
   */
  readonly maxTrustDomains?: number;
}

/** `ChildReuseOptions` with every default applied; only built when reuse is enabled. */
export interface ResolvedReuse {
  readonly trustDomain: string;
  readonly maxRequests: number;
  readonly rssCeilingMb: number;
  readonly rssSampleEvery: number;
  readonly idleTimeoutMs: number;
  readonly maxIdleChildren: number;
  readonly maxTrustDomains: number;
}

export const DEFAULT_REUSE_MAX_REQUESTS = 100;
export const DEFAULT_REUSE_RSS_SAMPLE_EVERY = 10;
export const DEFAULT_REUSE_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_REUSE_MAX_IDLE_CHILDREN = 4;
export const DEFAULT_REUSE_MAX_TRUST_DOMAINS = 8;
export const MAX_TRUST_DOMAIN_CHARS = 256;

const REUSE_KEYS = [
  "enabled",
  "trustDomain",
  "maxRequests",
  "rssCeilingMb",
  "rssSampleEvery",
  "idleTimeoutMs",
  "maxIdleChildren",
  "maxTrustDomains",
] as const;

/** A trust domain as given by a caller: a non-empty string of at most MAX_TRUST_DOMAIN_CHARS characters. */
export function requireTrustDomain(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TRUST_DOMAIN_CHARS) {
    throw new TypeError(
      `${name} must be a non-empty string of at most ${MAX_TRUST_DOMAIN_CHARS} characters, got ` +
        (typeof value === "string" ? `a string of ${value.length}` : String(value)),
    );
  }
  return value;
}

function positiveInteger(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`reuse.${name} must be a positive safe integer, got ${String(value)}`);
  }
  return value;
}

/**
 * Reads every key of `value` once, rejects unknown keys and bad values, and returns the frozen settings when reuse is
 * enabled, or null when it is not (absent, or `enabled` false or omitted). Disabled settings are still checked, so a
 * mistyped key or value fails at construction whichever way the switch is set; what depends on the child's limits
 * (the ceiling below the RSS kill limit) and the platform is checked only when enabled.
 *
 * Reuse needs a per-request CPU measurement (RLIMIT_CPU counts a whole process's life, so with reuse it can only be a
 * backstop): a platform without one cannot enable it.
 */
export function resolveReuse(
  value: unknown,
  context: { readonly rssLimitMb: number; readonly platform: NodeJS.Platform },
): ResolvedReuse | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("reuse must be an object");
  const copy: Record<string, unknown> = {};
  for (const key of REUSE_KEYS) copy[key] = (value as Record<string, unknown>)[key];
  const unknownKeys = Object.keys(value).filter((key) => !(REUSE_KEYS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) throw new RangeError(`Invalid reuse options: unknown key(s) ${unknownKeys.map((key) => `"${key}"`).join(", ")}`);
  if (copy["enabled"] !== undefined && typeof copy["enabled"] !== "boolean") {
    throw new TypeError(`reuse.enabled must be a boolean, got ${String(copy["enabled"])}`);
  }
  const defaultCeilingMb = Math.max(1, Math.floor(context.rssLimitMb / 2));
  const resolved: ResolvedReuse = Object.freeze({
    trustDomain: copy["trustDomain"] === undefined ? "" : requireTrustDomain("reuse.trustDomain", copy["trustDomain"]),
    maxRequests: positiveInteger("maxRequests", copy["maxRequests"], DEFAULT_REUSE_MAX_REQUESTS),
    rssCeilingMb: positiveInteger("rssCeilingMb", copy["rssCeilingMb"], defaultCeilingMb),
    rssSampleEvery: positiveInteger("rssSampleEvery", copy["rssSampleEvery"], DEFAULT_REUSE_RSS_SAMPLE_EVERY),
    idleTimeoutMs: positiveInteger("idleTimeoutMs", copy["idleTimeoutMs"], DEFAULT_REUSE_IDLE_TIMEOUT_MS),
    maxIdleChildren: positiveInteger("maxIdleChildren", copy["maxIdleChildren"], DEFAULT_REUSE_MAX_IDLE_CHILDREN),
    maxTrustDomains: positiveInteger("maxTrustDomains", copy["maxTrustDomains"], DEFAULT_REUSE_MAX_TRUST_DOMAINS),
  });
  if (copy["enabled"] !== true) return null;
  if (resolved.rssCeilingMb >= context.rssLimitMb) {
    throw new RangeError(
      `reuse.rssCeilingMb (${resolved.rssCeilingMb}) must be below the child's RSS kill limit (${context.rssLimitMb} MiB): ` +
        "a ceiling at or above it is never reached",
    );
  }
  if (copy["trustDomain"] === undefined) {
    throw new TypeError(
      "reuse.trustDomain is required when reuse is enabled: a child is only reused for requests of the same trust domain",
    );
  }
  if (rssPollKind(context.platform) === "none") {
    throw new RangeError(
      `reuse cannot be enabled on ${context.platform}: the parent cannot measure a child's CPU time per request there`,
    );
  }
  return resolved;
}
