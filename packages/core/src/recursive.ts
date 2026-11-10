import type { ContentHandler, MaybePromise } from "./content-handler.ts";
import {
  chargeEmbeddedBytes,
  chargeEmbeddedResource,
  meterEmbeddedStream,
  ParsingEmbeddedDocumentExtractor,
  type EmbeddedDocumentExtractor,
} from "./embedded.ts";
import { LimitExceededError, WriteLimitReachedError, type RipstreamError } from "./errors.ts";
import { classifyFailure, isWriteLimitReached } from "./failure.ts";
import { MediaType } from "./media-type.ts";
import { Metadata } from "./metadata.ts";
import { CONTEXT_KEYS, type ParseContext } from "./parse-context.ts";
import type { Parser } from "./parser.ts";
import type { RipstreamInputStream } from "./ripstream-input-stream.ts";
import { ContentHandlerDecorator } from "./content-handler.ts";
import { TeeContentHandler } from "./handlers/tee.ts";
import { createOutputHandler, type HandlerType } from "./handler-type.ts";
import { markParseTiming } from "./rmeta.ts";
import { CONTENT_LENGTH, TIKA_KEYS } from "./tika-keys.ts";

export interface ParseRecord {
  readonly metadata: Metadata;
  content: string;
  readonly embeddedResourcePath: string;
  readonly depth: number;
  mediaType: MediaType;
  exception: RipstreamError | Error | null;
  /** The shape `content` is written in (default "text"); the `tk:content-handler-type` of the record. */
  readonly handlerType?: HandlerType;
  /**
   * The embedded document's own bytes, as they were before it was parsed. Only embedded records carry them, and only
   * when `ParseOptions.unpackBytes` asked: a document that would take the total past that budget has none.
   */
  bytes?: Uint8Array;
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
  private readonly recordFailures: boolean;
  private readonly truncateOutput: boolean;
  private readonly handlerType: HandlerType;
  private readonly unpackBytes: number | undefined;

  /**
   * `recordFailures`: a container with no parser to take it is an empty document, as with Tika's EmptyParser, not
   * a failure. Every other failure of the container is noted the same way and still thrown; the caller decides
   * whether the records it keeps are an answer (see `Ripstream.parseRecursive`).
   *
   * `truncateOutput`: reaching `maxOutputChars` ends the parse instead of failing it. The text up to the limit is
   * kept, the records parsed so far are the answer, and `tk:exception:write-limit-reached` is set on the container
   * and on the document whose text was cut. Every other limit still fails the parse.
   *
   * `handlerType`: the shape each record's content is written in (default "text"). An embedded document's "text" is
   * the text of its body; the container's is every character it writes. "ignore" keeps no content and counts no
   * output: its budget is unlimited, as Tika's ignore handler has no write limit.
   */
  constructor(
    delegate: Parser,
    options: {
      readonly recordFailures?: boolean;
      readonly truncateOutput?: boolean;
      readonly handlerType?: HandlerType;
      readonly unpackBytes?: number;
    } = {},
  ) {
    this.delegate = delegate;
    this.recordFailures = options.recordFailures ?? false;
    this.truncateOutput = options.truncateOutput ?? false;
    this.handlerType = options.handlerType ?? "text";
    this.unpackBytes = options.unpackBytes;
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
    const name = metadata.get(TIKA_KEYS.RESOURCE_NAME) ?? "document";
    const path = `/${name}`;
    const record: ParseRecord = {
      metadata,
      content: "",
      embeddedResourcePath: path,
      depth: 0,
      mediaType: MediaType.OCTET_STREAM,
      exception: null,
      handlerType: this.handlerType,
    };
    this.records.push(record);

    ctx.set(CONTEXT_KEYS.EMBEDDED_BUDGET, { count: 0, bytes: 0 });
    const counted = this.handlerType !== "ignore";
    const output: OutputBudget = {
      chars: 0,
      limit: counted ? ctx.limits.maxOutputChars : -1,
      truncate: this.truncateOutput,
      reached: false,
    };
    const extractor = new RecordExtractor(this.records, output, path, this.handlerType, counted, this.unpackBytes);
    ctx.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
    ctx.set(CONTEXT_KEYS.EMBEDDED_RESOURCE_PATH, path);

    const content = createOutputHandler(this.handlerType);
    const budgeted = new OutputBudgetHandler(
      new TeeContentHandler([handler, content]),
      output,
      counted ? ctx.limits.maxDocumentOutputChars : undefined,
    );
    metadata.setMaxValueChars(ctx.limits.maxMetadataValueChars);
    const startedAt = performance.now();
    try {
      await this.delegate.parse(stream, budgeted, metadata, ctx);
    } catch (error) {
      if (output.truncate && output.reached && isWriteLimitReached(error)) {
        // The output ended the parse early, by design: what was read is the answer.
      } else if (this.recordFailures && classifyFailure(error) === "unsupported") {
        noteEmptyParser(metadata);
      } else {
        record.exception = error instanceof Error ? error : new Error(String(error));
        recordFailure(metadata, TIKA_KEYS.CONTAINER_EXCEPTION, record.exception);
        throw error;
      }
    } finally {
      if (output.truncate && output.reached) metadata.set(TIKA_KEYS.WRITE_LIMIT_REACHED, "true");
      markParseTiming(metadata, startedAt);
      metadata.set(TIKA_KEYS.EMBEDDED_DEPTH, "0");
      if (stream.length !== null && metadata.get(CONTENT_LENGTH) === null) {
        metadata.set(CONTENT_LENGTH, String(stream.length));
      }
      record.content = content.toString();
      const type = metadata.get("Content-Type");
      if (type !== null) record.mediaType = MediaType.parse(type) ?? record.mediaType;
    }
  }
}

/** What Tika's EmptyParser leaves behind: it is named as the parser, and nothing else. */
export function noteEmptyParser(metadata: Metadata): void {
  if (!metadata.getAll(TIKA_KEYS.PARSED_BY).includes("EmptyParser")) metadata.add(TIKA_KEYS.PARSED_BY, "EmptyParser");
}

/**
 * Notes a failure on the record's own metadata, as Tika does: the exception's name and message, not a stack trace (a
 * trace would hand a client the server's file layout). A key that repeats keeps every failure.
 */
export function recordFailure(metadata: Metadata, key: string, error: Error): void {
  metadata.add(key, `${error.name}: ${error.message}`);
}

class RecordExtractor implements EmbeddedDocumentExtractor {
  private readonly records: ParseRecord[];
  private readonly output: OutputBudget;
  private readonly rootPath: string;
  private readonly handlerType: HandlerType;
  private readonly counted: boolean;
  /** Bytes of embedded documents that may still be kept; undefined when none are. One budget for the whole tree. */
  private unpackRemaining: number | undefined;
  private nextId = 0;

  constructor(
    records: ParseRecord[],
    output: OutputBudget,
    rootPath: string,
    handlerType: HandlerType,
    counted: boolean,
    unpackBytes: number | undefined,
  ) {
    this.records = records;
    this.output = output;
    this.rootPath = rootPath;
    this.handlerType = handlerType;
    this.counted = counted;
    this.unpackRemaining = unpackBytes;
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
    const name = metadata.get(TIKA_KEYS.RESOURCE_NAME) ?? "embedded";
    const path = `${parent}/${name}`.replace(/\/+/g, "/");
    const id = ++this.nextId;
    const idPath = `${ctx.get(CONTEXT_KEYS.EMBEDDED_ID_PATH) ?? ""}/${id}`;

    const record: ParseRecord = {
      metadata,
      content: "",
      embeddedResourcePath: path,
      depth,
      mediaType: MediaType.OCTET_STREAM,
      exception: null,
      handlerType: this.handlerType,
    };
    this.records.push(record);

    const parser = ctx.get(CONTEXT_KEYS.PARSER) as Parser | undefined;
    if (parser === undefined) return;

    if (this.unpackRemaining !== undefined) {
      // Before the parse: whatever the parse does to the document, the bytes are the ones it was given.
      const kept = await keepBytes(stream, this.unpackRemaining);
      if (kept !== undefined) {
        record.bytes = kept;
        this.unpackRemaining -= kept.length;
      }
    }

    const child = ctx.createChild();
    child.set(CONTEXT_KEYS.EMBEDDED_DEPTH, depth);
    child.set(CONTEXT_KEYS.EMBEDDED_RESOURCE_PATH, path);
    child.set(CONTEXT_KEYS.EMBEDDED_ID_PATH, idPath);
    child.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, this);

    const body = createOutputHandler(this.handlerType === "text" ? "body" : this.handlerType);
    const capture = new OutputBudgetHandler(body, this.output, this.counted ? ctx.limits.maxDocumentOutputChars : undefined);
    let truncated = false;
    metadata.setMaxValueChars(ctx.limits.maxMetadataValueChars);
    const startedAt = performance.now();
    let source = stream;
    try {
      if (stream.length === null) source = await meterEmbeddedStream(stream, ctx);
      await parser.parse(source, capture, metadata, child);
    } catch (error) {
      if (this.output.truncate && this.output.reached && isWriteLimitReached(error)) {
        // Not this document's failure: the parse as a whole is out of output. Flag the cut, and let it end the parse.
        truncated = true;
        throw error;
      }
      record.exception = error instanceof Error ? error : new Error(String(error));
      recordFailure(metadata, TIKA_KEYS.EMBEDDED_EXCEPTION, record.exception);
      if (ctx.signal.aborted) throw error; // propagate aborts; don't swallow a timeout as success
    } finally {
      if (source !== stream) await source.close();
      // What was extracted is kept even when the document failed or was cut short, as Tika's per-document handler is.
      record.content = body.toString();
      const type = metadata.get("Content-Type");
      if (type !== null) record.mediaType = MediaType.parse(type) ?? record.mediaType;
      if (truncated) metadata.set(TIKA_KEYS.WRITE_LIMIT_REACHED, "true");
      markParseTiming(metadata, startedAt);
      // Tika's embedded path starts below the container: the container itself has none.
      metadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_PATH, path.startsWith(this.rootPath) ? path.slice(this.rootPath.length) : path);
      metadata.set(TIKA_KEYS.EMBEDDED_DEPTH, String(depth));
      metadata.set(TIKA_KEYS.EMBEDDED_ID, String(id));
      metadata.set(TIKA_KEYS.EMBEDDED_ID_PATH, idPath);
      if (stream.length !== null && metadata.get(CONTENT_LENGTH) === null) {
        metadata.set(CONTENT_LENGTH, String(stream.length));
      }
    }

    // The text belongs to the embedded record only. Forwarding it to the
    // parent handler would copy it into every ancestor's record (O(depth*size)).
    void handler;
  }
}

/**
 * The whole of `stream`, or undefined when it is longer than `limit`. The stream is left where it was: the parse that
 * follows reads it from there.
 */
async function keepBytes(stream: RipstreamInputStream, limit: number): Promise<Uint8Array | undefined> {
  const at = stream.position;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    await stream.seek(0);
    for (;;) {
      const chunk = await stream.read();
      if (chunk === null) break;
      total += chunk.length;
      if (total > limit) return undefined;
      chunks.push(chunk);
    }
  } finally {
    await stream.seek(at);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

interface OutputBudget {
  chars: number;
  readonly limit: number;
  /** Reaching the limit ends the parse with the text so far, not with a LimitExceededError. */
  readonly truncate: boolean;
  /** The limit has been reached, so every later character is dropped. Only set when `truncate`. */
  reached: boolean;
}

/**
 * Counts characters against one budget shared by every record of a parse. A document's own limit
 * (`maxDocumentOutputChars`) always fails the parse. The shared budget does too, unless it truncates: then the
 * characters that fit are forwarded and the parse ends with a WriteLimitReachedError.
 */
class OutputBudgetHandler extends ContentHandlerDecorator {
  private readonly budget: OutputBudget;
  private readonly documentLimit: number | undefined;
  private documentChars = 0;

  constructor(delegate: ContentHandler, budget: OutputBudget, documentLimit?: number) {
    super(delegate);
    this.budget = budget;
    this.documentLimit = documentLimit;
  }

  override characters(ch: string, start: number, length: number): MaybePromise<void> {
    return this.forward(length, (count) => super.characters(ch, start, count));
  }

  override ignorableWhitespace(ch: string, start: number, length: number): MaybePromise<void> {
    return this.forward(length, (count) => super.ignorableWhitespace(ch, start, count));
  }

  private forward(length: number, send: (count: number) => MaybePromise<void>): MaybePromise<void> {
    const allowed = this.admit(length);
    if (allowed === length) return send(length);
    const sent = allowed > 0 ? send(allowed) : undefined;
    if (!(sent instanceof Promise)) throw new WriteLimitReachedError(this.budget.limit);
    return sent.then(() => {
      throw new WriteLimitReachedError(this.budget.limit);
    });
  }

  /** How many of `length` characters may be forwarded; fewer than `length` means the truncating budget ran out. */
  private admit(length: number): number {
    if (this.documentLimit !== undefined && this.documentLimit >= 0) {
      this.documentChars += length;
      if (this.documentChars > this.documentLimit) {
        throw new LimitExceededError(
          `Document output exceeds ${this.documentLimit} characters`,
        );
      }
    }
    const budget = this.budget;
    if (budget.limit < 0) return length;
    if (budget.chars + length <= budget.limit) {
      budget.chars += length;
      return length;
    }
    if (!budget.truncate) {
      budget.chars += length;
      throw new LimitExceededError(
        `Recursive output exceeds ${budget.limit} characters`,
      );
    }
    const allowed = Math.max(0, budget.limit - budget.chars);
    budget.chars = budget.limit;
    budget.reached = true;
    return allowed;
  }
}

export { ParsingEmbeddedDocumentExtractor };
