import {
  CONTEXT_KEYS,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
  XHTMLContentHandler,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";
import {
  Ber,
  CONTEXT,
  TAG_INTEGER,
  TAG_OCTET_STRING,
  TAG_OID,
  TAG_SEQUENCE,
  UNIVERSAL,
  decodeOid,
  is,
  type Element,
} from "./ber.ts";
import { readAll } from "./bytes.ts";

/*
 * Port of Tika 4.2.0's Pkcs7Parser and CmsClassifier (tika-parser-crypto-module): a CMS ContentInfo (RFC 5652) is labelled
 * with the S/MIME type its content type OID gives, and the content that a signedData holds is parsed as an embedded
 * document. Tika reads the CMS with BouncyCastle's CMSSignedDataParser; the BER reading here is ber.ts, which reads the
 * indefinite lengths of a streamed message. Read from the Tika source, not run against a Tika.
 *
 * Not ported: the extraction of CMS compressedData (RFC 3274), which Tika inflates up to 100 MiB and parses. Here such a
 * message is labelled compressed-data and gives an empty document.
 */

const SUPPORTED = ["application/pkcs7-mime", "application/pkcs7-signature"];

const ID_SIGNED_DATA = "1.2.840.113549.1.7.2";

/** CmsClassifier.nonSignedType: the ContentInfo OIDs that are labelled but whose payload is not extracted. */
const NON_SIGNED_TYPES = new Map<string, string>([
  ["1.2.840.113549.1.7.3", "enveloped-data"],
  ["1.2.840.113549.1.9.16.1.9", "compressed-data"],
  ["1.2.840.113549.1.7.5", "digested-data"],
  ["1.2.840.113549.1.7.6", "encrypted-data"],
]);

const PKCS7_SIGNATURE = "application/pkcs7-signature";
const SET = 17;

/** What a signedData is made of, as far as the classification and the extraction need it. */
interface SignedParts {
  /** The OCTET STRING of the eContent, or null for a detached signature or a certificates-only message. */
  readonly content: Element | null;
  /** The limit that holds `content`, for the lengths of its segments. */
  readonly contentLimit: number;
  readonly hasCertificates: boolean;
  readonly hasSigners: boolean;
}

export class Pkcs7Parser implements Parser {
  readonly name = "Pkcs7Parser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(SUPPORTED.map((type) => MediaType.parseOrThrow(type)));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    const type = contentTypeOid(data);
    const xhtml = new XHTMLContentHandler(handler, metadata);

    if (type === ID_SIGNED_DATA) {
      await parseSignedData(data, xhtml, metadata, ctx);
      return;
    }
    const label = type === null ? undefined : NON_SIGNED_TYPES.get(type);
    if (label !== undefined) metadata.set("Content-Type", smimeType(label));
    await emptyDocument(xhtml);
  }
}

function smimeType(label: string): string {
  return MediaType.parseOrThrow(`application/pkcs7-mime; smime-type=${label}`).toString();
}

async function emptyDocument(xhtml: XHTMLContentHandler): Promise<void> {
  await xhtml.startDocument();
  await xhtml.endDocument();
}

/**
 * The ContentInfo content type OID. Data that is not a DER or BER SEQUENCE starting with an OID has none, which is not an
 * error: Tika's classifier answers null for it and the parser gives an empty document.
 */
function contentTypeOid(data: Uint8Array): string | null {
  try {
    const ber = new Ber(data);
    // clip: a message cut short later on still has its type, as Tika's lazy read of the first element finds it.
    const contentInfo = ber.element(0, data.length, true);
    if (!is(contentInfo, UNIVERSAL, TAG_SEQUENCE, true)) return null;
    const first = ber.children(contentInfo, data.length, true).next().value;
    if (first === undefined || !is(first, UNIVERSAL, TAG_OID, false)) return null;
    return decodeOid(ber.content(first));
  } catch (error) {
    if (error instanceof MalformedDocumentError) return null;
    throw error;
  }
}

async function parseSignedData(
  data: Uint8Array,
  xhtml: XHTMLContentHandler,
  metadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  const ber = new Ber(data);
  const parts = readSignedParts(ber, data.length);
  metadata.set("Content-Type", refinedSignedType(parts));
  if (parts.content === null) {
    await emptyDocument(xhtml);
    return;
  }

  const extractor =
    (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
    new ParsingEmbeddedDocumentExtractor();
  const embeddedMetadata = new Metadata();
  await xhtml.startDocument();
  if (extractor.shouldParseEmbedded(embeddedMetadata)) {
    // The content cannot be longer than the message, so that bounds what a declared length can make this read.
    const octets = ber.readOctets(parts.content, parts.contentLimit, data.length);
    if (octets.error !== null) throw octets.error;
    const embedded = await RipstreamInputStream.from(octets.bytes, { context: ctx });
    try {
      await extractor.parseEmbedded(embedded, xhtml, embeddedMetadata, ctx);
    } finally {
      await embedded.close();
    }
  }
  await xhtml.endDocument();
}

/** CmsClassifier.refinedSignedType: content, then certificates without signers, then a detached signature. */
function refinedSignedType(parts: SignedParts): string {
  if (parts.content !== null) return smimeType("signed-data");
  if (parts.hasCertificates && !parts.hasSigners) return smimeType("certs-only");
  return PKCS7_SIGNATURE;
}

/** The limit that holds the children of `element`: its own end, or that of what holds it when its length is indefinite. */
function limitOf(element: Element, limit: number): number {
  return element.contentEnd ?? limit;
}

function malformed(what: string): MalformedDocumentError {
  return new MalformedDocumentError(`Not a CMS signedData: ${what}`);
}

/**
 * ContentInfo { contentType, [0] EXPLICIT content } with SignedData ::= SEQUENCE { version, digestAlgorithms SET,
 * encapContentInfo, certificates [0] OPTIONAL, crls [1] OPTIONAL, signerInfos SET }.
 */
function readSignedParts(ber: Ber, size: number): SignedParts {
  const contentInfo = ber.element(0, size);
  const infoLimit = limitOf(contentInfo, size);
  const fields = ber.children(contentInfo, size);
  fields.next(); // the content type, which the caller read
  const tagged = fields.next().value;
  if (tagged === undefined || !is(tagged, CONTEXT, 0, true)) throw malformed("no content");
  const signed = ber.children(tagged, infoLimit).next().value;
  if (signed === undefined || !is(signed, UNIVERSAL, TAG_SEQUENCE, true)) throw malformed("the content is not a SEQUENCE");
  return readSignedData(ber, signed, limitOf(tagged, infoLimit));
}

function readSignedData(ber: Ber, signed: Element, limit: number): SignedParts {
  const signedLimit = limitOf(signed, limit);
  let encapsulated: { content: Element | null; limit: number } = { content: null, limit: signedLimit };
  let hasCertificates = false;
  let hasSigners = false;
  let index = 0;
  let setsSeen = 0;

  for (const child of ber.children(signed, limit)) {
    if (index++ === 0) {
      if (!is(child, UNIVERSAL, TAG_INTEGER, false)) throw malformed("no version");
    } else if (is(child, UNIVERSAL, SET, true)) {
      // The first SET is the digest algorithms and the last is the signer infos.
      if (setsSeen++ > 0) hasSigners = hasChildren(ber, child, signedLimit);
    } else if (is(child, UNIVERSAL, TAG_SEQUENCE, true)) {
      encapsulated = readEncapsulated(ber, child, signedLimit);
    } else if (is(child, CONTEXT, 0, true)) {
      hasCertificates = hasSequenceChild(ber, child, signedLimit);
    }
  }
  return { content: encapsulated.content, contentLimit: encapsulated.limit, hasCertificates, hasSigners };
}

/** EncapsulatedContentInfo ::= SEQUENCE { eContentType OID, eContent [0] EXPLICIT OCTET STRING OPTIONAL }. */
function readEncapsulated(ber: Ber, encapsulated: Element, limit: number): { content: Element | null; limit: number } {
  const encapsulatedLimit = limitOf(encapsulated, limit);
  const fields = ber.children(encapsulated, limit);
  const type = fields.next().value;
  if (type === undefined || !is(type, UNIVERSAL, TAG_OID, false)) throw malformed("the encapsulated content has no type");
  const tagged = fields.next().value;
  if (tagged === undefined) return { content: null, limit };
  if (!is(tagged, CONTEXT, 0, true)) throw malformed("the encapsulated content is not [0]");
  const content = ber.children(tagged, encapsulatedLimit).next().value;
  if (content === undefined || !is(content, UNIVERSAL, TAG_OCTET_STRING)) throw malformed("the content is not an OCTET STRING");
  return { content, limit: limitOf(tagged, encapsulatedLimit) };
}

function hasChildren(ber: Ber, parent: Element, limit: number): boolean {
  return ber.children(parent, limit).next().done !== true;
}

/** Certificates are SEQUENCEs; BouncyCastle's store skips the other CertificateChoices, and so does this. */
function hasSequenceChild(ber: Ber, parent: Element, limit: number): boolean {
  for (const child of ber.children(parent, limit)) {
    if (is(child, UNIVERSAL, TAG_SEQUENCE, true)) return true;
  }
  return false;
}
