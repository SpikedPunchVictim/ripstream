import {
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/**
 * Tika's EmptyParser for the types it detects but has no text extractor for: they parse as an empty document rather
 * than failing with UnsupportedFormatError. It is registered for named types only, so genuinely unknown input still
 * has no parser.
 */
export class EmptyFormatParser implements Parser {
  readonly name = "EmptyParser";
  readonly #types: ReadonlySet<MediaType>;

  constructor(types: readonly string[]) {
    this.#types = new Set(types.map((type) => MediaType.parse(type)!));
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return this.#types;
  }

  async parse(
    _stream: RipstreamInputStream,
    _handler: ContentHandler,
    _metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    // An empty document, as Tika's EmptyParser produces.
  }
}
