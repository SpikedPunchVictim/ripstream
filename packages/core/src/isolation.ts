/**
 * Parse-isolation port and configuration. Types are plain and serializable so
 * implementations (child process, worker, remote) can live outside core and
 * core stays runtime-neutral. The failure type is `IsolationError`
 * (errors.ts).
 */

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
}

/** One parsed document (top-level or embedded) in plain, serializable form. */
export interface IsolatedParseRecord {
  readonly metadata: Record<string, readonly string[]>;
  readonly content: string;
  readonly embeddedResourcePath: string;
  readonly depth: number;
  /** Media type as a string, e.g. "application/pdf". */
  readonly mediaType: string;
  /**
   * Per-document failure; request-fatal failures are thrown instead. The
   * values come from the isolation child, which parsed hostile input: treat
   * `name` and `message` as untrusted text (do not use `name` to select a
   * class or code path).
   */
  readonly exception: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
  } | null;
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
  /**
   * "text" (default): parse the top-level document and answer with
   * `kind: "text"`. "records": also parse embedded documents and answer with
   * `kind: "records"`.
   */
  readonly output?: "text" | "records";
}

/** Narrow on `kind`; the arm always matches the request's `output`. */
export type IsolatedParseResult =
  | {
      readonly kind: "text";
      readonly metadata: Record<string, readonly string[]>;
      readonly text: string;
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
