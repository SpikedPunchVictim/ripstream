import {
  AbortError,
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParseTimeoutError,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
  TIKA_KEYS,
  WriteLimitReachedError,
  XHTMLContentHandler,
  inflateBounded,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { boundedUnzip } from "@spikedpunch/ripstream-parser-office";
import { readAll } from "./bytes.ts";

/*
 * Port of Tika 4.2.0's WACZParser (tika-parser-webarchive-module): a WACZ is a ZIP whose archive/ folder holds the
 * WARC files (plain or gzip), each of which is an embedded document. Read from that source; not run against a Tika.
 * Its datapackage.json, pages and indexes are not read, as in Tika, where they are a no-op and a TODO.
 */

const WACZ_TYPE = "application/x-wacz";
const ARCHIVE_PREFIX = "archive/";

export class WACZParser implements Parser {
  readonly name = "WACZParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(WACZ_TYPE)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const files = boundedUnzip(await readAll(stream), ctx.limits);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    const extractor =
      (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
      new ParsingEmbeddedDocumentExtractor();
    // What the gzip entries inflate to, in all: boundedUnzip counts only what the zip entries inflate to.
    let gzipOutput = 0;

    for (const entryName of files.names) {
      if (!entryName.startsWith(ARCHIVE_PREFIX)) continue;
      const entry = files.get(entryName);
      if (entry === undefined) continue;

      const embedded = new Metadata();
      embedded.set("tk:internal-path", entryName);
      embedded.set(TIKA_KEYS.RESOURCE_NAME, entryName.slice(ARCHIVE_PREFIX.length));
      embedded.set("Content-Length", String(entry.byteLength));

      let bytes = entry;
      if (isGzip(entry)) {
        // A header that is not a valid one fails the parse, as GzipCompressorInputStream's constructor does in Tika.
        const body = entry.subarray(gzipHeaderLength(entry));
        try {
          // Only the first member is read, as Tika's reader does (it does not decompress concatenated members).
          bytes = inflateBounded(body, "deflate-raw", {
            maxOutputBytes: Math.min(ctx.limits.maxEmbeddedResourceBytes, ctx.limits.maxTotalEmbeddedBytes),
            maxRatio: ctx.limits.maxDecompressionRatio,
          });
        } catch (error) {
          if (isFatal(error, ctx)) throw error;
          // Tika reads the gzip while parsing the embedded document, where a failure of the stream is recorded.
          recordStreamException(metadata, error);
          continue;
        }
        gzipOutput += bytes.byteLength;
        if (gzipOutput > ctx.limits.maxTotalEmbeddedBytes) {
          throw new LimitExceededError(
            `The gzip entries of the archive inflate to more than ${ctx.limits.maxTotalEmbeddedBytes} bytes in all`,
          );
        }
      }

      if (!extractor.shouldParseEmbedded(embedded)) continue;
      const embeddedStream = await RipstreamInputStream.from(bytes, { context: ctx });
      try {
        await extractor.parseEmbedded(embeddedStream, xhtml, embedded, ctx);
      } catch (error) {
        if (isFatal(error, ctx)) throw error;
        recordStreamException(metadata, error);
      } finally {
        await embeddedStream.close();
      }
    }
    await xhtml.endDocument();
  }
}

/** The two bytes of the gzip magic number, 1f 8b: what WACZParser.getMaybeGzipInputStream tests. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * The length of the header of the first gzip member (RFC 1952), after which its deflate data starts. A header that is
 * cut short, names a method other than deflate or sets a reserved flag is refused, as GzipCompressorInputStream does.
 */
function gzipHeaderLength(gzip: Uint8Array): number {
  if (gzip.byteLength < 10) throw new MalformedDocumentError("The gzip header is cut short");
  if (gzip[2] !== 8) throw new MalformedDocumentError(`Unsupported gzip compression method ${gzip[2]}`);
  const flags = gzip[3]!;
  if ((flags & 0xe0) !== 0) throw new MalformedDocumentError("Reserved flags are set in the gzip header");
  let offset = 10;
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > gzip.byteLength) throw new MalformedDocumentError("The gzip header is cut short");
    offset += 2 + (gzip[offset]! | (gzip[offset + 1]! << 8));
  }
  // The file name and the comment end with a zero byte.
  for (const flag of [0x08, 0x10]) {
    if ((flags & flag) === 0) continue;
    const end = offset < gzip.byteLength ? gzip.indexOf(0, offset) : -1;
    if (end < 0) throw new MalformedDocumentError("The gzip header is cut short");
    offset = end + 1;
  }
  if ((flags & 0x02) !== 0) offset += 2;
  if (offset > gzip.byteLength) throw new MalformedDocumentError("The gzip header is cut short");
  return offset;
}

/** A failure that ends the parse rather than one entry of it: a limit, a timeout, an abort, the output cut. */
function isFatal(error: unknown, ctx: ParseContext): boolean {
  return (
    error instanceof LimitExceededError ||
    error instanceof ParseTimeoutError ||
    error instanceof AbortError ||
    error instanceof WriteLimitReachedError ||
    ctx.signal.aborted
  );
}

/** EmbeddedDocumentUtil.recordEmbeddedStreamException: the exception's name and message, not a stack trace. */
function recordStreamException(metadata: Metadata, error: unknown): void {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  metadata.add(TIKA_KEYS.EMBEDDED_STREAM_EXCEPTION, text);
}
