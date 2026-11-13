import { AbortError, ParseTimeoutError } from "./errors.ts";
import type { DigestSettings } from "./digest.ts";
import { outputLimitIssue } from "./handlers/limits.ts";

/**
 * Typed context key. The optional phantom field gives TypeScript the value
 * type without emitting runtime metadata.
 */
export class ParseContextKey<T> {
  readonly id: string;
  declare readonly __type?: T;

  constructor(id: string) {
    this.id = id;
  }
}

export interface ParseLimits {
  /** Total output characters; `-1` means unlimited. NaN/other negatives are rejected. */
  readonly maxOutputChars: number;
  /**
   * Optional per-document output cap for parseRecursive (applies to the root
   * and to each embedded document, in addition to the shared maxOutputChars).
   * Same validation as maxOutputChars; unset means no per-document cap.
   */
  readonly maxDocumentOutputChars?: number;
  readonly maxEmbeddedResources: number;
  readonly maxEmbeddedResourceBytes: number;
  readonly maxTotalEmbeddedBytes: number;
  readonly maxDecompressionRatio: number;
  readonly maxNodeDepth: number;
  readonly maxParseMillis: number;
  readonly maxTaskMillis: number;
  /** Metadata values longer than this are truncated (see Metadata.setMaxValueChars). */
  readonly maxMetadataValueChars: number;
  /**
   * One document's metadata may hold at most this many characters in total: every name (once) and every value counts
   * its length plus one (see Metadata.setMaxTotalChars). Past it the parse fails with a LimitExceededError. The value
   * cap bounds one value, this bounds their sum. The default, 2,000,000, is ten times the most any document in the
   * test corpora produced (about 2,000 characters) and small enough that a text-mode isolated result still fits its
   * metadata frame in the worst case (6 wire bytes per character), so an isolated and an in-process parse refuse the
   * same documents. An isolated child always applies the default.
   */
  readonly maxMetadataTotalChars: number;
  readonly maxZipEntries: number;
  /**
   * Reserved. A DOCTYPE is accepted but its DTD is never read, and saxes
   * expands only the five predefined entities and character references (no
   * amplification), so there is nothing to count; a future parser that
   * expands DTD entities must enforce this.
   */
  readonly maxXmlEntityExpansions: number;
}

export const DEFAULT_LIMITS: ParseLimits = Object.freeze({
  maxOutputChars: 100_000,
  maxEmbeddedResources: 10_000,
  maxEmbeddedResourceBytes: 512 * 1024 * 1024,
  maxTotalEmbeddedBytes: 1024 * 1024 * 1024,
  maxDecompressionRatio: 100,
  maxNodeDepth: 100,
  maxParseMillis: 60_000,
  maxTaskMillis: 60_000,
  maxMetadataValueChars: 1_000_000,
  maxMetadataTotalChars: 2_000_000,
  maxZipEntries: 10_000,
  maxXmlEntityExpansions: 0,
});

/** Largest delay a timer can hold: past it Node fires the timer after 1 ms. */
const MAX_TIMER_MILLIS = 2 ** 31 - 1;

type LimitCheck = (name: string, value: unknown) => string | null;

const nonNegativeInteger: LimitCheck = (name, value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? null
    : `${name} must be a non-negative integer, got ${String(value)}`;

const timerMillis =
  (min: number): LimitCheck =>
  (name, value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= MAX_TIMER_MILLIS
      ? null
      : `${name} must be an integer from ${min} to ${MAX_TIMER_MILLIS} milliseconds, got ${String(value)}`;

const LIMIT_CHECKS: Readonly<Record<keyof ParseLimits, LimitCheck>> = {
  maxOutputChars: outputLimitIssue,
  maxDocumentOutputChars: outputLimitIssue,
  maxEmbeddedResources: nonNegativeInteger,
  maxEmbeddedResourceBytes: nonNegativeInteger,
  maxTotalEmbeddedBytes: nonNegativeInteger,
  maxDecompressionRatio: (name, value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? null
      : `${name} must be a positive finite number, got ${String(value)}`,
  maxNodeDepth: nonNegativeInteger,
  // 0 means no parse timer.
  maxParseMillis: timerMillis(0),
  maxTaskMillis: timerMillis(1),
  maxMetadataValueChars: nonNegativeInteger,
  maxMetadataTotalChars: nonNegativeInteger,
  maxZipEntries: nonNegativeInteger,
  maxXmlEntityExpansions: nonNegativeInteger,
};

/**
 * Refuses limits a parser would misread: an unknown name, and a value that is not a number of the kind the limit
 * needs. NaN, a string or a negative turns a `count > limit` check off for good, and a timer delay past 2^31-1 fires
 * at once. A limit set to `undefined` is absent (it keeps the default), so it is not checked. Throws a RangeError
 * naming every problem.
 */
export function assertValidLimits(limits: Partial<ParseLimits> | undefined): void {
  if (limits === undefined) return;
  if (typeof limits !== "object" || limits === null) {
    throw new RangeError(`invalid limits: expected an object, got ${limits === null ? "null" : typeof limits}`);
  }
  const issues: string[] = [];
  for (const [name, value] of Object.entries(limits)) {
    if (value === undefined) continue;
    const check = Object.hasOwn(LIMIT_CHECKS, name) ? LIMIT_CHECKS[name as keyof ParseLimits] : undefined;
    const issue = check === undefined ? `unknown limit "${name}"` : check(name, value);
    if (issue !== null) issues.push(issue);
  }
  if (issues.length > 0) throw new RangeError(`invalid limits: ${issues.join("; ")}`);
}

/** The limits the caller set: an `undefined` is not set, and must not replace a default. */
function definedOnly(limits: Partial<ParseLimits> | undefined): Partial<ParseLimits> {
  return Object.fromEntries(Object.entries(limits ?? {}).filter(([, value]) => value !== undefined));
}

export interface AsyncClosable {
  close(): void | Promise<void>;
}

/** Tracks resources that must be released when a parse ends or aborts. */
export class TemporaryResources implements AsyncDisposable {
  private readonly resources = new Set<AsyncClosable>();

  add<T extends AsyncClosable>(resource: T): T {
    this.resources.add(resource);
    return resource;
  }

  remove(resource: AsyncClosable): void {
    this.resources.delete(resource);
  }

  get size(): number {
    return this.resources.size;
  }

  async closeAll(): Promise<void> {
    const resources = [...this.resources].reverse();
    this.resources.clear();
    const errors: unknown[] = [];
    for (const resource of resources) {
      try {
        await resource.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close temporary resources");
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.closeAll();
  }
}

export interface ParseContextOptions {
  readonly signal?: AbortSignal;
  readonly limits?: Partial<ParseLimits>;
  readonly resources?: TemporaryResources;
}

/**
 * Per-document context. Not shared across concurrent parses; child contexts
 * share the abort signal and resource tracker.
 */
export class ParseContext implements AsyncDisposable {
  private readonly values = new Map<ParseContextKey<unknown>, unknown>();
  readonly signal: AbortSignal;
  readonly limits: ParseLimits;
  readonly resources: TemporaryResources;

  constructor(options: ParseContextOptions = {}) {
    this.signal = options.signal ?? new AbortController().signal;
    assertValidLimits(options.limits);
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...definedOnly(options.limits) });
    this.resources = options.resources ?? new TemporaryResources();
  }

  get<T>(key: ParseContextKey<T>): T | undefined {
    return this.values.get(key as ParseContextKey<unknown>) as T | undefined;
  }

  set<T>(key: ParseContextKey<T>, value: T): void {
    this.values.set(key as ParseContextKey<unknown>, value);
  }

  has<T>(key: ParseContextKey<T>): boolean {
    return this.values.has(key as ParseContextKey<unknown>);
  }

  remove<T>(key: ParseContextKey<T>): void {
    this.values.delete(key as ParseContextKey<unknown>);
  }

  throwIfAborted(): void {
    if (!this.signal.aborted) return;
    const reason: unknown = this.signal.reason;
    if (reason instanceof DOMException && reason.name === "TimeoutError") {
      throw new ParseTimeoutError(reason.message);
    }
    if (
      reason instanceof Error &&
      !(reason instanceof DOMException && reason.name === "AbortError")
    ) {
      throw reason;
    }
    throw new AbortError(
      reason instanceof Error ? reason.message : "Operation aborted",
    );
  }

  createChild(options: ParseContextOptions = {}): ParseContext {
    const child = new ParseContext({
      signal: options.signal ?? this.signal,
      limits: { ...this.limits, ...definedOnly(options.limits) },
      resources: options.resources ?? this.resources,
    });
    for (const [key, value] of this.values) child.values.set(key, value);
    return child;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.resources.closeAll();
  }
}

export const CONTEXT_KEYS = {
  PARSER: new ParseContextKey<unknown>("parser"),
  DETECTOR: new ParseContextKey<unknown>("detector"),
  CONTENT_TYPE: new ParseContextKey<unknown>("content-type"),
  RESOURCE_NAME: new ParseContextKey<string>("resource-name"),
  PARSING_INTENT: new ParseContextKey<
    "DEFAULT" | "RANDOM_ACCESS" | "OCR" | "METADATA_ONLY"
  >("parsing-intent"),
  LOCALE: new ParseContextKey<string>("locale"),
  EMBEDDED_DEPTH: new ParseContextKey<number>("embedded-depth"),
  EMBEDDED_RESOURCE_PATH: new ParseContextKey<string>(
    "embedded-resource-path",
  ),
  EMBEDDED_DOCUMENT_EXTRACTOR: new ParseContextKey<unknown>(
    "embedded-document-extractor",
  ),
  EMBEDDED_COUNT: new ParseContextKey<number>("embedded-count"),
  /** The `tk:embedded-id-path` of the document being parsed ("" for the container). */
  EMBEDDED_ID_PATH: new ParseContextKey<string>("embedded-id-path"),
  /** The digests to make (Tika's DigesterFactory in the ParseContext); AutoDetectParser reads it. Absent: none. */
  DIGESTS: new ParseContextKey<DigestSettings>("digests"),
  /**
   * A charset from the incoming Content-Type hint (`ParseOptions.contentType`), which text parsers decode with instead
   * of detecting one. Set on the root document only; embedded documents detect their own.
   */
  CHARSET_HINT: new ParseContextKey<string>("charset-hint"),
  /** Mutable budget shared by a context and all of its descendants. */
  EMBEDDED_BUDGET: new ParseContextKey<{ count: number; bytes: number }>(
    "embedded-budget",
  ),
} as const;
