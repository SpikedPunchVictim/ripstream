import {
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  isFatalParseError,
  MediaType,
  Metadata,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
  TIKA_KEYS,
  XHTMLContentHandler,
  noteEmbeddedLimit,
  truncatesEmbeddedLimit,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";

/**
 * Returns a normalized relative path, or null when the name would escape the
 * archive root (absolute, drive-qualified, or traversing above the root).
 */
export function safeEntryName(name: string): string | null {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? null : parts.join("/");
}

/** Enforces decompression size and ratio limits for one archive member. */
export function checkDecompression(
  ctx: ParseContext,
  compressedBytes: number,
  decompressedBytes: number,
  what: string,
): void {
  if (decompressedBytes > ctx.limits.maxEmbeddedResourceBytes) {
    throw new LimitExceededError(
      `${what} exceeds the per-entry byte limit`,
    );
  }
  if (decompressedBytes > ctx.limits.maxTotalEmbeddedBytes) {
    throw new LimitExceededError(
      `${what} exceeds the embedded byte limit`,
    );
  }
  if (
    compressedBytes > 0 &&
    decompressedBytes / compressedBytes > ctx.limits.maxDecompressionRatio
  ) {
    throw new LimitExceededError(
      `${what} exceeds the decompression ratio limit`,
    );
  }
}

/**
 * Counts the entries of an archive against `maxZipEntries`, as zip and tar do: an entry past the limit throws
 * `LimitExceededError`, or, under `onEmbeddedLimit: "truncate"`, is not read (the walk goes on only to count it) and the
 * archive's metadata says so. Exactly the limit is no cut. Count real entries only: not a trailer or an index.
 */
export class EntryLimit {
  readonly #label: string;
  readonly #max: number;
  readonly #truncate: boolean;
  #seen = 0;

  constructor(label: string, ctx: ParseContext) {
    this.#label = label;
    this.#max = ctx.limits.maxZipEntries;
    this.#truncate = truncatesEmbeddedLimit(ctx);
  }

  /** How many entries were counted, read or not. */
  get seen(): number {
    return this.#seen;
  }

  /** How many were read: up to the limit. */
  get read(): number {
    return Math.min(this.#seen, this.#max);
  }

  /** Counts one entry; true when it is to be read, false when it is past the limit and the parse truncates. */
  admit(): boolean {
    this.#seen++;
    if (this.#seen <= this.#max) return true;
    if (!this.#truncate) throw new LimitExceededError(`${this.#label} entries exceed ${this.#max}`);
    return false;
  }

  /** Notes the cut on the archive's metadata when there was one. */
  note(metadata: Metadata): void {
    if (this.#seen > this.#max) noteEmbeddedLimit(metadata, { limit: "maxZipEntries", max: this.#max, seen: this.#seen, read: this.#max });
  }
}

export async function readAll(
  stream: AsyncIterable<Uint8Array>,
  limit = Number.MAX_SAFE_INTEGER,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > limit) throw new LimitExceededError(`Input exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function parseEntry(
  handler: ContentHandler,
  name: string,
  bytes: Uint8Array,
  metadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  const childMetadata = new Metadata();
  childMetadata.set("tk:resource-name", name);
  const stream = await RipstreamInputStream.from(bytes, { context: ctx });
  try {
    const extractor =
      (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as
        | EmbeddedDocumentExtractor
        | undefined) ?? new ParsingEmbeddedDocumentExtractor();
    markArchiveEntries(ctx);
    await extractor.parseEmbedded(stream, handler, childMetadata, ctx);
  } catch (error) {
    if (isFatalParseError(error, ctx)) throw error;
    // The entry's metadata is dropped by a plain parse, so the archive carries the marker too, as Tika's
    // CompositeParser.recordEmbeddedMetadata puts each failed child's exception on the container.
    const failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    childMetadata.add(TIKA_KEYS.EMBEDDED_EXCEPTION, failure);
    metadata.add(TIKA_KEYS.EMBEDDED_EXCEPTION, failure);
  } finally {
    await stream.close();
  }
}

/**
 * Marks the context of an archive's parse: what it hands the embedded document extractor are entries of the archive
 * (`kind: "entry"` in `ParseRecord.pathParts`). The mark is on the archive's own context, so it is set once for all of
 * its members (and the shared embedded budget a plain parse creates on that context stays one); the extractor does not
 * pass it on to a member's own parse.
 */
export function markArchiveEntries(ctx: ParseContext): void {
  ctx.set(CONTEXT_KEYS.ARCHIVE_ENTRY, true);
}

export async function withXhtml(
  handler: ContentHandler,
  metadata: Metadata,
  action: (xhtml: XHTMLContentHandler) => Promise<void>,
): Promise<void> {
  const xhtml = new XHTMLContentHandler(handler, metadata);
  await xhtml.startDocument();
  await action(xhtml);
  await xhtml.endDocument();
}

export type { Parser };
export { MalformedDocumentError, MediaType };
