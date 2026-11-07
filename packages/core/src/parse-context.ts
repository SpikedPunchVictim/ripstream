import { AbortError } from "./errors.ts";
import { assertValidOutputLimit } from "./handlers/limits.ts";

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
  readonly maxZipEntries: number;
  /**
   * Reserved. XML DTDs are rejected outright and saxes expands only the five
   * predefined entities and character references (no amplification), so there
   * is nothing to count; a future DTD-enabled parser must enforce this.
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
  maxZipEntries: 10_000,
  maxXmlEntityExpansions: 0,
});

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
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    assertValidOutputLimit("maxOutputChars", this.limits.maxOutputChars);
    if (this.limits.maxDocumentOutputChars !== undefined) {
      assertValidOutputLimit("maxDocumentOutputChars", this.limits.maxDocumentOutputChars);
    }
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
      limits: { ...this.limits, ...options.limits },
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
  /** Mutable budget shared by a context and all of its descendants. */
  EMBEDDED_BUDGET: new ParseContextKey<{ count: number; bytes: number }>(
    "embedded-budget",
  ),
} as const;
