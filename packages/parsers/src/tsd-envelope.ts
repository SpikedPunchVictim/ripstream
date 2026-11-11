import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";
import {
  Ber,
  CONTEXT,
  TAG_GENERALIZED_TIME,
  TAG_IA5_STRING,
  TAG_INTEGER,
  TAG_OCTET_STRING,
  TAG_OID,
  TAG_SEQUENCE,
  UNIVERSAL,
  decodeInteger,
  decodeOid,
  is,
  type Element,
} from "./ber.ts";
import { generalNameToString } from "./general-name.ts";

/*
 * The parts of a Time Stamped Data envelope (RFC 5544) that Tika's TSDParser reads through BouncyCastle's
 * CMSTimeStampedData and CMSTimeStampedDataParser: the content, and the time stamp tokens of the temporal evidence.
 * BouncyCastle is not available here; the layouts are RFC 5544, RFC 3161 and RFC 5652, and the three test envelopes
 * that Tika ships have been read against them.
 */

const ID_CT_TIMESTAMPED_DATA = "1.2.840.113549.1.9.16.1.31";
const ID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const ID_CT_TST_INFO = "1.2.840.113549.1.9.16.1.4";

/** A time stamp token's TSTInfo is a hundred bytes or so; this bounds what is read as one. */
const MAX_TST_INFO_BYTES = 1024 * 1024;
/** An envelope has one or a few tokens; each is nine metadata values, so a count is the bound on those. */
export const MAX_TIME_STAMPS = 1000;

export interface TimeStamp {
  readonly genTime: Date;
  readonly policyId: string;
  readonly serialNumber: bigint;
  /** GeneralName text as BouncyCastle writes it, or "null" where the token names no TSA. */
  readonly tsa: string;
  readonly algorithmOid: string;
}

export interface Envelope {
  readonly ber: Ber;
  /** The TimeStampedData SEQUENCE. */
  readonly timeStampedData: Element;
  /** The end of the data the TimeStampedData's children lie in. */
  readonly limit: number;
}

/** What is left of an OCTET STRING when its data ends early: the bytes there are, and why it stopped. */
export interface Octets {
  readonly bytes: Uint8Array;
  readonly error: MalformedDocumentError | null;
}

/**
 * The ContentInfo header and the TimeStampedData SEQUENCE it holds. Anything that does not start like that is not a
 * time stamped data envelope (Tika's parser finds nothing in it and yields an empty document; this port refuses it).
 */
export function openEnvelope(data: Uint8Array): Envelope {
  const ber = new Ber(data);
  const contentInfo = ber.element(0, data.length);
  if (!is(contentInfo, UNIVERSAL, TAG_SEQUENCE, true)) throw new MalformedDocumentError("Not a time stamped data envelope");
  const limit = contentInfo.contentEnd ?? data.length;
  const parts = ber.children(contentInfo, limit);

  const type = parts.next().value;
  if (type === undefined || !is(type, UNIVERSAL, TAG_OID, false) || decodeOid(ber.content(type)) !== ID_CT_TIMESTAMPED_DATA) {
    throw new MalformedDocumentError("Not a time stamped data envelope");
  }
  // content [0] EXPLICIT: its content is the TimeStampedData.
  const tagged = parts.next().value;
  if (tagged === undefined || !is(tagged, CONTEXT, 0, true)) throw new MalformedDocumentError("Not a time stamped data envelope");
  const taggedLimit = tagged.contentEnd ?? limit;
  const first = ber.children(tagged, taggedLimit).next().value;
  if (first === undefined || !is(first, UNIVERSAL, TAG_SEQUENCE, true)) throw new MalformedDocumentError("Not a time stamped data envelope");
  return { ber, timeStampedData: first, limit: taggedLimit };
}

interface Parts {
  readonly content: Element | null;
  readonly evidence: Element | null;
}

/**
 * The OCTET STRING content and the evidence of a TimeStampedData: version, then an optional dataUri (IA5String), an
 * optional metaData (SEQUENCE) and an optional content, then the evidence. With `clip` an element cut short by the end of
 * the data is accepted when it is the content, which is as far as a truncated file gets.
 */
function locate(envelope: Envelope, clip: boolean): Parts {
  const { ber, timeStampedData, limit } = envelope;
  let content: Element | null = null;
  let index = 0;
  for (const child of ber.children(timeStampedData, limit, clip)) {
    if (index++ === 0) {
      if (!is(child, UNIVERSAL, TAG_INTEGER, false) || child.truncated) throw new MalformedDocumentError("A TimeStampedData starts with its version");
      continue;
    }
    if (is(child, UNIVERSAL, TAG_OCTET_STRING) && content === null) {
      content = child;
      // A truncated or unscanned content is the last thing that can be read in clip mode; the evidence is past it.
      if (clip) return { content, evidence: null };
    } else if (is(child, UNIVERSAL, TAG_IA5_STRING) || (is(child, UNIVERSAL, TAG_SEQUENCE, true) && content === null)) {
      continue; // dataUri, metaData
    } else if (child.tagClass === CONTEXT && !child.truncated) {
      return { content, evidence: child };
    } else {
      throw new MalformedDocumentError("Unexpected element in a TimeStampedData");
    }
  }
  return { content, evidence: null };
}

/**
 * The embedded content, as far as the data goes: a truncated envelope gives the bytes before the cut and the error that
 * stopped it. Null when the envelope has no content to read.
 */
export function readContent(envelope: Envelope): Octets | null {
  let content: Element | null;
  try {
    content = locate(envelope, true).content;
  } catch (error) {
    if (error instanceof MalformedDocumentError) return null;
    throw error;
  }
  if (content === null) return null;
  const available = envelope.timeStampedData.contentEnd ?? envelope.limit;
  return envelope.ber.readOctets(content, available, available);
}

/**
 * The time stamp tokens of the evidence, each read as RFC 3161 TSTInfo. Throws MalformedDocumentError when the evidence is
 * not time stamp token evidence or any token cannot be read; the caller decides what that costs (Tika drops them all).
 * Unlike BouncyCastle this does not check the token's signer or its signing certificate attribute.
 */
export function readTimeStamps(envelope: Envelope): TimeStamp[] {
  const { ber, limit } = envelope;
  const { evidence } = locate(envelope, false);
  if (evidence === null || !is(evidence, CONTEXT, 0, true)) throw new MalformedDocumentError("No time stamp token evidence");
  const stamps: TimeStamp[] = [];
  // tstEvidence [0] IMPLICIT SEQUENCE OF TimeStampAndCRL: the children of the [0] are the TimeStampAndCRLs.
  for (const timeStampAndCrl of ber.children(evidence, limit)) {
    if (stamps.length >= MAX_TIME_STAMPS) throw new LimitExceededError(`More than ${MAX_TIME_STAMPS} time stamp tokens`);
    if (!is(timeStampAndCrl, UNIVERSAL, TAG_SEQUENCE, true)) throw new MalformedDocumentError("A TimeStampAndCRL is a SEQUENCE");
    const token = ber.children(timeStampAndCrl, timeStampAndCrl.contentEnd ?? limit).next().value;
    if (token === undefined) throw new MalformedDocumentError("A TimeStampAndCRL has a time stamp token");
    stamps.push(readToken(ber, token, timeStampAndCrl.contentEnd ?? limit));
  }
  if (stamps.length === 0) throw new MalformedDocumentError("The time stamp token evidence is empty");
  return stamps;
}

/** ContentInfo { signedData, [0] SignedData { version, digestAlgorithms, encapContentInfo { TSTInfo OID, [0] OCTET STRING } } }. */
function readToken(ber: Ber, contentInfo: Element, limit: number): TimeStamp {
  const signedData = explicitChild(ber, contentInfo, limit, ID_SIGNED_DATA, "a time stamp token");
  const end = signedData.contentEnd ?? limit;
  let encapsulated: Element | null = null;
  let index = 0;
  for (const child of ber.children(signedData, end)) {
    // version, digestAlgorithms, then encapContentInfo.
    if (index++ === 2) {
      encapsulated = child;
      break;
    }
  }
  if (encapsulated === null) throw new MalformedDocumentError("A time stamp token has no encapsulated content");
  const eContent = explicitChild(ber, encapsulated, end, ID_CT_TST_INFO, "a time stamp token's content");
  if (!is(eContent, UNIVERSAL, TAG_OCTET_STRING)) throw new MalformedDocumentError("TSTInfo is an OCTET STRING");
  const octets = ber.readOctets(eContent, end, MAX_TST_INFO_BYTES);
  if (octets.error !== null) throw octets.error;
  return readTstInfo(octets.bytes);
}

/** The first child of the [0] after the OID of a ContentInfo-shaped SEQUENCE (type, [0] EXPLICIT content). */
function explicitChild(ber: Ber, sequence: Element, limit: number, oid: string, what: string): Element {
  if (!is(sequence, UNIVERSAL, TAG_SEQUENCE, true)) throw new MalformedDocumentError(`${what} is a SEQUENCE`);
  const end = sequence.contentEnd ?? limit;
  const parts = ber.children(sequence, end);
  const type = parts.next().value;
  if (type === undefined || !is(type, UNIVERSAL, TAG_OID, false) || decodeOid(ber.content(type)) !== oid) {
    throw new MalformedDocumentError(`${what} is not of type ${oid}`);
  }
  const tagged = parts.next().value;
  if (tagged === undefined || !is(tagged, CONTEXT, 0, true)) throw new MalformedDocumentError(`${what} has no content`);
  const child = ber.children(tagged, tagged.contentEnd ?? end).next().value;
  if (child === undefined) throw new MalformedDocumentError(`${what} has no content`);
  return child;
}

/** TSTInfo of RFC 3161: version, policy, messageImprint, serialNumber, genTime, then optional accuracy, ordering, nonce, tsa. */
function readTstInfo(bytes: Uint8Array): TimeStamp {
  const ber = new Ber(bytes);
  const root = ber.element(0, bytes.length);
  if (!is(root, UNIVERSAL, TAG_SEQUENCE, true)) throw new MalformedDocumentError("TSTInfo is a SEQUENCE");
  const end = root.contentEnd ?? bytes.length;

  const fields: Element[] = [];
  let tsa: Element | null = null;
  for (const child of ber.children(root, end)) {
    if (fields.length < 5) fields.push(child);
    else if (is(child, CONTEXT, 0, true) && tsa === null) tsa = child;
  }
  const [version, policy, imprint, serial, genTime] = fields;
  if (
    version === undefined || policy === undefined || imprint === undefined || serial === undefined || genTime === undefined ||
    !is(version, UNIVERSAL, TAG_INTEGER, false) ||
    !is(policy, UNIVERSAL, TAG_OID, false) ||
    !is(imprint, UNIVERSAL, TAG_SEQUENCE, true) ||
    !is(serial, UNIVERSAL, TAG_INTEGER, false) ||
    !is(genTime, UNIVERSAL, TAG_GENERALIZED_TIME, false)
  ) {
    throw new MalformedDocumentError("TSTInfo does not have the fields of RFC 3161");
  }

  return {
    genTime: parseGeneralizedTime(new TextDecoder("latin1").decode(ber.content(genTime))),
    policyId: decodeOid(ber.content(policy)),
    serialNumber: decodeInteger(ber.content(serial)),
    tsa: tsa === null ? "null" : tsaText(ber, tsa, end),
    algorithmOid: hashAlgorithm(ber, imprint, end),
  };
}

/** messageImprint ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier, hashedMessage OCTET STRING }; the OID of the algorithm. */
function hashAlgorithm(ber: Ber, imprint: Element, limit: number): string {
  const algorithm = ber.children(imprint, imprint.contentEnd ?? limit).next().value;
  if (algorithm === undefined || !is(algorithm, UNIVERSAL, TAG_SEQUENCE, true)) throw new MalformedDocumentError("A message imprint has a hash algorithm");
  const oid = ber.children(algorithm, algorithm.contentEnd ?? limit).next().value;
  if (oid === undefined || !is(oid, UNIVERSAL, TAG_OID, false)) throw new MalformedDocumentError("A hash algorithm has an OID");
  return decodeOid(ber.content(oid));
}

/** tsa [0] GeneralName: the [0] is explicit, as GeneralName is a CHOICE, so its content is the GeneralName. */
function tsaText(ber: Ber, tsa: Element, limit: number): string {
  const name = ber.children(tsa, tsa.contentEnd ?? limit).next().value;
  if (name === undefined) throw new MalformedDocumentError("An empty tsa");
  return generalNameToString(ber, name, tsa.contentEnd ?? limit);
}

const GENERALIZED_TIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?(?:[.,]\d+)?(Z|[+-]\d{2}(?:\d{2})?)?$/;

/**
 * GeneralizedTime as a date. The fraction is dropped, as the format Tika writes has no room for one. A day or an hour
 * out of range rolls over rather than failing, as the lenient SimpleDateFormat BouncyCastle parses it with does.
 */
function parseGeneralizedTime(text: string): Date {
  const match = GENERALIZED_TIME.exec(text);
  if (match === null || text.length > 64) throw new MalformedDocumentError("A time stamp's time is not a GeneralizedTime");
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((group) => Number(match[group] ?? 0)) as [
    number, number, number, number, number, number,
  ];
  const zone = match[7];
  let offsetMinutes = 0;
  if (zone !== undefined && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5) || 0));
  }
  // setUTCFullYear, not Date.UTC, which reads the years 0 to 99 as 1900 to 1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return new Date(date.getTime() - offsetMinutes * 60_000);
}
