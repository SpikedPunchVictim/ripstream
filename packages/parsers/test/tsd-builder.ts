/*
 * BER for the tests of the TSD parser (tikajs-68os.21): a Time Stamped Data envelope (RFC 5544) holding time stamp tokens
 * (RFC 3161 TSTInfo in a CMS SignedData), built from the layouts of those RFCs, with the lengths and the content under the
 * test's control. Not a signer: nothing in it is signed.
 */

export const ID_CT_TIMESTAMPED_DATA = "1.2.840.113549.1.9.16.1.31";
export const ID_SIGNED_DATA = "1.2.840.113549.1.7.2";
export const ID_CT_TST_INFO = "1.2.840.113549.1.9.16.1.4";
export const SHA256 = "2.16.840.1.101.3.4.2.1";
export const COMMON_NAME = "2.5.4.3";
export const ORGANIZATION = "2.5.4.10";
export const ORGANIZATIONAL_UNIT = "2.5.4.11";

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const lengthOctets = (length: number): number[] =>
  length < 0x80
    ? [length]
    : length < 0x100
      ? [0x81, length]
      : length < 0x10000
        ? [0x82, length >> 8, length & 0xff]
        : [0x84, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff];

/** An element of definite length. `tag` is the whole identifier octet, so 0x30 is a SEQUENCE and 0xa0 is [0]. */
export const tlv = (tag: number, ...content: Uint8Array[]): Uint8Array => {
  const body = concat(...content);
  return concat(Uint8Array.of(tag, ...lengthOctets(body.length)), body);
};

/** A constructed element of indefinite length, closed by its end-of-contents octets. */
export const indefinite = (tag: number, ...content: Uint8Array[]): Uint8Array =>
  concat(Uint8Array.of(tag, 0x80), ...content, Uint8Array.of(0, 0));

export const seq = (...content: Uint8Array[]): Uint8Array => tlv(0x30, ...content);
export const set = (...content: Uint8Array[]): Uint8Array => tlv(0x31, ...content);
export const octets = (data: Uint8Array): Uint8Array => tlv(0x04, data);
export const explicit = (number: number, ...content: Uint8Array[]): Uint8Array => tlv(0xa0 | number, ...content);

export const integer = (value: bigint): Uint8Array => {
  // The shortest two's complement form: grow until the sign bit agrees with the value.
  let length = 1;
  while (value < -(1n << BigInt(8 * length - 1)) || value >= 1n << BigInt(8 * length - 1)) length++;
  const mask = (1n << BigInt(8 * length)) - 1n;
  const unsigned = value & mask;
  const body = new Uint8Array(length);
  for (let index = 0; index < length; index++) body[index] = Number((unsigned >> BigInt(8 * (length - 1 - index))) & 0xffn);
  return tlv(0x02, body);
};

export const oid = (dotted: string): Uint8Array => {
  const arcs = dotted.split(".").map(Number);
  const values = [arcs[0]! * 40 + arcs[1]!, ...arcs.slice(2)];
  const body: number[] = [];
  for (const value of values) {
    const groups = [value & 0x7f];
    for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) groups.unshift((rest & 0x7f) | 0x80);
    body.push(...groups);
  }
  return tlv(0x06, Uint8Array.from(body));
};

export const text = (tag: number, value: string): Uint8Array => tlv(tag, new TextEncoder().encode(value));
export const utf8 = (value: string): Uint8Array => text(0x0c, value);
export const generalizedTime = (value: string): Uint8Array => text(0x18, value);

/** A directory name as the TSA names itself: `[4] { Name }`, each RDN holding the given (type, value) pairs. */
export const directoryName = (...rdns: Array<Array<[string, string]>>): Uint8Array =>
  explicit(4, seq(...rdns.map((rdn) => set(...rdn.map(([type, value]) => seq(oid(type), utf8(value)))))));

export interface TstInfoOptions {
  policy?: string;
  serial?: bigint;
  genTime?: string;
  algorithm?: string;
  /** A GeneralName, or null for a token that does not name its TSA. */
  tsa?: Uint8Array | null;
}

export const tstInfo = (options: TstInfoOptions = {}): Uint8Array =>
  seq(
    integer(1n),
    oid(options.policy ?? "1.2.3.4"),
    seq(seq(oid(options.algorithm ?? SHA256), tlv(0x05)), octets(new Uint8Array(32))),
    integer(options.serial ?? 0x1234n),
    generalizedTime(options.genTime ?? "20170331134016Z"),
    ...(options.tsa === null ? [] : [explicit(0, options.tsa ?? directoryName([[COMMON_NAME, "Test TSA"]]))]),
  );

/** A TimeStampAndCRL holding one token, whose TSTInfo is the given bytes. */
export const timeStampAndCrl = (info: Uint8Array): Uint8Array =>
  seq(
    seq(
      oid(ID_SIGNED_DATA),
      explicit(0, seq(integer(3n), set(), seq(oid(ID_CT_TST_INFO), explicit(0, octets(info))))),
    ),
  );

export interface EnvelopeOptions {
  /** The stamped file; omitted for an envelope without content. */
  content?: Uint8Array;
  /** The time stamp tokens, each a TSTInfo; none gives an envelope without evidence. */
  tokens?: Uint8Array[];
  /** Written as BER indefinite lengths, as an envelope that was streamed is, rather than definite ones. */
  indefiniteLengths?: boolean;
}

export const envelope = (options: EnvelopeOptions = {}): Uint8Array => {
  const wrap = options.indefiniteLengths === true ? indefinite : tlv;
  const parts: Uint8Array[] = [integer(1n)];
  if (options.content !== undefined) parts.push(octets(options.content));
  if (options.tokens !== undefined && options.tokens.length > 0) {
    parts.push(wrap(0xa0, ...options.tokens.map(timeStampAndCrl)));
  }
  return wrap(0x30, oid(ID_CT_TIMESTAMPED_DATA), wrap(0xa0, wrap(0x30, ...parts)));
};
