import type { InputSource } from "./content-handler.ts";
import { MediaType } from "./media-type.ts";
import { Metadata } from "./metadata.ts";
import type { IsolatedException, IsolatedParseRecord, IsolatedParseRequest, ParseIsolator } from "./isolation.ts";
import type { HandlerType } from "./handler-type.ts";
import type { ParseRecord } from "./recursive.ts";
import { assertValidLimits, type ParseLimits } from "./parse-context.ts";
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

/** The limits an isolated request can carry. Everything else is the child's (core's default) or the isolator's. */
const CROSSING_LIMITS: ReadonlySet<string> = new Set(["maxOutputChars", "maxEmbeddedResources", "maxNodeDepth", "maxParseMillis"]);

/** The limits `options` names (an `undefined` names none), all of which must be able to cross. */
function crossingLimits(options: Partial<ParseLimits> | undefined): Partial<ParseLimits> {
  assertValidLimits(options);
  const limits: Record<string, number> = {};
  for (const [name, value] of Object.entries(options ?? {})) {
    if (value === undefined) continue;
    if (!CROSSING_LIMITS.has(name)) {
      throw new RangeError(
        `Limit "${name}" cannot cross the isolation boundary (only ${[...CROSSING_LIMITS].join(", ")} can)`,
      );
    }
    limits[name] = value as number;
  }
  return limits as Partial<ParseLimits>;
}

/**
 * A Ripstream-shaped front over a ParseIsolator, so code written against `parse` / `parseRecursive` (the server,
 * the pipes engine, the CLI) runs every parse across the isolation boundary without knowing it. Only what an
 * `IsolatedParseRequest` can express crosses: bytes or a `{ path }`, a filename, `maxOutputChars`,
 * `maxEmbeddedResources`, `maxNodeDepth`, `maxParseMillis` and the abort signal. Anything else (`contentType`, other limits, streams) is refused
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
      const answer = await isolate(source, parseOptions, "text");
      if (answer.kind !== "text") throw new TypeError(`The isolator answered a text request with "${answer.kind}"`);
      return {
        metadata: toMetadata(answer.metadata),
        text: answer.text,
        ...(answer.exception === undefined ? {} : { exception: toException(answer.exception) }),
      };
    },
    async parseRecursive(source, parseOptions = {}) {
      const answer = await isolate(source, parseOptions, "records");
      if (answer.kind !== "records") throw new TypeError(`The isolator answered a records request with "${answer.kind}"`);
      return answer.records.map((record) => toParseRecord(record, parseOptions.handlerType));
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
  const limits = { ...defaults, ...crossingLimits(options.limits) };
  return {
    input: toInput(source),
    ...(options.filename === undefined ? {} : { filename: options.filename }),
    ...(limits.maxOutputChars === undefined ? {} : { maxOutputChars: limits.maxOutputChars }),
    ...(limits.maxEmbeddedResources === undefined ? {} : { maxEmbeddedResources: limits.maxEmbeddedResources }),
    ...(limits.maxNodeDepth === undefined ? {} : { maxNodeDepth: limits.maxNodeDepth }),
    ...(limits.maxParseMillis === undefined ? {} : { maxParseMillis: limits.maxParseMillis }),
    ...(options.onDocumentFailure === "record" ? { recordFailures: true } : {}),
    ...(options.onOutputLimit === "truncate" ? { truncateOutput: true } : {}),
    ...(options.handlerType === undefined ? {} : { handlerType: options.handlerType }),
    // Only a records answer has records to hang bytes on.
    ...(options.unpackBytes === undefined || output !== "records" ? {} : { unpackBytes: options.unpackBytes }),
    output,
  };
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
    depth: record.depth,
    mediaType: MediaType.parse(record.mediaType) ?? MediaType.OCTET_STREAM,
    exception: record.exception === null ? null : toException(record.exception),
    ...(record.bytes === undefined ? {} : { bytes: record.bytes }),
  };
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
