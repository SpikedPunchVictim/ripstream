import type { Attributes } from "./attributes.ts";
import type { ContentHandler } from "./content-handler.ts";
import {
  chargeEmbeddedBytes,
  chargeEmbeddedResource,
  meterEmbeddedStream,
  ParsingEmbeddedDocumentExtractor,
  type EmbeddedDocumentExtractor,
} from "./embedded.ts";
import { LimitExceededError, type RipstreamError } from "./errors.ts";
import { MediaType } from "./media-type.ts";
import { Metadata } from "./metadata.ts";
import { CONTEXT_KEYS, type ParseContext } from "./parse-context.ts";
import type { Parser } from "./parser.ts";
import type { RipstreamInputStream } from "./ripstream-input-stream.ts";
import { ContentHandlerDecorator } from "./content-handler.ts";
import { BodyContentHandler } from "./handlers/text.ts";
import { markParseTiming } from "./rmeta.ts";

export interface ParseRecord {
  readonly metadata: Metadata;
  content: string;
  readonly embeddedResourcePath: string;
  readonly depth: number;
  mediaType: MediaType;
  exception: RipstreamError | Error | null;
}

/**
 * Wrapper that records the top-level document and every embedded document.
 * Embedded parsers are discovered through the context extractor, so archive
 * and document parsers must honor that key.
 */
export class RecursiveParserWrapper implements Parser {
  readonly name = "RecursiveParserWrapper";
  private readonly delegate: Parser;
  private readonly records: ParseRecord[] = [];

  constructor(delegate: Parser) {
    this.delegate = delegate;
  }

  getSupportedTypes(ctx: ParseContext): ReturnType<Parser["getSupportedTypes"]> {
    return this.delegate.getSupportedTypes(ctx);
  }

  getRecords(): readonly ParseRecord[] {
    return this.records;
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    this.records.length = 0;
    const name = metadata.get("resourceName") ?? "document";
    const path = `/${name}`;
    const record: ParseRecord = {
      metadata,
      content: "",
      embeddedResourcePath: path,
      depth: 0,
      mediaType: MediaType.OCTET_STREAM,
      exception: null,
    };
    this.records.push(record);

    ctx.set(CONTEXT_KEYS.EMBEDDED_BUDGET, { count: 0, bytes: 0 });
    const output = { chars: 0, limit: ctx.limits.maxOutputChars };
    const extractor = new RecordExtractor(this.records, output);
    ctx.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
    ctx.set(CONTEXT_KEYS.EMBEDDED_RESOURCE_PATH, path);

    const capture = new CapturingHandler(new OutputBudgetHandler(handler, output, ctx.limits.maxDocumentOutputChars));
    metadata.setMaxValueChars(ctx.limits.maxMetadataValueChars);
    const startedAt = performance.now();
    try {
      await this.delegate.parse(stream, capture, metadata, ctx);
    } catch (error) {
      record.exception = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      markParseTiming(metadata, startedAt);
      record.content = capture.content;
      const type = metadata.get("Content-Type");
      if (type !== null) record.mediaType = MediaType.parse(type) ?? record.mediaType;
    }
  }
}

class RecordExtractor implements EmbeddedDocumentExtractor {
  private readonly records: ParseRecord[];
  private readonly output: OutputBudget;

  constructor(records: ParseRecord[], output: OutputBudget) {
    this.records = records;
    this.output = output;
  }

  shouldParseEmbedded(): boolean {
    return true;
  }

  async parseEmbedded(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const depth = chargeEmbeddedResource(ctx);
    if (stream.length !== null) chargeEmbeddedBytes(ctx, stream.length);
    const parent = ctx.get(CONTEXT_KEYS.EMBEDDED_RESOURCE_PATH) ?? "";
    const name = metadata.get("resourceName") ?? "embedded";
    const path = `${parent}/${name}`.replace(/\/+/g, "/");

    const record: ParseRecord = {
      metadata,
      content: "",
      embeddedResourcePath: path,
      depth,
      mediaType: MediaType.OCTET_STREAM,
      exception: null,
    };
    this.records.push(record);

    const parser = ctx.get(CONTEXT_KEYS.PARSER) as Parser | undefined;
    if (parser === undefined) return;

    const child = ctx.createChild();
    child.set(CONTEXT_KEYS.EMBEDDED_DEPTH, depth);
    child.set(CONTEXT_KEYS.EMBEDDED_RESOURCE_PATH, path);
    child.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, this);

    const body = new BodyContentHandler();
    const capture = new OutputBudgetHandler(body, this.output, ctx.limits.maxDocumentOutputChars);
    metadata.setMaxValueChars(ctx.limits.maxMetadataValueChars);
    const startedAt = performance.now();
    let source = stream;
    try {
      if (stream.length === null) source = await meterEmbeddedStream(stream, ctx);
      await parser.parse(source, capture, metadata, child);
      record.content = body.toString();
      const type = metadata.get("Content-Type");
      if (type !== null) record.mediaType = MediaType.parse(type) ?? record.mediaType;
    } catch (error) {
      record.exception = error instanceof Error ? error : new Error(String(error));
      if (ctx.signal.aborted) throw error; // propagate aborts; don't swallow a timeout as success
    } finally {
      if (source !== stream) await source.close();
      markParseTiming(metadata, startedAt);
      metadata.set("X-TIKA:embedded_resource_path", path);
      metadata.set("X-TIKA:embedded_depth", String(depth));
    }

    // The text belongs to the embedded record only. Forwarding it to the
    // parent handler would copy it into every ancestor's record (O(depth*size)).
    void handler;
  }
}

interface OutputBudget {
  chars: number;
  readonly limit: number;
}

/** Counts characters against one budget shared by every record of a parse. */
class OutputBudgetHandler extends ContentHandlerDecorator {
  private readonly budget: OutputBudget;
  private readonly documentLimit: number | undefined;
  private documentChars = 0;

  constructor(delegate: ContentHandler, budget: OutputBudget, documentLimit?: number) {
    super(delegate);
    this.budget = budget;
    this.documentLimit = documentLimit;
  }

  override characters(ch: string, start: number, length: number): ReturnType<ContentHandler["startDocument"]> {
    this.count(length);
    return super.characters(ch, start, length);
  }

  override ignorableWhitespace(ch: string, start: number, length: number): ReturnType<ContentHandler["startDocument"]> {
    this.count(length);
    return super.ignorableWhitespace(ch, start, length);
  }

  private count(length: number): void {
    if (this.documentLimit !== undefined && this.documentLimit >= 0) {
      this.documentChars += length;
      if (this.documentChars > this.documentLimit) {
        throw new LimitExceededError(
          `Document output exceeds ${this.documentLimit} characters`,
        );
      }
    }
    if (this.budget.limit < 0) return;
    this.budget.chars += length;
    if (this.budget.chars > this.budget.limit) {
      throw new LimitExceededError(
        `Recursive output exceeds ${this.budget.limit} characters`,
      );
    }
  }
}

class CapturingHandler implements ContentHandler {
  private readonly delegate: ContentHandler;
  private captured = "";

  constructor(delegate: ContentHandler) {
    this.delegate = delegate;
  }

  get content(): string {
    return this.captured;
  }

  startDocument(): ReturnType<ContentHandler["startDocument"]> {
    return this.delegate.startDocument();
  }

  endDocument(): ReturnType<ContentHandler["endDocument"]> {
    return this.delegate.endDocument();
  }

  startElement(
    uri: string,
    localName: string,
    qName: string,
    attributes: Attributes,
  ): ReturnType<NonNullable<ContentHandler["startElement"]>> {
    return this.delegate.startElement?.(uri, localName, qName, attributes);
  }

  endElement(
    uri: string,
    localName: string,
    qName: string,
  ): ReturnType<NonNullable<ContentHandler["endElement"]>> {
    return this.delegate.endElement?.(uri, localName, qName);
  }

  characters(ch: string, start: number, length: number): ReturnType<NonNullable<ContentHandler["characters"]>> {
    this.captured += ch.slice(start, start + length);
    return this.delegate.characters?.(ch, start, length);
  }

  ignorableWhitespace(ch: string, start: number, length: number): ReturnType<NonNullable<ContentHandler["ignorableWhitespace"]>> {
    this.captured += ch.slice(start, start + length);
    return this.delegate.ignorableWhitespace?.(ch, start, length);
  }
}

export { ParsingEmbeddedDocumentExtractor };
