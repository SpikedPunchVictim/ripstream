import { MalformedDocumentError } from "@spikedpunch/ripstream-core";

/**
 * A reader for ASN.1 BER that is lazy and bounded by the bytes it is given, for the envelopes of CMS (RFC 5652), which
 * use indefinite lengths where DER does not. It never allocates by a declared length and never reads past `limit`.
 *
 * It does not build a tree. `element` reads one header; `children` walks the content of a constructed element and
 * reads each child's header only when asked for the next one. A child of definite length is skipped in one step. A
 * child of indefinite length is skipped by scanning to its end-of-contents octets, which is done once for each
 * element a caller walks past; an element a caller enters is not scanned at all.
 */

export const UNIVERSAL = 0;
export const CONTEXT = 2;

export const TAG_BOOLEAN = 1;
export const TAG_INTEGER = 2;
export const TAG_OCTET_STRING = 4;
export const TAG_OID = 6;
export const TAG_SEQUENCE = 16;
export const TAG_IA5_STRING = 22;
export const TAG_GENERALIZED_TIME = 24;

/** Nesting of constructed OCTET STRING segments; BER normally has one level. */
const MAX_SEGMENT_NESTING = 8;
/** Nesting that scanning past an indefinite-length element follows. Real CMS nests a few levels. */
const MAX_SCAN_DEPTH = 64;
/** Octets of a high tag number (X.690 8.1.2.4); every tag this port reads is below 31. */
const MAX_TAG_OCTETS = 4;
/** Octets of a long-form length. A length is compared with the bytes there are, so four are enough for any input. */
const MAX_LENGTH_OCTETS = 4;
/**
 * Longest OBJECT IDENTIFIER or INTEGER decoded. Both are read as BigInt, which is quadratic in their length, and no real
 * one is near this (an OID is about 10 octets, a time stamp serial number at most 20).
 */
const MAX_NUMBER_OCTETS = 1024;

/** The data ends inside an element: the file is cut short, which is not the same as one that is not ASN.1. */
export class TruncatedAsn1Error extends MalformedDocumentError {}

/** More OCTET STRING content than the caller allowed. Not the data's fault, so it is not a partial result. */
class ContentTooLargeError extends MalformedDocumentError {}

/** Growing buffer for segments, so many empty or tiny segments cost no more than their bytes. */
class OctetCollector {
  #buffer = new Uint8Array(0);
  #length = 0;
  readonly #maxBytes: number;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  add(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (this.#length + bytes.length > this.#maxBytes) throw new ContentTooLargeError("ASN.1 OCTET STRING is too large");
    if (this.#length + bytes.length > this.#buffer.length) {
      const grown = new Uint8Array(Math.max(this.#length + bytes.length, Math.min(this.#buffer.length * 2, this.#maxBytes)));
      grown.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = grown;
    }
    this.#buffer.set(bytes, this.#length);
    this.#length += bytes.length;
  }

  result(): Uint8Array {
    return this.#buffer.subarray(0, this.#length);
  }
}

export interface Element {
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  readonly tagClass: number;
  readonly tagNumber: number;
  readonly constructed: boolean;
  readonly contentStart: number;
  /** The end of the content, or null for an indefinite length, whose end the children give. */
  readonly contentEnd: number | null;
  /** Set only by `element(..., true)`: the length said more than the data holds, and `contentEnd` is where the data ends. */
  readonly truncated?: true;
}

export class Ber {
  readonly #data: Uint8Array;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  /**
   * The header at `position`, with its content inside [position, limit). A length that says more than that is refused
   * as truncated, unless `clip` is set, which keeps the element with the content there is.
   */
  element(position: number, limit: number, clip = false): Element {
    const data = this.#data;
    if (position + 2 > limit) throw new TruncatedAsn1Error("ASN.1 element is cut short");
    const first = data[position]!;
    const tagClass = first >> 6;
    const constructed = (first & 0x20) !== 0;
    let tagNumber = first & 0x1f;
    let cursor = position + 1;
    if (tagNumber === 0x1f) {
      tagNumber = 0;
      for (let octets = 0; ; octets++) {
        if (octets >= MAX_TAG_OCTETS) throw new MalformedDocumentError("ASN.1 tag is too long");
        if (cursor >= limit) throw new TruncatedAsn1Error("ASN.1 element is cut short");
        const octet = data[cursor++]!;
        tagNumber = tagNumber * 128 + (octet & 0x7f);
        if ((octet & 0x80) === 0) break;
      }
    }

    if (cursor >= limit) throw new TruncatedAsn1Error("ASN.1 element is cut short");
    const lengthOctet = data[cursor++]!;
    let contentEnd: number | null;
    if (lengthOctet < 0x80) {
      contentEnd = cursor + lengthOctet;
    } else if (lengthOctet === 0x80) {
      if (!constructed) throw new MalformedDocumentError("ASN.1 indefinite length on a primitive element");
      contentEnd = null;
    } else {
      const octets = lengthOctet & 0x7f;
      if (octets > MAX_LENGTH_OCTETS) throw new MalformedDocumentError("ASN.1 length is not valid");
      if (cursor + octets > limit) throw new TruncatedAsn1Error("ASN.1 element is cut short");
      let length = 0;
      for (let index = 0; index < octets; index++) length = length * 256 + data[cursor + index]!;
      cursor += octets;
      contentEnd = cursor + length;
    }
    if (contentEnd !== null && contentEnd > limit) {
      if (!clip) throw new TruncatedAsn1Error("ASN.1 length runs past the data");
      return { tagClass, tagNumber, constructed, contentStart: cursor, contentEnd: limit, truncated: true };
    }
    return { tagClass, tagNumber, constructed, contentStart: cursor, contentEnd };
  }

  /**
   * The children of a constructed element in order. `limit` is the end of the data that holds the element: a child of
   * an indefinite-length element ends at its end-of-contents octets, any other at the end of its parent. With `clip`
   * a child whose length runs past the data is given with `truncated` set (see `element`), and is the last one.
   */
  *children(parent: Element, limit: number, clip = false): Generator<Element> {
    if (!parent.constructed) throw new MalformedDocumentError("ASN.1 element has no children");
    const end = parent.contentEnd ?? limit;
    let position = parent.contentStart;
    while (position < end) {
      if (parent.contentEnd === null && this.#isEndOfContents(position, end)) return;
      const child = this.element(position, end, clip);
      yield child;
      position = this.end(child, end);
    }
    // An indefinite-length element that ran out of data has no end-of-contents octets.
    if (parent.contentEnd === null) throw new TruncatedAsn1Error("ASN.1 indefinite length is not closed");
  }

  /** The position after `element`, past its end-of-contents octets when its length is indefinite. */
  end(element: Element, limit: number): number {
    if (element.contentEnd !== null) return element.contentEnd;
    let position = element.contentStart;
    let depth = 1;
    while (depth > 0) {
      if (position >= limit) throw new TruncatedAsn1Error("ASN.1 indefinite length is not closed");
      if (this.#isEndOfContents(position, limit)) {
        position += 2;
        depth--;
        continue;
      }
      const child = this.element(position, limit);
      if (child.contentEnd === null) {
        if (++depth > MAX_SCAN_DEPTH) throw new MalformedDocumentError("ASN.1 is nested too deeply");
        position = child.contentStart;
      } else {
        position = child.contentEnd;
      }
    }
    return position;
  }

  #isEndOfContents(position: number, limit: number): boolean {
    return position + 2 <= limit && this.#data[position] === 0 && this.#data[position + 1] === 0;
  }

  /**
   * The bytes of an OCTET STRING, primitive or constructed (BER cuts a long one into segments, which may be cut again).
   * When the data ends inside the string, or a segment is not an OCTET STRING, the bytes read so far are returned with
   * the error, as BouncyCastle's stream hands over what it has read before it fails. More than `maxBytes` of content
   * is a MalformedDocumentError, not a result.
   */
  readOctets(string: Element, limit: number, maxBytes: number): { bytes: Uint8Array; error: MalformedDocumentError | null } {
    const collected = new OctetCollector(maxBytes);
    let error: MalformedDocumentError | null = null;
    try {
      this.#collect(string, limit, collected, 0);
    } catch (thrown) {
      if (!(thrown instanceof MalformedDocumentError) || thrown instanceof ContentTooLargeError) throw thrown;
      error = thrown;
    }
    return { bytes: collected.result(), error };
  }

  #collect(string: Element, limit: number, into: OctetCollector, depth: number): void {
    if (!string.constructed) {
      into.add(this.#data.subarray(string.contentStart, string.contentEnd ?? limit));
      if (string.truncated) throw new TruncatedAsn1Error("ASN.1 OCTET STRING is cut short");
      return;
    }
    if (depth >= MAX_SEGMENT_NESTING) throw new MalformedDocumentError("OCTET STRING segments are nested too deeply");
    const end = string.contentEnd ?? limit;
    let position = string.contentStart;
    while (position < end) {
      if (string.contentEnd === null && this.#isEndOfContents(position, end)) return;
      const segment = this.element(position, end, true);
      if (!is(segment, UNIVERSAL, TAG_OCTET_STRING)) throw new MalformedDocumentError("OCTET STRING segment is not an OCTET STRING");
      this.#collect(segment, end, into, depth + 1);
      position = this.end(segment, end);
    }
    if (string.contentEnd === null || string.truncated) throw new TruncatedAsn1Error("ASN.1 OCTET STRING is not closed");
  }

  /** The content bytes of an element of definite length. */
  content(element: Element): Uint8Array {
    if (element.contentEnd === null) throw new MalformedDocumentError("ASN.1 element has an indefinite length");
    return this.#data.subarray(element.contentStart, element.contentEnd);
  }
}

export function is(element: Element, tagClass: number, tagNumber: number, constructed?: boolean): boolean {
  return (
    element.tagClass === tagClass &&
    element.tagNumber === tagNumber &&
    (constructed === undefined || element.constructed === constructed)
  );
}

/** An OBJECT IDENTIFIER in dotted form. */
export function decodeOid(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new MalformedDocumentError("Empty ASN.1 object identifier");
  if (bytes.length > MAX_NUMBER_OCTETS) throw new MalformedDocumentError("ASN.1 object identifier is too long");
  const parts: string[] = [];
  let value = 0n;
  for (const byte of bytes) {
    value = value * 128n + BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) {
      if (parts.length === 0) {
        const first = value < 80n ? value / 40n : 2n;
        parts.push(String(first), String(value - first * 40n));
      } else {
        parts.push(String(value));
      }
      value = 0n;
    }
  }
  if ((bytes[bytes.length - 1]! & 0x80) !== 0) throw new MalformedDocumentError("ASN.1 object identifier is cut short");
  return parts.join(".");
}

/** An INTEGER as a BigInteger, two's complement. */
export function decodeInteger(bytes: Uint8Array): bigint {
  if (bytes.length === 0) throw new MalformedDocumentError("Empty ASN.1 integer");
  if (bytes.length > MAX_NUMBER_OCTETS) throw new MalformedDocumentError("ASN.1 integer is too long");
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return (bytes[0]! & 0x80) !== 0 ? value - (1n << BigInt(8 * bytes.length)) : value;
}
