/**
 * Parse-isolation port and configuration. Types are plain and serializable so
 * implementations (child process, worker, remote) can live outside core and
 * core stays runtime-neutral. The failure type is `IsolationError`
 * (errors.ts).
 */

import type { ComponentEntry } from "./component-config.ts";
import type { DigestSettings } from "./digest.ts";
import type { HandlerType } from "./handler-type.ts";
import { assertValidLimits, DEFAULT_LIMITS, type ParseLimits } from "./parse-context.ts";
import type { PathPart } from "./recursive.ts";

/**
 * What a configuration sets that the isolation child must apply too (plain data, so it crosses a process boundary as
 * JSON): the `parsers` and `detectors` sections as `loadConfig` read them, the digests of the `parse-context` digester
 * factory, and the text of the custom-mimetypes file.
 * The child builds its parsers and detectors from them, and applies the same names the parent applied to its own
 * routing detector and in-process parsers. The file's text crosses, not its path: the child reads exactly what the
 * parent checked, whatever happens to the file meanwhile.
 */
export interface IsolatedComponents {
  readonly parsers?: readonly ComponentEntry[];
  readonly detectors?: readonly ComponentEntry[];
  /** The child digests every document it parses (the container, and what is embedded in it) as the parent's configuration says. */
  readonly digest?: DigestSettings;
  readonly customMimeTypes?: string;
}

/**
 * strict: isolate everything not on the in-process allowlist; fail closed
 * (IsolationError) when isolation is unavailable.
 * lenient: as strict, but may fall back to in-process parsing when isolation
 * is unavailable at initialisation.
 * off: never isolate (library default).
 */
export type IsolationMode = "strict" | "lenient" | "off";

/**
 * Isolation settings. Numeric fields are integers (see config validation for
 * bounds; maxQueue may be 0); when omitted the implementation chooses its own
 * value.
 */
export interface IsolationConfig {
  readonly mode: IsolationMode;
  /** Refuse to run unless the platform can enforce hard memory containment. */
  readonly requireStrictContainment?: boolean;
  /** Total memory shared by all concurrent children, in MiB. */
  readonly memoryPoolMb?: number;
  /** Memory budget of one child, in MiB. */
  readonly perChildMb?: number;
  /** Largest input accepted by the isolator, in bytes. */
  readonly maxInputBytes?: number;
  /** Wall-clock budget of one task, in milliseconds. */
  readonly maxTaskMillis?: number;
  /** V8 old-space size of each child, in MiB. */
  readonly heapMb?: number;
  /** Tasks allowed to wait for a free child before queue_full is raised. */
  readonly maxQueue?: number;
  /**
   * Allocated disk one child may hold in its private temporary directory, in MiB; the isolator kills the child above
   * it. The isolator checks the directory on a poll, so a child can overshoot between two samples.
   */
  readonly maxDiskMb?: number;
  /**
   * Opt-in reuse of isolation children for requests of one trust domain (docs/isolation.md, "Reusing children"). Off
   * unless `enabled`. It is not read by the isolator from here: `createNodeIsolator` takes it as its own `reuse`
   * option, and the CLI (flag, environment, file) passes it so.
   */
  readonly reuse?: IsolationReuseConfig;
}

/** `isolation.reuse` of a configuration file; the fields are those of the isolator's `ChildReuseOptions`, which says what each does. */
export interface IsolationReuseConfig {
  readonly enabled?: boolean;
  readonly trustDomain?: string;
  readonly maxRequests?: number;
  readonly rssCeilingMb?: number;
  readonly rssSampleEvery?: number;
  readonly idleTimeoutMs?: number;
  readonly maxIdleChildren?: number;
  readonly maxTrustDomains?: number;
}

/**
 * A document's failure in plain form. The values come from the isolation child, which parsed hostile input: treat
 * `name` and `message` as untrusted text (do not use `name` to select a class or code path).
 */
export interface IsolatedException {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

/** One parsed document (top-level or embedded) in plain, serializable form. */
export interface IsolatedParseRecord {
  readonly metadata: Record<string, readonly string[]>;
  readonly content: string;
  readonly embeddedResourcePath: string;
  /** `ParseRecord.pathParts`: the path as a list of whole names. */
  readonly pathParts?: readonly PathPart[];
  readonly depth: number;
  /** Media type as a string, e.g. "application/pdf". */
  readonly mediaType: string;
  /** Per-document failure; request-fatal failures are thrown instead. */
  readonly exception: IsolatedException | null;
  /** The embedded document's own bytes; only for a request with `unpackBytes`, and only when the document fit its budget. */
  readonly bytes?: Uint8Array;
  /** `ParseRecord.segments` without their text (it is `content.slice(start, end)`); only for a request with `segments`. */
  readonly segments?: readonly IsolatedSegment[];
}

/** A `Segment` as it crosses the boundary: its text is left out, being a slice of the record's content. */
export interface IsolatedSegment {
  readonly start: number;
  readonly end: number;
  readonly labels: readonly string[];
  readonly location: string;
}

/**
 * The limits that have a field of their own on an `IsolatedParseRequest` (and on the child's input header). Together with
 * `ISOLATED_LIMIT_NAMES` they are every `ParseLimits` member that crosses the isolation boundary.
 */
export const ISOLATED_FLAT_LIMIT_NAMES = ["maxOutputChars", "maxEmbeddedResources", "maxNodeDepth", "maxParseMillis"] as const;

/** The limits an `IsolatedParseRequest` carries in its `limits` object. */
export const ISOLATED_LIMIT_NAMES = [
  "maxDocumentOutputChars",
  "maxEmbeddedResourceBytes",
  "maxTotalEmbeddedBytes",
  "maxDecompressionRatio",
  "maxZipEntries",
  "maxMetadataValueChars",
  "maxMetadataTotalChars",
  "maxXmlEntityExpansions",
] as const;

/**
 * The only `ParseLimits` member that cannot cross: it is the isolation's own wall-clock budget (`IsolationConfig.maxTaskMillis`,
 * set once for the isolator), and it sizes the pool's deadlines and the child's CPU backstop. A request lowers the child's
 * parse timer with `maxParseMillis` instead.
 */
export const NON_CROSSING_LIMIT_NAMES = ["maxTaskMillis"] as const;

export type IsolatedLimitName = (typeof ISOLATED_LIMIT_NAMES)[number];

/** Every limit of a request that is not one of the four flat fields; each is `ParseLimits`' own member, with its meaning. */
export type IsolatedLimits = Partial<Pick<ParseLimits, IsolatedLimitName>>;

/** Compile-time proof that no `ParseLimits` member is missing from the three lists above. */
type UnlistedLimit = Exclude<
  keyof ParseLimits,
  (typeof ISOLATED_FLAT_LIMIT_NAMES)[number] | IsolatedLimitName | (typeof NON_CROSSING_LIMIT_NAMES)[number]
>;
const everyLimitIsListed: [UnlistedLimit] extends [never] ? true : never = true;
void everyLimitIsListed;

/**
 * Refuses `IsolatedParseRequest.limits` the child would misread: not an object, a name that is not one of
 * `ISOLATED_LIMIT_NAMES`, or a value `assertValidLimits` rejects. `maxMetadataTotalChars` may not exceed core's default:
 * a result frame is sized for that number of metadata characters. Throws RangeError naming every problem.
 */
export function assertValidIsolatedLimits(limits: unknown): void {
  if (limits === undefined) return;
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
    throw new RangeError(`invalid limits: expected an object, got ${limits === null ? "null" : Array.isArray(limits) ? "array" : typeof limits}`);
  }
  const names: readonly string[] = ISOLATED_LIMIT_NAMES;
  const strangers = Object.keys(limits).filter((name) => !names.includes(name) && (limits as Record<string, unknown>)[name] !== undefined);
  if (strangers.length > 0) {
    throw new RangeError(`request.limits cannot carry ${strangers.map((name) => `"${name}"`).join(", ")} (only ${names.join(", ")}; the rest have fields of their own)`);
  }
  assertValidLimits(limits as Partial<ParseLimits>);
  const total = (limits as IsolatedLimits).maxMetadataTotalChars;
  if (total !== undefined && total > DEFAULT_LIMITS.maxMetadataTotalChars) {
    throw new RangeError(
      `maxMetadataTotalChars ${total} is more than an isolated result can carry (${DEFAULT_LIMITS.maxMetadataTotalChars}); lower it`,
    );
  }
}

export interface IsolatedParseRequest {
  /**
   * Bytes, or a file path readable by the child. The caller must not mutate
   * the Uint8Array until the returned promise settles. A `{ path }` must be a
   * trusted local path chosen by the application, never derived from a
   * request.
   */
  readonly input: Uint8Array | { readonly path: string };
  readonly filename?: string;
  readonly maxOutputChars?: number;
  readonly maxEmbeddedResources?: number;
  /** Deepest embedded document the child parses (ParseLimits.maxNodeDepth). Omitted: core's default. */
  readonly maxNodeDepth?: number;
  /**
   * The child's own parse timer in ms (ParseLimits.maxParseMillis). It cannot exceed what the isolation allows a
   * task (its `maxTaskMillis` less the margin the parent keeps), and a larger value is refused. Omitted: the most
   * the isolation allows.
   */
  readonly maxParseMillis?: number;
  /**
   * The remaining per-request limits (`ParseLimits` members of the same name and meaning): zip and archive entries,
   * decompression ratio, per-entry and total embedded bytes, per-document output, metadata and XML entity caps. Together
   * with the four fields above they are every limit except `maxTaskMillis`. Omitted members: core's default. Validated
   * by `assertValidIsolatedLimits`.
   */
  readonly limits?: IsolatedLimits;
  /**
   * "text" (default): parse the top-level document and answer with
   * `kind: "text"`. "records": also parse embedded documents and answer with
   * `kind: "records"`.
   */
  readonly output?: "text" | "records";
  /**
   * `ParseOptions.onDocumentFailure: "record"`: a document that cannot be read is an answer carrying its failure
   * (`exception` of the text arm, of the first record of the records arm), not a thrown error. Timeouts, limits and
   * infrastructure faults are thrown either way. Omitted: false.
   */
  readonly recordFailures?: boolean;
  /**
   * `ParseOptions.onOutputLimit: "truncate"`: reaching `maxOutputChars` ends the parse with the text up to the limit
   * as the answer, and `tk:exception:write-limit-reached` on the metadata, instead of a thrown LimitExceededError.
   * Omitted: false.
   */
  readonly truncateOutput?: boolean;
  /**
   * `ParseOptions.onEmbeddedLimit: "truncate"`: an archive or container with more entries than `maxZipEntries` or
   * `maxEmbeddedResources` is read up to the limit, in archive order, and flagged with
   * `tk:exception:embedded-resource-limit-reached`, instead of a thrown LimitExceededError. Omitted: false.
   */
  readonly truncateEmbedded?: boolean;
  /**
   * `ParseOptions.emailHeaders`: an email's header block is written ahead of its body text (the default); false leaves
   * it out. Omitted: false.
   */
  readonly emailHeaders?: boolean;
  /**
   * `ParseOptions.handlerType`: the shape the content of the answer is written in (`text` of the text arm, `content` of
   * each record). Omitted: "text".
   */
  readonly handlerType?: HandlerType;
  /**
   * `ParseOptions.unpackBytes`: keep the bytes of the embedded documents, on `IsolatedParseRecord.bytes`, up to this
   * many in all. Only for `output: "records"`. They cross the boundary like the rest of the result, so the isolation's
   * result cap, its memory reservation and its own ceiling on this number all apply. Omitted: none.
   */
  readonly unpackBytes?: number;
  /**
   * `ParseOptions.segments`: label and locate the parts of each record, on `IsolatedParseRecord.segments`. Only for
   * `output: "records"` and a `handlerType` of text or body. They cross like the rest of the result, so they count
   * against the isolation's result cap. Omitted: false.
   */
  readonly segments?: boolean;
}

/** Narrow on `kind`; the arm always matches the request's `output`. */
export type IsolatedParseResult =
  | {
      readonly kind: "text";
      readonly metadata: Record<string, readonly string[]>;
      readonly text: string;
      /** The failure of a document that could not be read; only for a request with `recordFailures`. */
      readonly exception?: IsolatedException;
    }
  | { readonly kind: "records"; readonly records: readonly IsolatedParseRecord[] };

/**
 * Runs a whole parse inside a resource-budgeted boundary. The server, the pipes
 * engine and the CLI reach it through `createIsolatedRipstream`.
 *
 * This is a facade. The implementation owns routing (media-type detection and
 * the in-process safe allowlist), the init-time availability probe and any
 * lenient-mode fallback; the caller only passes bytes (or a trusted path).
 *
 * Failures are thrown as RipstreamError subclasses: IsolationError for
 * infrastructure problems, ParseTimeoutError / LimitExceededError /
 * MalformedDocumentError for document-caused ones. When `signal` aborts,
 * implementations classify `signal.reason`: a TimeoutError DOMException
 * becomes ParseTimeoutError, anything else becomes AbortError.
 */
export interface ParseIsolator {
  isolate(
    request: IsolatedParseRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<IsolatedParseResult>;
  dispose(): Promise<void>;
}
