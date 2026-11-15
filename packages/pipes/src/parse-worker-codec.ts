import {
  AbortError,
  DEFAULT_LIMITS,
  EmptyDocumentError,
  EncryptedDocumentError,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  MissingDependencyError,
  ParseTimeoutError,
  ParserDeclinedError,
  RandomAccessUnavailableError,
  RequestTooLargeError,
  RipstreamConfigError,
  RipstreamError,
  TranslationError,
  UnsafePatternError,
  UnsupportedFormatError,
  UnsupportedRuntimeError,
  UrlSecurityError,
  VlmError,
  WriteLimitReachedError,
  ZeroByteFileError,
  type ComponentEntry,
  type DigestSettings,
  type HandlerType,
  type InputSource,
  type IsolationFailureReason,
  type ParseLimits,
  type ParseOptions,
  type ParseRecord,
  type ParseResult,
  type RipstreamConfig,
  type RipstreamErrorCode,
} from "@spikedpunch/ripstream-core";

/*
 * What crosses between the parse pool (parse-pool.ts) and its workers (parse-worker-main.ts): the spec a worker builds its
 * ripstream from, the input and options of a call, and what the call came to. Pure functions, no threads.
 *
 * Structured clone keeps an Error's name, message, stack and cause but builds a plain Error, and the engine and the CLI
 * test the class (`statusForParseError`, `exitCodeFor`). So errors cross as an EncodedError and are built again as the
 * nearest class this module knows, with the same name, message and fields.
 */

/** The `RipstreamConfig` fields `createRipstream({ config })` reads, as plain data. */
export interface WorkerConfigSections {
  readonly parsers?: readonly ComponentEntry[];
  readonly detectors?: readonly ComponentEntry[];
  readonly limits?: Readonly<Partial<ParseLimits>>;
  readonly digest?: DigestSettings;
  /** A path: `createRipstream` reads it in the worker, which shares this process's working directory. */
  readonly customMimeTypes?: string;
}

/** What a worker builds its ripstream from: `createRipstream({ config: new RipstreamConfig(sections), limits, digest })`. */
export interface WorkerRipstreamSpec {
  readonly sections?: WorkerConfigSections;
  readonly limits?: Partial<ParseLimits>;
  readonly digest?: DigestSettings;
}

/**
 * Every field of a RipstreamConfig, and whether the worker needs it. The type makes a new field a compile error until it
 * is placed here, so a section `createRipstream` reads cannot silently stay behind in the parent.
 */
export const CONFIG_FIELDS = {
  parsers: "worker",
  detectors: "worker",
  limits: "worker",
  digest: "worker",
  customMimeTypes: "worker",
  // Read by the parent only: the CLI and the pipes and server surfaces, not by a parse.
  generation: "parent",
  version: "parent",
  current: "parent",
  isolation: "parent",
  throwOnWriteLimit: "parent",
  metadataFilters: "parent",
  parseContextMetadataFilters: "parent",
  server: "parent",
  pipes: "parent",
  notices: "parent",
} as const satisfies Record<keyof RipstreamConfig, "worker" | "parent">;

export interface WorkerSpecOptions {
  readonly config?: RipstreamConfig;
  readonly limits?: Partial<ParseLimits>;
  readonly digest?: DigestSettings;
}

export function specOf(options: WorkerSpecOptions): WorkerRipstreamSpec {
  const config = options.config;
  const sections: WorkerConfigSections | undefined =
    config === undefined
      ? undefined
      : {
          ...(config.parsers === null ? {} : { parsers: config.parsers }),
          ...(config.detectors === null ? {} : { detectors: config.detectors }),
          ...(config.limits === null ? {} : { limits: config.limits }),
          ...(config.digest === null ? {} : { digest: config.digest }),
          ...(config.customMimeTypes === null ? {} : { customMimeTypes: config.customMimeTypes }),
        };
  return {
    ...(sections === undefined ? {} : { sections }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.digest === undefined ? {} : { digest: options.digest }),
  };
}

/** Bytes, or a file the worker reads itself. */
export type WireInput = Uint8Array | { readonly path: string };

/**
 * A call's input, ready to post: bytes are copied into a buffer of exactly their length, which is transferred. A view
 * would otherwise take its whole backing buffer across, and the caller's buffer must stay usable (UNPACK reads the
 * input again after the parse).
 */
export function wireInput(source: InputSource): { readonly input: WireInput; readonly transfer: ArrayBuffer[] } {
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
    // `new Uint8Array(arrayBuffer)` is a view of it, not a copy.
    const copy = source instanceof ArrayBuffer ? new Uint8Array(source.slice(0)) : new Uint8Array(source);
    return { input: copy, transfer: [copy.buffer] };
  }
  if (isPathSource(source)) return { input: { path: source.path }, transfer: [] };
  throw new TypeError(UNSUPPORTED_INPUT);
}

const UNSUPPORTED_INPUT = "the parse pool takes the input as bytes (a Uint8Array or an ArrayBuffer) or as a { path }";

/** Throws, as `wireInput` would, for an input the pool cannot take; copies nothing. */
export function assertWireInput(source: InputSource): void {
  if (!(source instanceof Uint8Array || source instanceof ArrayBuffer || isPathSource(source))) throw new TypeError(UNSUPPORTED_INPUT);
}

/**
 * The maxParseMillis a call runs under, as the worker's ripstream works it out: the call's own limit, else the pool's,
 * else the configuration's, else the default. 0 is no limit.
 */
export function effectiveParseMillis(spec: WorkerRipstreamSpec, call: Partial<ParseLimits> | undefined): number {
  for (const layer of [call, spec.limits, spec.sections?.limits]) {
    const millis = layer?.maxParseMillis;
    if (millis !== undefined) return millis;
  }
  return DEFAULT_LIMITS.maxParseMillis;
}

function isPathSource(source: InputSource): source is { readonly path: string } {
  return typeof source === "object" && source !== null && typeof (source as { path?: unknown }).path === "string" && !("url" in source);
}

/** The ParseOptions a worker gets: all of them but the signal, which stays here. */
export interface WireParseOptions {
  readonly filename?: string;
  readonly contentType?: string;
  readonly password?: string;
  readonly limits?: Partial<ParseLimits>;
  readonly onDocumentFailure?: "throw" | "record";
  readonly onOutputLimit?: "throw" | "truncate";
  readonly handlerType?: HandlerType;
  readonly unpackBytes?: number;
  readonly segments?: boolean;
}

/**
 * Every ParseOptions field, and how it crosses. A new option is a compile error until it is placed here.
 */
const PARSE_OPTION_FIELDS = {
  filename: "copied",
  contentType: "copied",
  password: "copied",
  limits: "copied",
  onDocumentFailure: "copied",
  onOutputLimit: "copied",
  handlerType: "copied",
  unpackBytes: "copied",
  segments: "copied",
  signal: "parent",
} as const satisfies Record<keyof ParseOptions, "copied" | "parent">;

export function wireOptions(options: ParseOptions): WireParseOptions {
  if (options.password !== undefined && typeof options.password !== "string") {
    throw new TypeError("the parse pool takes a password as a string: a PasswordProvider cannot cross to a worker thread");
  }
  const wire: Record<string, unknown> = {};
  for (const [name, how] of Object.entries(PARSE_OPTION_FIELDS)) {
    const value = (options as Record<string, unknown>)[name];
    if (how === "copied" && value !== undefined) wire[name] = value;
  }
  return wire as WireParseOptions;
}

// --- Errors ---------------------------------------------------------------------------------------------------------

/** A primitive own property of an error, or a list of strings (RipstreamConfigError.issues). */
export type ErrorProp = string | number | boolean | null | readonly string[];

export type EncodedError =
  | {
      readonly kind: KnownErrorKind;
      readonly name: string;
      readonly message: string;
      readonly stack?: string;
      /** Own enumerable properties other than name and message: code, recoverable, limit, reason, issues, errno, ... */
      readonly props: Readonly<Record<string, ErrorProp>>;
      readonly cause?: EncodedError;
      /** AggregateError only. */
      readonly errors?: readonly EncodedError[];
    }
  /** A thrown value that is not an object: it crosses as it is. */
  | { readonly kind: "value"; readonly value: string | number | boolean | bigint | null | undefined }
  /** A thrown object that is not an Error: what String() makes of it. */
  | { readonly kind: "object"; readonly text: string };

/** How deep a cause chain (and an AggregateError's list) is followed. */
const MAX_CAUSE_DEPTH = 4;

type Props = Readonly<Record<string, ErrorProp>>;
const text = (props: Props, name: string): string => String(props[name] ?? "");

/**
 * The classes an error is built again as, each from its encoded fields. An error of a class not here is built as the
 * nearest one that is, in its prototype chain, with its own name: a private `class XmlDepthError extends
 * MalformedDocumentError` is a MalformedDocumentError named "XmlDepthError", which is all anything outside it can tell.
 * Keep it in step with the Error classes core exports (a test checks it).
 */
const ERROR_CLASSES = {
  // Most specific first: the chain is walked from the error up, and the first class found wins.
  ZeroByteFileError: { type: ZeroByteFileError, make: () => new ZeroByteFileError() },
  AbortError: { type: AbortError, make: (message: string) => new AbortError(message) },
  EmptyDocumentError: { type: EmptyDocumentError, make: (message: string) => new EmptyDocumentError(message) },
  EncryptedDocumentError: { type: EncryptedDocumentError, make: (message: string) => new EncryptedDocumentError(message) },
  IsolationError: {
    type: IsolationError,
    make: (message: string, props: Props) => new IsolationError(text(props, "reason") as IsolationFailureReason, message),
  },
  LimitExceededError: { type: LimitExceededError, make: (message: string) => new LimitExceededError(message) },
  MalformedDocumentError: { type: MalformedDocumentError, make: (message: string) => new MalformedDocumentError(message) },
  MissingDependencyError: {
    type: MissingDependencyError,
    make: (_message: string, props: Props) => new MissingDependencyError(text(props, "dependency"), text(props, "capability")),
  },
  ParseTimeoutError: { type: ParseTimeoutError, make: (message: string) => new ParseTimeoutError(message) },
  ParserDeclinedError: { type: ParserDeclinedError, make: (message: string) => new ParserDeclinedError(message) },
  RandomAccessUnavailableError: { type: RandomAccessUnavailableError, make: (message: string) => new RandomAccessUnavailableError(message) },
  RequestTooLargeError: { type: RequestTooLargeError, make: (message: string) => new RequestTooLargeError(message) },
  TranslationError: { type: TranslationError, make: (message: string) => new TranslationError(message) },
  UnsupportedFormatError: { type: UnsupportedFormatError, make: (message: string) => new UnsupportedFormatError(message) },
  UnsupportedRuntimeError: { type: UnsupportedRuntimeError, make: (message: string) => new UnsupportedRuntimeError(message) },
  WriteLimitReachedError: {
    type: WriteLimitReachedError,
    make: (_message: string, props: Props) => new WriteLimitReachedError(Number(props["limit"] ?? 0)),
  },
  RipstreamError: {
    type: RipstreamError,
    make: (message: string, props: Props) => new RipstreamError(text(props, "code") as RipstreamErrorCode, message),
  },
  RipstreamConfigError: {
    type: RipstreamConfigError,
    make: (_message: string, props: Props) => new RipstreamConfigError(stringList(props["issues"])),
  },
  UrlSecurityError: { type: UrlSecurityError, make: (message: string) => new UrlSecurityError(message) },
  UnsafePatternError: { type: UnsafePatternError, make: (message: string) => new UnsafePatternError(message) },
  VlmError: { type: VlmError, make: (message: string) => new VlmError(message) },
  // The language's own, last: every class above is one of them too.
  AggregateError: { type: AggregateError, make: (message: string) => new AggregateError([], message) },
  TypeError: { type: TypeError, make: (message: string) => new TypeError(message) },
  RangeError: { type: RangeError, make: (message: string) => new RangeError(message) },
  SyntaxError: { type: SyntaxError, make: (message: string) => new SyntaxError(message) },
  ReferenceError: { type: ReferenceError, make: (message: string) => new ReferenceError(message) },
  EvalError: { type: EvalError, make: (message: string) => new EvalError(message) },
  URIError: { type: URIError, make: (message: string) => new URIError(message) },
  // Its name and message are getters: it is made from them, never assigned to.
  DOMException: { type: DOMException, make: (message: string, _props: Props, name: string) => new DOMException(message, name) },
  Error: { type: Error, make: (message: string) => new Error(message) },
} satisfies Record<string, { readonly type: abstract new (...args: never[]) => Error; readonly make: (message: string, props: Props, name: string) => Error }>;

export type KnownErrorKind = keyof typeof ERROR_CLASSES;

/** The classes the codec builds again, by kind (for the test that keeps them in step with core). */
export const KNOWN_ERROR_CLASSES: ReadonlyMap<KnownErrorKind, abstract new (...args: never[]) => Error> = new Map(
  Object.entries(ERROR_CLASSES).map(([kind, entry]) => [kind as KnownErrorKind, entry.type]),
);

function stringList(value: ErrorProp | undefined): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function kindOf(error: Error): KnownErrorKind {
  for (const [kind, entry] of Object.entries(ERROR_CLASSES)) {
    if (error instanceof entry.type) return kind as KnownErrorKind;
  }
  return "Error";
}

/** Properties that are not copied as props: they cross by their own fields, or are not data. */
const OWN_FIELDS = new Set(["name", "message", "stack", "cause", "errors"]);

function propsOf(error: Error): Record<string, ErrorProp> {
  const props: Record<string, ErrorProp> = {};
  for (const [key, value] of Object.entries(error)) {
    if (OWN_FIELDS.has(key)) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      props[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      props[key] = [...(value as string[])];
    }
  }
  return props;
}

export function encodeError(error: unknown, depth = 0): EncodedError {
  if (!(error instanceof Error)) {
    if (error === null || (typeof error !== "object" && typeof error !== "function" && typeof error !== "symbol")) {
      return { kind: "value", value: error as string | number | boolean | bigint | null | undefined };
    }
    return { kind: "object", text: safeString(error) };
  }
  const nested = depth < MAX_CAUSE_DEPTH;
  const cause = "cause" in error && nested ? encodeError(error.cause, depth + 1) : undefined;
  const errors = error instanceof AggregateError && nested ? [...(error.errors as unknown[])].map((each) => encodeError(each, depth + 1)) : undefined;
  return {
    kind: kindOf(error),
    name: String(error.name),
    message: String(error.message),
    ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
    props: propsOf(error),
    ...(cause === undefined ? {} : { cause }),
    ...(errors === undefined ? {} : { errors }),
  };
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * The error that was encoded, built again. It never throws: an encoding it cannot read gives a plain Error with the
 * name and message it carries, so a bad message from a worker cannot break the parent's listener.
 */
export function decodeError(encoded: EncodedError): unknown {
  try {
    return revive(encoded);
  } catch {
    const fallback = new Error(readableField(encoded, "message", "a parse worker failed with an error that could not be read"));
    fallback.name = readableField(encoded, "name", "Error");
    return fallback;
  }
}

function readableField(encoded: unknown, field: string, otherwise: string): string {
  const value = typeof encoded === "object" && encoded !== null ? (encoded as Record<string, unknown>)[field] : undefined;
  return typeof value === "string" ? value : otherwise;
}

function revive(encoded: EncodedError): unknown {
  if (encoded.kind === "value") return encoded.value;
  if (encoded.kind === "object") return encoded.text;
  const entry = ERROR_CLASSES[encoded.kind];
  if (entry === undefined) throw new TypeError(`unknown error kind ${String(encoded.kind)}`);
  const error = entry.make(encoded.message, encoded.props, encoded.name);
  if (encoded.kind !== "DOMException") {
    if (error.message !== encoded.message) define(error, "message", encoded.message, false);
    if (error.name !== encoded.name) define(error, "name", encoded.name, true);
    for (const [key, value] of Object.entries(encoded.props)) define(error, key, Array.isArray(value) ? Object.freeze([...value]) : value, true);
  }
  if (encoded.stack !== undefined) define(error, "stack", encoded.stack, false);
  if (encoded.cause !== undefined) define(error, "cause", revive(encoded.cause), false);
  if (encoded.errors !== undefined && error instanceof AggregateError) define(error, "errors", encoded.errors.map(revive), false);
  return error;
}

function define(target: object, key: string, value: unknown, enumerable: boolean): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable });
}

// --- Results --------------------------------------------------------------------------------------------------------

/** A Metadata as its names in order, each with its values: the order is what rmeta JSON is written in. */
export type EncodedMetadata = readonly (readonly [name: string, values: readonly string[]])[];

export function encodeMetadata(metadata: Metadata): EncodedMetadata {
  return metadata.names().map((name) => [name, [...metadata.getAll(name)]] as const);
}

export function decodeMetadata(encoded: EncodedMetadata): Metadata {
  const metadata = new Metadata();
  for (const [name, values] of encoded) metadata.setAll(name, values);
  return metadata;
}

/** A MediaType as its parts: its string form does not survive a parameter holding `;`, `,`, `=`, `\` or `"`. */
export interface EncodedMediaType {
  readonly type: string;
  readonly subtype: string;
  readonly parameters: readonly (readonly [string, string])[];
}

export function encodeMediaType(mediaType: MediaType): EncodedMediaType {
  return { type: mediaType.type, subtype: mediaType.subtype, parameters: [...mediaType.parameters] };
}

export function decodeMediaType(encoded: EncodedMediaType): MediaType {
  return new MediaType(encoded.type, encoded.subtype, new Map(encoded.parameters));
}

export interface EncodedParseResult {
  readonly metadata: EncodedMetadata;
  readonly text: string;
  readonly exception?: EncodedError;
}

export function encodeParseResult(result: ParseResult): EncodedParseResult {
  return {
    metadata: encodeMetadata(result.metadata),
    text: result.text,
    ...(result.exception === undefined ? {} : { exception: encodeError(result.exception) }),
  };
}

export function decodeParseResult(encoded: EncodedParseResult): ParseResult {
  return {
    metadata: decodeMetadata(encoded.metadata),
    text: encoded.text,
    ...(encoded.exception === undefined ? {} : { exception: decodeError(encoded.exception) as Error }),
  };
}

/**
 * A record with its Metadata, MediaType and exception encoded. Every other field is plain data and crosses as it is, so
 * a field added to ParseRecord later is carried without a change here.
 */
export type EncodedRecord = Omit<ParseRecord, "metadata" | "mediaType" | "exception"> & {
  readonly metadata: EncodedMetadata;
  readonly mediaType: EncodedMediaType;
  readonly exception: EncodedError | null;
};

/** Each record's bytes are copied into a buffer of their own, to transfer: records may be views of one buffer. */
export function encodeRecords(records: readonly ParseRecord[]): { readonly records: EncodedRecord[]; readonly transfer: ArrayBuffer[] } {
  const transfer: ArrayBuffer[] = [];
  const encoded = records.map((record): EncodedRecord => {
    const { metadata, mediaType, exception, bytes, ...rest } = record;
    let copy: Uint8Array<ArrayBuffer> | undefined;
    if (bytes !== undefined) {
      copy = new Uint8Array(bytes);
      transfer.push(copy.buffer);
    }
    return {
      ...rest,
      metadata: encodeMetadata(metadata),
      mediaType: encodeMediaType(mediaType),
      exception: exception === null ? null : encodeError(exception),
      ...(copy === undefined ? {} : { bytes: copy }),
    };
  });
  return { records: encoded, transfer };
}

// --- Messages -------------------------------------------------------------------------------------------------------

/** What a worker is started with. */
export interface WorkerData {
  readonly spec: WorkerRipstreamSpec;
}

/** Parent to worker: one task at a time, and only to a worker that said it is ready. */
export interface TaskMessage {
  readonly t: "task";
  readonly id: number;
  readonly op: "parse" | "parseRecursive";
  readonly input: WireInput;
  readonly options: WireParseOptions;
}

/** Parent to worker: stop a task (its caller has already been answered). */
export interface AbortMessage {
  readonly t: "abort";
  readonly id: number;
}

export type ParentMessage = TaskMessage | AbortMessage;

/** Worker to parent. */
export type WorkerMessage =
  | { readonly t: "ready" }
  | { readonly t: "init-error"; readonly error: EncodedError }
  | { readonly t: "done"; readonly id: number; readonly op: "parse"; readonly result: EncodedParseResult }
  | { readonly t: "done"; readonly id: number; readonly op: "parseRecursive"; readonly records: readonly EncodedRecord[] }
  | { readonly t: "failed"; readonly id: number; readonly error: EncodedError };

export function decodeRecords(records: readonly EncodedRecord[]): ParseRecord[] {
  return records.map(({ metadata, mediaType, exception, ...rest }) => ({
    ...rest,
    metadata: decodeMetadata(metadata),
    mediaType: decodeMediaType(mediaType),
    exception: exception === null ? null : (decodeError(exception) as Error),
  }));
}
