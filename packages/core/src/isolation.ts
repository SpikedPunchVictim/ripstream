/**
 * Parse-isolation port and configuration. Types are plain and serializable so
 * implementations (child process, worker, remote) can live outside core and
 * core stays runtime-neutral. The failure type is `IsolationError`
 * (errors.ts).
 */

import type { ComponentEntry } from "./component-config.ts";
import type { DigestSettings } from "./digest.ts";
import type { HandlerType } from "./handler-type.ts";

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
  readonly depth: number;
  /** Media type as a string, e.g. "application/pdf". */
  readonly mediaType: string;
  /** Per-document failure; request-fatal failures are thrown instead. */
  readonly exception: IsolatedException | null;
  /** The embedded document's own bytes; only for a request with `unpackBytes`, and only when the document fit its budget. */
  readonly bytes?: Uint8Array;
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
