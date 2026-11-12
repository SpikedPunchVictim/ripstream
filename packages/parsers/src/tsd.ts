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
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { readAll } from "./bytes.ts";
import { openEnvelope, readContent, readTimeStamps, type Envelope, type TimeStamp } from "./tsd-envelope.ts";

/*
 * Port of Tika 4.2.0's TSDParser (tika-parser-crypto-module): a Time Stamped Data envelope (RFC 5544) is a document with
 * time stamp tokens as metadata and the stamped file as an embedded document. Tika reads the envelope with BouncyCastle;
 * the BER reading here is ber.ts and tsd-envelope.ts. Read from the Tika source, not run against a Tika.
 */

const TSD_TYPE = "application/timestamped-data";
const LOOP_LABEL = "Time-Stamp-n.";

/** OIDNameMapper.digestAlgs: the digest names TSDParser writes for the algorithm OID of a token's message imprint. */
const DIGEST_NAMES = new Map<string, string>([
  ["1.2.840.113549.2.5", "MD5"],
  ["1.3.14.3.2.26", "SHA1"],
  ["2.16.840.1.101.3.4.2.4", "SHA224"],
  ["2.16.840.1.101.3.4.2.1", "SHA256"],
  ["2.16.840.1.101.3.4.2.2", "SHA384"],
  ["2.16.840.1.101.3.4.2.3", "SHA512"],
  ["1.2.840.113549.1.1.5", "SHA1"],
  ["1.2.840.113549.1.1.14", "SHA224"],
  ["1.2.840.113549.1.1.11", "SHA256"],
  ["1.2.840.113549.1.1.12", "SHA384"],
  ["1.2.840.113549.1.1.13", "SHA512"],
  ["1.3.36.3.2.2", "RIPEMD128"],
  ["1.3.36.3.2.1", "RIPEMD160"],
  ["1.3.36.3.2.3", "RIPEMD256"],
  ["1.2.643.2.2.9", "GOST3411"],
  ["1.3.6.1.4.1.5849.1.2.1", "GOST3411"],
]);

export class TsdParser implements Parser {
  readonly name = "TSDParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(TSD_TYPE)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const envelope = openEnvelope(await readAll(stream));

    // The time stamp metadata goes on the document itself only when nothing is on it yet; otherwise, as when the
    // document was detected first, it goes on the embedded document's metadata.
    const embeddedMetadata = new Metadata();
    buildMetas(extractMetas(envelope), metadata.size() > 0 ? embeddedMetadata : metadata);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await parseContent(envelope, xhtml, embeddedMetadata, metadata, ctx);
    await xhtml.endDocument();
  }
}

/** Tika drops every token when any one cannot be read, and goes on to the content. */
function extractMetas(envelope: Envelope): TimeStamp[] {
  try {
    return readTimeStamps(envelope);
  } catch (error) {
    if (error instanceof MalformedDocumentError) return [];
    throw error;
  }
}

function buildMetas(stamps: readonly TimeStamp[], metadata: Metadata): void {
  stamps.forEach((stamp, index) => {
    const label = `${LOOP_LABEL}${index + 1} - `;
    metadata.set(`${label}Content-Type`, TSD_TYPE);
    metadata.set(`${label}Description`, "Time Stamped Data Envelope");
    metadata.set(`${label}File-Parsed`, "true");
    metadata.set(`${label}File-Parsed-DateTime`, `${formatDate(new Date())} UTC`);
    metadata.set(`${label}Time-Stamp-DateTime`, `${formatDate(stamp.genTime)} UTC`);
    metadata.set(`${label}Policy-Id`, stamp.policyId);
    metadata.set(`${label}Serial-Number`, serialNumberText(stamp.serialNumber));
    metadata.set(`${label}TSA`, stamp.tsa);
    metadata.set(`${label}Algorithm`, DIGEST_NAMES.get(stamp.algorithmOid) ?? stamp.algorithmOid);
  });
}

/** SimpleDateFormat "dd/MM/yyyy HH:mm:ss" in UTC. */
function formatDate(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, "0");
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  return `${two(date.getUTCDate())}/${two(date.getUTCMonth() + 1)}/${year} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
}

/** String.format("%12x", serialNumber).trim(): lower-case hex, a minus sign before the digits of a negative number. */
function serialNumberText(serial: bigint): string {
  return serial < 0n ? `-${(-serial).toString(16)}` : serial.toString(16);
}

/**
 * The stamped file as an embedded document. When the envelope is cut short the file is parsed as far as it goes and the
 * cut is recorded on its metadata, as Tika records the EOFException of the stream it spools.
 */
async function parseContent(
  envelope: Envelope,
  xhtml: XHTMLContentHandler,
  metadata: Metadata,
  parentMetadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  const extractor =
    (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
    new ParsingEmbeddedDocumentExtractor();
  if (!extractor.shouldParseEmbedded(metadata)) return;
  const content = readContent(envelope);
  if (content === null) return;
  if (content.error !== null) {
    metadata.add(TIKA_KEYS.EMBEDDED_STREAM_EXCEPTION, `${content.error.name}: ${content.error.message}`);
  }

  const embedded = await RipstreamInputStream.from(content.bytes, { context: ctx });
  try {
    await extractor.parseEmbedded(embedded, xhtml, metadata, ctx);
  } catch (error) {
    // Tika logs a failure of the embedded document and ends the parse normally; a limit or an abort is not one of those.
    if (isFatal(error, ctx)) throw error;
    // The embedded document's metadata is dropped by a plain parse, so the TSD carries the marker, as Tika's CompositeParser
    // puts each failed child's exception on the container.
    parentMetadata.add(TIKA_KEYS.EMBEDDED_EXCEPTION, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    await embedded.close();
  }
}

/** A failure that ends the parse rather than one document of it: a limit, a timeout, an abort, the output cut. */
function isFatal(error: unknown, ctx: ParseContext): boolean {
  return (
    error instanceof LimitExceededError ||
    error instanceof ParseTimeoutError ||
    error instanceof AbortError ||
    error instanceof WriteLimitReachedError ||
    ctx.signal.aborted
  );
}
