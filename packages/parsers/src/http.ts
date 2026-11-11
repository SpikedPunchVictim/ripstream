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
  XHTMLContentHandler,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";

/** Servers refuse header blocks of a few KiB; this bounds an input whose headers never end. */
export const DEFAULT_MAX_HTTP_HEADER_BYTES = 1_048_576;

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
const CONTENT_LENGTH = [..."content-length"].map((char) => char.charCodeAt(0));
const LATIN1 = new TextDecoder("latin1");
/** An optional `HTTP/x.y` and a three digit status that is followed by a space, a tab or the end of the line. */
const STATUS_LINE = /^(?:HTTP\/\d+(?:\.\d+)?[ \t]+)?\d{3}(?![^ \t])/;
/** The longest a status line is looked at: `HTTP/10.10 ` and the three digits are 14 characters. */
const STATUS_LINE_PREFIX_BYTES = 32;
/** A Content-Length value longer than this is refused unread: a Long has 19 digits and a sign, and no real header pads it further. */
const MAX_CONTENT_LENGTH_CHARS = 64;

export interface HttpParserOptions {
  /** Maximum bytes of status line and headers (default {@link DEFAULT_MAX_HTTP_HEADER_BYTES}); more is a LimitExceededError. */
  readonly maxHeaderBytes?: number;
}

/**
 * Port of Tika's HttpParser (tika-parser-webarchive-module) for an HTTP response (`application/x-httpresponse`).
 *
 * Tika reads the status line and headers with jwarc's lenient parser and uses one thing from them: a `Content-Length` above
 * 0. That many bytes after the empty line that ends the headers are the payload, parsed as an embedded document with a fresh
 * Metadata (so the response's own Content-Type is not used to pick its parser). The headers set no metadata and write no text,
 * and a response with no Content-Length, or 0 or less, has no payload ("is there a way to handle non-lengthed bodies?" says
 * the source). The container's Content-Type is left as detected.
 *
 * Read from the Tika source and not run against a Tika; jwarc's source is not in the Tika tree, so how the headers are read is
 * this port's reading of a lenient HTTP response, not jwarc's code:
 *  - A line ends at LF or CRLF (Tika's http-response fixture uses LF), and the headers end at the first empty line.
 *  - The first line must be `HTTP/x.y NNN reason`, the `HTTP/x.y ` and the reason being optional (Tika's EMLXDetectionTest
 *    calls `200 OK` with no version an HTTP capture); anything else is a MalformedDocumentError.
 *  - A header line with no colon is skipped, and a header name is matched as it stands (no space before the colon).
 *  - A second Content-Length is a MalformedDocumentError (jwarc's `sole()` is believed to refuse a repeated header).
 *  - A Content-Length is read as Java's `Long.parseLong` reads it (a sign, ASCII digits, within a Long); a value that does not
 *    parse is a MalformedDocumentError, which stands for the NumberFormatException that ends Tika's parse.
 *  - An empty input (Tika: the first read's EOFException) and headers that end before the empty line are a MalformedDocumentError.
 * The payload is read as it arrives, up to Content-Length bytes: a body that ends sooner is read as far as it goes.
 *
 * Other differences: headers over `maxHeaderBytes` are a LimitExceededError (Tika has no cap); the document is not ended when
 * the parse fails (Tika ends it in a `finally`).
 */
export class HttpParser implements Parser {
  readonly name = "HttpParser";
  readonly #maxHeaderBytes: number;

  constructor(options: HttpParserOptions = {}) {
    const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HTTP_HEADER_BYTES;
    if (!Number.isInteger(maxHeaderBytes) || maxHeaderBytes < 1) {
      throw new RangeError(`maxHeaderBytes must be a positive integer, got ${maxHeaderBytes}`);
    }
    this.#maxHeaderBytes = maxHeaderBytes;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow("application/x-httpresponse")]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    const head = await this.#readHead(stream);
    if (head.contentLength !== null && head.contentLength > 0n) {
      await stream.seek(head.end);
      await parsePayload(stream, head.contentLength, xhtml, ctx);
    }

    await xhtml.endDocument();
  }

  /** Peeks the input in growing steps until the headers end, so a short response is not read for a megabyte. */
  async #readHead(stream: RipstreamInputStream): Promise<Head> {
    const max = this.#maxHeaderBytes;
    let want = 4096;
    for (;;) {
      const bytes = await stream.peek(want);
      const head = readHead(bytes);
      if (head !== null) {
        if (head.end > max) throw new LimitExceededError(`HTTP headers are longer than ${max} bytes`);
        return head;
      }
      if (bytes.length < want) {
        throw new MalformedDocumentError(
          bytes.length === 0 ? "Empty input: not an HTTP response" : "HTTP headers end before the empty line that finishes them",
        );
      }
      if (want > max) throw new LimitExceededError(`HTTP headers are longer than ${max} bytes`);
      want = Math.min(want * 2, max + 1);
    }
  }
}

interface Head {
  /** The offset just after the empty line that ends the headers. */
  readonly end: number;
  readonly contentLength: bigint | null;
}

/** Reads the status line and the headers in `bytes`; null while they do not yet end in an empty line. */
function readHead(bytes: Uint8Array): Head | null {
  let position = 0;
  let statusRead = false;
  let contentLength: bigint | null = null;
  while (position < bytes.length) {
    const newline = bytes.indexOf(0x0a, position);
    if (newline === -1) return null;
    const lineEnd = newline > position && bytes[newline - 1] === 0x0d ? newline - 1 : newline;
    if (!statusRead) {
      checkStatusLine(bytes.subarray(position, lineEnd));
      statusRead = true;
    } else if (lineEnd === position) {
      return { end: newline + 1, contentLength };
    } else {
      const value = contentLengthValue(bytes.subarray(position, lineEnd));
      if (value !== null) {
        if (contentLength !== null) throw new MalformedDocumentError("HTTP response has more than one Content-Length header");
        contentLength = parseLong(value);
      }
    }
    position = newline + 1;
  }
  return null;
}

function checkStatusLine(line: Uint8Array): void {
  if (!STATUS_LINE.test(LATIN1.decode(line.subarray(0, STATUS_LINE_PREFIX_BYTES)))) {
    throw new MalformedDocumentError("Not an HTTP response: the first line is not a status line");
  }
}

/** The value of `line` when it is a Content-Length header (the name is matched without regard to case), else null. */
function contentLengthValue(line: Uint8Array): string | null {
  const colon = line.indexOf(0x3a);
  if (colon !== CONTENT_LENGTH.length) return null;
  // `| 0x20` lower-cases a letter and leaves the hyphen as it is.
  if (!CONTENT_LENGTH.every((expected, index) => (line[index]! | 0x20) === expected)) return null;
  let start = colon + 1;
  let end = line.length;
  while (start < end && (line[start] === 0x20 || line[start] === 0x09)) start++;
  while (end > start && (line[end - 1] === 0x20 || line[end - 1] === 0x09)) end--;
  if (end - start > MAX_CONTENT_LENGTH_CHARS) throw new MalformedDocumentError("HTTP Content-Length is not a number");
  return LATIN1.decode(line.subarray(start, end));
}

/** Long.parseLong: an optional sign and ASCII digits, within a Long. */
function parseLong(value: string): bigint {
  if (!/^[+-]?\d+$/.test(value)) throw new MalformedDocumentError(`HTTP Content-Length is not a number: ${JSON.stringify(value)}`);
  const number = BigInt(value);
  if (number < LONG_MIN || number > LONG_MAX) {
    throw new MalformedDocumentError(`HTTP Content-Length is out of range: ${value}`);
  }
  return number;
}

/** HttpParser.parsePayload: the embedded document gets a fresh Metadata, and an error in it does not end the response. */
async function parsePayload(
  stream: RipstreamInputStream,
  contentLength: bigint,
  xhtml: XHTMLContentHandler,
  ctx: ParseContext,
): Promise<void> {
  const extractor =
    (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
    new ParsingEmbeddedDocumentExtractor();
  const payloadMetadata = new Metadata();
  if (!extractor.shouldParseEmbedded(payloadMetadata)) return;

  const limit = contentLength > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(contentLength);
  const payload = await RipstreamInputStream.from(lengthed(stream, limit), { context: ctx, signal: ctx.signal });
  try {
    await extractor.parseEmbedded(payload, xhtml, payloadMetadata, ctx);
  } catch (error) {
    // Resiliency errors must reach the server (422/408) instead of becoming a 200.
    if (
      error instanceof LimitExceededError ||
      error instanceof ParseTimeoutError ||
      error instanceof AbortError ||
      ctx.signal.aborted
    ) {
      throw error;
    }
    payloadMetadata.add("tk:exception:embedded-exception", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    await payload.close();
  }
}

/** jwarc's LengthedBody: the next `length` bytes of the stream, or as many as there are. */
async function* lengthed(stream: RipstreamInputStream, length: number): AsyncGenerator<Uint8Array> {
  let left = length;
  while (left > 0) {
    const chunk = await stream.read();
    if (chunk === null) return;
    const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
    left -= part.length;
    yield part;
  }
}
