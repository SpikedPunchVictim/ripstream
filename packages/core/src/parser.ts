import type { ContentHandler, MaybePromise } from "./content-handler.ts";
import {
  MalformedDocumentError,
  ParserDeclinedError,
  RipstreamError,
  UnsupportedFormatError,
} from "./errors.ts";
import { MediaType } from "./media-type.ts";
import { Metadata } from "./metadata.ts";
import { CONTEXT_KEYS, type ParseContext } from "./parse-context.ts";
import type { RipstreamInputStream } from "./ripstream-input-stream.ts";

export interface ParserCapabilities {
  readonly requiresRandomAccess?: boolean;
  readonly metadataOnly?: boolean;
  readonly rendering?: boolean;
  readonly stateful?: boolean;
  readonly unsafe?: boolean;
  readonly maxConcurrency?: number;
}

export const DEFAULT_PARSER_CAPABILITIES: ParserCapabilities = Object.freeze({
  requiresRandomAccess: false,
  metadataOnly: false,
  rendering: false,
  stateful: false,
  unsafe: false,
});

export interface Parser {
  readonly name: string;
  readonly capabilities?: ParserCapabilities;
  getSupportedTypes(ctx: ParseContext): MaybePromise<ReadonlySet<MediaType>>;
  parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void>;
}

/** Resolves declared capabilities with safe defaults. */
export function parserCapabilities(parser: Parser): Required<
  Omit<ParserCapabilities, "maxConcurrency">
> & Pick<ParserCapabilities, "maxConcurrency"> {
  return {
    ...DEFAULT_PARSER_CAPABILITIES,
    ...parser.capabilities,
  } as Required<Omit<ParserCapabilities, "maxConcurrency">> &
    Pick<ParserCapabilities, "maxConcurrency">;
}

export interface Detector {
  detect(
    stream: RipstreamInputStream | null,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<MediaType>;
}

export interface CompositeParserOptions {
  readonly parsers?: readonly Parser[];
}

/**
 * Runs the best parser whose supported set matches the detected type.
 * Exact matches beat wildcard registrations; ties go to registration order.
 * ParserDeclinedError rewinds the stream and moves to the next candidate.
 */
export class CompositeParser implements Parser {
  readonly name = "CompositeParser";
  private readonly parsers: Parser[];

  constructor(options: CompositeParserOptions = {}) {
    this.parsers = [...(options.parsers ?? [])];
  }

  addParser(parser: Parser): void {
    this.parsers.push(parser);
  }

  getParsers(): readonly Parser[] {
    return this.parsers;
  }

  async getSupportedTypes(ctx: ParseContext): Promise<ReadonlySet<MediaType>> {
    const types = new Set<string>();
    for (const parser of this.parsers) {
      for (const type of await parser.getSupportedTypes(ctx)) {
        types.add(type.toString());
      }
    }
    return new Set([...types].map((type) => MediaType.parseOrThrow(type)));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const type = resolveContentType(metadata, ctx);
    if (type === null) {
      throw new UnsupportedFormatError("No content type available for parsing");
    }

    // Only one parser may consume the stream. Candidates are ordered by how
    // specifically they match (exact, then type/*, then */*), then registration
    // order; a parser that declines gets the stream rewound for the next one.
    const candidates: Array<{ parser: Parser; rank: number }> = [];
    for (const parser of this.parsers) {
      const rank = matchRank(await parser.getSupportedTypes(ctx), type);
      if (rank !== null) candidates.push({ parser, rank });
    }
    candidates.sort((a, b) => a.rank - b.rank);

    if (candidates.length === 0) {
      throw new UnsupportedFormatError(`No parser for ${type.toString()}`);
    }

    const start = stream.position;
    for (const [index, { parser }] of candidates.entries()) {
      if (index > 0) await stream.seek(start);
      try {
        await parser.parse(stream, handler, metadata, ctx);
        return;
      } catch (error) {
        if (error instanceof ParserDeclinedError) continue;
        if (error instanceof RipstreamError) throw error;
        // Backstop (#21): a parser leaked a raw library/runtime error. These are
        // overwhelmingly malformed-input failures, so map them to a 422-class
        // MalformedDocumentError instead of letting them read as a 500 server
        // fault. The original is preserved as `cause` and logged so its stack is
        // not lost; parsers that mean a genuine 500 throw a RipstreamError above.
        // Native aborts/timeouts surface here as DOMException("AbortError") but are
        // re-mapped to the correct status upstream — don't log those (stderr flood
        // under adversarial load); log only genuine library faults.
        if (!(error instanceof Error && error.name === "AbortError")) {
          console.error(
            `ripstream: parser ${parser.name} threw a non-Ripstream error`,
            error,
          );
        }
        throw new MalformedDocumentError(
          `Parser ${parser.name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
    // Every candidate declined: nothing parsed the document. Resolving here would
    // be a silent empty success, so report it as an unsupported format instead.
    throw new UnsupportedFormatError(
      `No parser accepted ${type.toString()}: all candidates declined`,
    );
  }
}

export interface AutoDetectParserOptions {
  readonly detector: Detector;
  readonly parser: Parser;
}

/** Detects the type, records it, then delegates to the selected parser. */
export class AutoDetectParser implements Parser {
  readonly name = "AutoDetectParser";
  private readonly detector: Detector;
  private readonly parser: Parser;

  constructor(options: AutoDetectParserOptions) {
    this.detector = options.detector;
    this.parser = options.parser;
  }

  getSupportedTypes(ctx: ParseContext): Promise<ReadonlySet<MediaType>> {
    return Promise.resolve(this.parser.getSupportedTypes(ctx));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const type = await this.detector.detect(stream, metadata, ctx);
    metadata.set("tk:content-type-magic-detected", type.toString());
    metadata.set("Content-Type", type.toString());
    ctx.set(CONTEXT_KEYS.CONTENT_TYPE, type);
    await this.parser.parse(stream, handler, metadata, ctx);
  }
}

export class EmptyParser implements Parser {
  readonly name = "EmptyParser";
  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.OCTET_STREAM]);
  }
  async parse(): Promise<void> {
    // Intentionally produces no events.
  }
}

export class ErrorParser implements Parser {
  readonly name = "ErrorParser";
  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.OCTET_STREAM]);
  }
  async parse(): Promise<void> {
    throw new UnsupportedFormatError("No parser accepts this document");
  }
}

/** Tries the primary parser, then the fallback after rewinding the stream. */
export class FallbackParser implements Parser {
  readonly name = "FallbackParser";
  readonly #primary: Parser;
  readonly #fallback: Parser;

  constructor(primary: Parser, fallback: Parser) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  getSupportedTypes(ctx: ParseContext): MaybePromise<ReadonlySet<MediaType>> {
    return this.#primary.getSupportedTypes(ctx);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    stream.mark();
    try {
      await this.#primary.parse(stream, handler, metadata, ctx);
    } catch (error) {
      await stream.reset();
      try {
        await this.#fallback.parse(stream, handler, metadata, ctx);
      } catch {
        throw error;
      }
    }
  }
}

/** Simple decorator base, matching upstream ParserDecorator. */
export class ParserDecorator implements Parser {
  readonly name: string;
  protected readonly delegate: Parser;

  constructor(delegate: Parser) {
    this.delegate = delegate;
    this.name = `Decorated(${delegate.name})`;
  }

  getSupportedTypes(ctx: ParseContext): MaybePromise<ReadonlySet<MediaType>> {
    return this.delegate.getSupportedTypes(ctx);
  }

  parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    return this.delegate.parse(stream, handler, metadata, ctx);
  }
}

/** Restricts a parser to an explicit set of media types. */
export class MimeFilteringDecorator extends ParserDecorator {
  readonly #allowed: ReadonlySet<string>;

  constructor(delegate: Parser, allowed: readonly MediaType[]) {
    super(delegate);
    this.#allowed = new Set(allowed.map((type) => type.getBaseType().toString()));
  }

  override async getSupportedTypes(ctx: ParseContext): Promise<ReadonlySet<MediaType>> {
    const supported = await this.delegate.getSupportedTypes(ctx);
    return new Set(
      [...supported].filter((type) => this.#allowed.has(type.getBaseType().toString())),
    );
  }
}

/** 0 = exact, 1 = type/*, 2 = star/star, null = no match. */
function matchRank(supported: ReadonlySet<MediaType>, type: MediaType): number | null {
  const base = type.getBaseType();
  let best: number | null = null;
  for (const candidate of supported) {
    let rank: number | null = null;
    if (candidate.equals(base)) rank = 0;
    else if (candidate.type === "*" && candidate.subtype === "*") rank = 2;
    else if (candidate.type === base.type && candidate.subtype === "*") rank = 1;
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  return best;
}

export function resolveContentType(
  metadata: Metadata,
  ctx: ParseContext,
): MediaType | null {
  const fromContext = ctx.get(CONTEXT_KEYS.CONTENT_TYPE) as MediaType | undefined;
  if (fromContext !== undefined) return fromContext;
  const fromMetadata = metadata.get("Content-Type");
  return fromMetadata === null ? null : MediaType.parse(fromMetadata);
}
