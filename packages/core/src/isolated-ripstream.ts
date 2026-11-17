import type { InputSource } from "./content-handler.ts";
import { MediaType } from "./media-type.ts";
import { Metadata } from "./metadata.ts";
import {
  ISOLATED_FLAT_LIMIT_NAMES,
  ISOLATED_LIMIT_NAMES,
  assertValidIsolatedLimits,
  type IsolatedException,
  type IsolatedLimits,
  type IsolatedParseRecord,
  type IsolatedParseRequest,
  type ParseIsolator,
} from "./isolation.ts";
import { assertHandlerType, type HandlerType } from "./handler-type.ts";
import type { ParseRecord } from "./recursive.ts";
import type { Segment } from "./segments.ts";
import { assertValidLimits, type ParseLimits } from "./parse-context.ts";
import { assertLowYieldPolicy, enforceLowYield, recordWarnings } from "./warnings.ts";
import type { MediaTypeResult, ParseOptions, ParseResult } from "./ripstream.ts";

/** The part of a Ripstream that servers, pipes and the CLI call. */
export interface IsolatedRipstream {
  detect(source: InputSource | null, options?: { filename?: string; signal?: AbortSignal }): Promise<MediaTypeResult>;
  parse(source: InputSource, options?: ParseOptions): Promise<ParseResult>;
  parseRecursive(source: InputSource, options?: ParseOptions): Promise<readonly ParseRecord[]>;
}

export interface IsolatedRipstreamOptions {
  readonly isolator: ParseIsolator;
  /**
   * Answers `detect`. Detection stays in this process: no isolated "detect" request exists, and the isolator's own
   * routing detects on a bounded prefix. Pass a Ripstream (it satisfies this).
   */
  readonly detector: Pick<IsolatedRipstream, "detect">;
  /**
   * Limits every parse starts from; a limit a call names in its own `limits` wins. Only the limits a request can
   * carry are accepted, so a default that would be silently dropped is refused here, not at the first parse.
   */
  readonly limits?: Partial<ParseLimits>;
}

/** The limits an isolated request carries: every `ParseLimits` member but `maxTaskMillis` (the isolation's own budget). */
const CROSSING_LIMITS: ReadonlySet<string> = new Set([...ISOLATED_FLAT_LIMIT_NAMES, ...ISOLATED_LIMIT_NAMES]);

/** The limits `options` names (an `undefined` names none), all of which must be able to cross. */
function crossingLimits(options: Partial<ParseLimits> | undefined): Partial<ParseLimits> {
  assertValidLimits(options);
  const limits: Record<string, number> = {};
  for (const [name, value] of Object.entries(options ?? {})) {
    if (value === undefined) continue;
    if (!CROSSING_LIMITS.has(name)) {
      throw new RangeError(
        `Limit "${name}" cannot cross the isolation boundary: it is the isolation's own budget (IsolationConfig.${name}); ` +
          "name maxParseMillis to shorten one parse",
      );
    }
    limits[name] = value as number;
  }
  assertValidIsolatedLimits(extraLimits(limits as Partial<ParseLimits>)); // the ceilings the child's frames impose
  return limits as Partial<ParseLimits>;
}

/**
 * A Ripstream-shaped front over a ParseIsolator, so code written against `parse` / `parseRecursive` (the server,
 * the pipes engine, the CLI) runs every parse across the isolation boundary without knowing it. Only what an
 * `IsolatedParseRequest` can express crosses: bytes or a `{ path }`, a filename, every limit but `maxTaskMillis` (the
 * isolation's own budget, refused) and the abort signal. Anything else (`contentType`, `password`, streams) is refused
 * before anything is isolated, because ignoring it would silently change the parse.
 */
export function createIsolatedRipstream(options: IsolatedRipstreamOptions): IsolatedRipstream {
  const { isolator, detector } = options;
  const defaults = crossingLimits(options.limits);

  async function isolate(source: InputSource, parseOptions: ParseOptions, output: "text" | "records") {
    const request = toRequest(source, parseOptions, output, defaults);
    return isolator.isolate(request, parseOptions.signal === undefined ? {} : { signal: parseOptions.signal });
  }

  return {
    detect: (source, detectOptions) => detector.detect(source, detectOptions),
    async parse(source, parseOptions = {}) {
      assertLowYieldPolicy(parseOptions.onLowYield);
      const answer = await isolate(source, parseOptions, "text");
      if (answer.kind !== "text") throw new TypeError(`The isolator answered a text request with "${answer.kind}"`);
      // The child recorded the warnings and sent them; the policy is applied here, on what arrived, as in process.
      const warnings = answer.warnings ?? [];
      enforceLowYield(parseOptions.onLowYield, warnings);
      return {
        metadata: toMetadata(answer.metadata),
        text: answer.text,
        warnings,
        ...(answer.exception === undefined ? {} : { exception: toException(answer.exception) }),
      };
    },
    async parseRecursive(source, parseOptions = {}) {
      assertLowYieldPolicy(parseOptions.onLowYield);
      const answer = await isolate(source, parseOptions, "records");
      if (answer.kind !== "records") throw new TypeError(`The isolator answered a records request with "${answer.kind}"`);
      const records = answer.records.map((record) => toParseRecord(record, parseOptions.handlerType));
      enforceLowYield(parseOptions.onLowYield, recordWarnings(records));
      return records;
    },
  };
}

function toRequest(
  source: InputSource,
  options: ParseOptions,
  output: "text" | "records",
  defaults: Partial<ParseLimits>,
): IsolatedParseRequest {
  if (options.contentType !== undefined) {
    throw new TypeError("ParseOptions.contentType cannot cross the isolation boundary; the child detects the type itself");
  }
  if (options.password !== undefined) {
    throw new TypeError("ParseOptions.password cannot cross the isolation boundary: a request carries no password, so the parse would run without it");
  }
  if (options.segments !== undefined && typeof options.segments !== "boolean") {
    throw new TypeError(`segments must be a boolean, got ${typeof options.segments}`);
  }
  const handlerType = options.handlerType === undefined ? undefined : assertHandlerType(options.handlerType);
  if (options.emailHeaders !== undefined && typeof options.emailHeaders !== "boolean") {
    throw new TypeError(`emailHeaders must be a boolean, got ${typeof options.emailHeaders}`);
  }
  const limits = { ...defaults, ...crossingLimits(options.limits) };
  const rest = extraLimits(limits);
  return {
    input: toInput(source),
    ...(options.filename === undefined ? {} : { filename: options.filename }),
    ...(limits.maxOutputChars === undefined ? {} : { maxOutputChars: limits.maxOutputChars }),
    ...(limits.maxEmbeddedResources === undefined ? {} : { maxEmbeddedResources: limits.maxEmbeddedResources }),
    ...(limits.maxNodeDepth === undefined ? {} : { maxNodeDepth: limits.maxNodeDepth }),
    ...(limits.maxParseMillis === undefined ? {} : { maxParseMillis: limits.maxParseMillis }),
    ...(rest === undefined ? {} : { limits: rest }),
    ...(options.onDocumentFailure === "record" ? { recordFailures: true } : {}),
    ...(options.onOutputLimit === "truncate" ? { truncateOutput: true } : {}),
    ...(options.onEmbeddedLimit === "truncate" ? { truncateEmbedded: true } : {}),
    ...(options.emailHeaders === undefined ? {} : { emailHeaders: options.emailHeaders }),
    ...(handlerType === undefined ? {} : { handlerType }),
    // Only a records answer has records to hang bytes on.
    ...(options.unpackBytes === undefined || output !== "records" ? {} : { unpackBytes: options.unpackBytes }),
    ...(options.segments === true && output === "records" ? { segments: true } : {}),
    output,
  };
}

/** The limits that ride in the request's `limits` object (those without a field of their own), or undefined for none. */
function extraLimits(limits: Partial<ParseLimits>): IsolatedLimits | undefined {
  const picked: Record<string, number> = {};
  for (const name of ISOLATED_LIMIT_NAMES) {
    const value = limits[name];
    if (value !== undefined) picked[name] = value;
  }
  return Object.keys(picked).length === 0 ? undefined : (picked as IsolatedLimits);
}

function toInput(source: InputSource): Uint8Array | { readonly path: string } {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (
    typeof source === "object" &&
    source !== null &&
    !(source instanceof Blob) &&
    !(source instanceof ReadableStream) &&
    "path" in source &&
    typeof source.path === "string"
  ) {
    return { path: source.path };
  }
  throw new TypeError("An isolated parse takes bytes or a { path }; streams, blobs and URLs are not supported");
}

function toMetadata(values: Readonly<Record<string, readonly string[]>>): Metadata {
  const metadata = new Metadata();
  for (const [name, list] of Object.entries(values)) {
    for (const value of list) metadata.add(name, value);
  }
  return metadata;
}

function toParseRecord(record: IsolatedParseRecord, handlerType: HandlerType | undefined): ParseRecord {
  return {
    ...(handlerType === undefined ? {} : { handlerType }),
    metadata: toMetadata(record.metadata),
    content: record.content,
    embeddedResourcePath: record.embeddedResourcePath,
    ...(record.pathParts === undefined ? {} : { pathParts: record.pathParts }),
    depth: record.depth,
    mediaType: MediaType.parse(record.mediaType) ?? MediaType.OCTET_STREAM,
    exception: record.exception === null ? null : toException(record.exception),
    warnings: record.warnings ?? [],
    ...(record.bytes === undefined ? {} : { bytes: record.bytes }),
    ...(record.segments === undefined ? {} : { segments: toSegments(record) }),
  };
}

/** The segments of a record, their text cut from its content again (the frames checked the offsets against it). */
function toSegments(record: IsolatedParseRecord): readonly Segment[] {
  return (record.segments ?? []).map(({ start, end, labels, location }) =>
    Object.freeze({ text: record.content.slice(start, end), start, end, labels, location }),
  );
}

/**
 * The child's exception text is untrusted display data. It becomes a plain `Error` (never one of our classes), so
 * nothing downstream can mistake a document's own words for an infrastructure verdict.
 */
function toException(exception: IsolatedException): Error {
  const error = new Error(exception.message);
  error.name = exception.name;
  return error;
}
