import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortError,
  BodyContentHandler,
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  ParseTimeoutError,
  RipstreamInputStream,
  WriteLimitReachedError,
  type EmbeddedDocumentExtractor,
} from "@spikedpunch/ripstream-core";
import { Ber } from "../src/ber.ts";
import { openEnvelope, readTimeStamps } from "../src/tsd-envelope.ts";
import { generalNameToString } from "../src/general-name.ts";
import { TsdParser } from "../src/tsd.ts";
import {
  COMMON_NAME,
  ID_CT_TIMESTAMPED_DATA,
  ORGANIZATION,
  SHA256,
  concat,
  directoryName,
  envelope,
  explicit,
  generalizedTime,
  indefinite,
  integer,
  octets,
  oid,
  seq,
  set,
  text,
  timeStampAndCrl,
  tlv,
  tstInfo,
  utf8,
} from "./tsd-builder.ts";

/*
 * Mutation tests for the TSD parser (tikajs-68os.21): each test pins a behaviour of ber.ts, general-name.ts, tsd-envelope.ts or
 * tsd.ts that the Tika envelopes and the tests of tsd.test.ts leave open. The parser is constructed directly, so nothing here
 * loads another parser's registration.
 */

const LABEL = "Time-Stamp-n.1 - ";

interface Parsed {
  readonly metadata: Metadata;
  readonly embedded: Array<{ metadata: Metadata; bytes: Uint8Array }>;
}

async function parseTsd(data: Uint8Array, context = new ParseContext(), metadata = new Metadata()): Promise<Parsed> {
  const resources = new EmbeddedDocumentBytesHandler();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  const stream = await RipstreamInputStream.from(data);
  try {
    await new TsdParser().parse(stream, new BodyContentHandler(), metadata, context);
  } finally {
    await stream.close();
  }
  return { metadata, embedded: resources.resources.map(({ metadata: meta, bytes }) => ({ metadata: meta, bytes })) };
}

const stampKeys = (metadata: Metadata): string[] => metadata.names().filter((name) => name.startsWith("Time-Stamp-n."));
const SHA1_OID = "1.3.14.3.2.26";

// ---- the table of digest names, from OIDNameMapper.digestAlgs of TSDParser.java ----

test("every digest OID Tika names is written as its name", async () => {
  const names: Array<[string, string]> = [
    ["1.2.840.113549.2.5", "MD5"],
    [SHA1_OID, "SHA1"],
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
  ];
  for (const [algorithm, name] of names) {
    const { metadata } = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ algorithm })] }));
    assert.equal(metadata.get(`${LABEL}Algorithm`), name, algorithm);
  }
});

// ---- the metadata the parser writes, key by key ----

test("a token's nine values are written under exactly these keys", async () => {
  const { metadata } = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ policy: "1.2.3", serial: 0n, genTime: "20010203040506Z" })] }));
  const written = Object.fromEntries(stampKeys(metadata).map((key) => [key, metadata.get(key)]));
  const parsedAt = written[`${LABEL}File-Parsed-DateTime`];
  delete written[`${LABEL}File-Parsed-DateTime`];
  assert.deepEqual(written, {
    [`${LABEL}Content-Type`]: "application/timestamped-data",
    [`${LABEL}Description`]: "Time Stamped Data Envelope",
    [`${LABEL}File-Parsed`]: "true",
    [`${LABEL}Time-Stamp-DateTime`]: "03/02/2001 04:05:06 UTC",
    [`${LABEL}Policy-Id`]: "1.2.3",
    [`${LABEL}Serial-Number`]: "0",
    [`${LABEL}TSA`]: "4: CN=Test TSA",
    [`${LABEL}Algorithm`]: "SHA256",
  });
  assert.match(parsedAt ?? "", /^\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d UTC$/);
});

test("the time the file was parsed is now, in UTC, not the time of the token", async () => {
  const day = (date: Date): string => {
    const two = (value: number): string => String(value).padStart(2, "0");
    return `${two(date.getUTCDate())}/${two(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
  };
  const before = new Date();
  const { metadata } = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ genTime: "20010203040506Z" })] }));
  const after = new Date();
  const parsedAt = metadata.get(`${LABEL}File-Parsed-DateTime`) ?? "";
  assert.ok([day(before), day(after)].some((minute) => parsedAt.startsWith(`${minute}:`)), parsedAt);
  assert.ok(parsedAt.endsWith(" UTC"));
});

test("a date has its day, month, hour, minute and second in two digits, and its year in four", async () => {
  const early = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ genTime: "20010203040506Z" })] }));
  assert.equal(early.metadata.get(`${LABEL}Time-Stamp-DateTime`), "03/02/2001 04:05:06 UTC");
  const ancient = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ genTime: "09990101000000Z" })] }));
  assert.equal(ancient.metadata.get(`${LABEL}Time-Stamp-DateTime`), "01/01/0999 00:00:00 UTC");
  // The years 0 to 99 are those of the Common Era, where Date.UTC would read them as 1900 to 1999.
  const first = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ genTime: "00500101000000Z" })] }));
  assert.equal(first.metadata.get(`${LABEL}Time-Stamp-DateTime`), "01/01/0050 00:00:00 UTC");
});

test("a serial number of zero is 0, and a large one is in lower-case hex", async () => {
  const zero = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ serial: 0n })] }));
  assert.equal(zero.metadata.get(`${LABEL}Serial-Number`), "0");
  const large = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ serial: 0xabcdef0123456789abcdn })] }));
  assert.equal(large.metadata.get(`${LABEL}Serial-Number`), "abcdef0123456789abcd");
});

test("GeneralizedTime in its shorter and longer forms", async () => {
  const time = async (genTime: string): Promise<string | null> =>
    (await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ genTime })] }))).metadata.get(`${LABEL}Time-Stamp-DateTime`);
  assert.equal(await time("20201231235959Z"), "31/12/2020 23:59:59 UTC");
  assert.equal(await time("202012312359Z"), "31/12/2020 23:59:00 UTC");
  assert.equal(await time("2020123123Z"), "31/12/2020 23:00:00 UTC");
  assert.equal(await time("20201231235959"), "31/12/2020 23:59:59 UTC");
  assert.equal(await time("20201231235959.987Z"), "31/12/2020 23:59:59 UTC");
  assert.equal(await time("20201231235959,5Z"), "31/12/2020 23:59:59 UTC");
  assert.equal(await time("20201231235959-0530"), "01/01/2021 05:29:59 UTC");
  assert.equal(await time("20201231235959+0530"), "31/12/2020 18:29:59 UTC");
  assert.equal(await time("20201231235959+02"), "31/12/2020 21:59:59 UTC");
  assert.equal(await time("202012312359+0130"), "31/12/2020 22:29:00 UTC");
  // A day out of range rolls over, as the lenient SimpleDateFormat BouncyCastle uses does.
  assert.equal(await time("20200231000000Z"), "02/03/2020 00:00:00 UTC");
  assert.equal(await time("20200101240000Z"), "02/01/2020 00:00:00 UTC");
});

test("a time that is not GeneralizedTime drops the time stamps, and so does one of 65 characters", async () => {
  for (const genTime of ["2020-12-31", "20201231Z", "nonsense", `20201231235959.${"1".repeat(50)}Z`]) {
    const { metadata } = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ genTime })] }));
    assert.deepEqual(stampKeys(metadata), [], genTime);
  }
  // 64 characters are the most that are read; 20201231235959 and a dot are 15, so 49 digits make 64.
  const longest = `20201231235959.${"1".repeat(48)}Z`;
  assert.equal(longest.length, 64);
  const ok = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ genTime: longest })] }));
  assert.equal(ok.metadata.get(`${LABEL}Time-Stamp-DateTime`), "31/12/2020 23:59:59 UTC");
  const tooLong = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [tstInfo({ genTime: `20201231235959.${"1".repeat(49)}Z` })] }));
  assert.deepEqual(stampKeys(tooLong.metadata), []);
});

// ---- the fields of a TSTInfo ----

const sha256Imprint = (): Uint8Array => seq(seq(oid(SHA256), tlv(0x05)), octets(new Uint8Array(32)));

interface RawTst {
  version?: Uint8Array;
  policy?: Uint8Array;
  imprint?: Uint8Array;
  serial?: Uint8Array;
  genTime?: Uint8Array;
  rest?: Uint8Array[];
  /** Fields to leave out, counted from the front: 4 leaves version, policy, imprint and serial. */
  only?: number;
}

/** A TSTInfo built field by field, so that a test can put a wrong type in any one place. */
function rawTst(parts: RawTst = {}): Uint8Array {
  const fields = [
    parts.version ?? integer(1n),
    parts.policy ?? oid("1.2.3.4"),
    parts.imprint ?? sha256Imprint(),
    parts.serial ?? integer(0x1234n),
    parts.genTime ?? generalizedTime("20170331134016Z"),
  ].slice(0, parts.only ?? 5);
  return seq(...fields, ...(parts.rest ?? []));
}

const tsaName = (): Uint8Array => explicit(0, directoryName([[COMMON_NAME, "Test TSA"]]));
const stampsOf = async (info: Uint8Array): Promise<string[]> =>
  stampKeys((await parseTsd(envelope({ content: new Uint8Array(1), tokens: [info] }))).metadata);

test("a TSTInfo with every optional field gives the TSA after them", async () => {
  const info = rawTst({ rest: [seq(integer(1n)), tlv(0x01, Uint8Array.of(0xff)), integer(77n), tsaName(), tlv(0xa1, seq())] });
  const { metadata } = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [info] }));
  assert.equal(metadata.get(`${LABEL}TSA`), "4: CN=Test TSA");
});

test("a TSTInfo whose only context element is its extensions has no TSA", async () => {
  const info = rawTst({ rest: [tlv(0xa1, seq(seq(oid("1.2.3"), octets(new Uint8Array(1)))))] });
  const { metadata } = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [info] }));
  assert.equal(metadata.get(`${LABEL}TSA`), "null");
});

test("of two TSA elements the first is the one written", async () => {
  const second = explicit(0, directoryName([[COMMON_NAME, "Second"]]));
  const { metadata } = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [rawTst({ rest: [tsaName(), second] })] }));
  assert.equal(metadata.get(`${LABEL}TSA`), "4: CN=Test TSA");
});

test("a primitive context element is not a TSA", async () => {
  const { metadata } = await parseTsd(envelope({ content: new Uint8Array(1), tokens: [rawTst({ rest: [tlv(0x80, Uint8Array.of(1))] })] }));
  assert.equal(metadata.get(`${LABEL}TSA`), "null");
});

test("a TSTInfo with a wrong type in any of its first five fields, or fewer than five, is not read", async () => {
  const wrong: Array<[string, RawTst]> = [
    ["version", { version: octets(Uint8Array.of(1)) }],
    ["policy", { policy: integer(5n) }],
    ["imprint", { imprint: explicit(0, seq(oid(SHA256), tlv(0x05)), octets(new Uint8Array(32))) }],
    ["serial", { serial: octets(Uint8Array.of(1, 2)) }],
    ["genTime", { genTime: utf8("20170331134016Z") }],
    ["four fields", { only: 4 }],
    ["three fields", { only: 3 }],
    ["no fields", { only: 0 }],
  ];
  for (const [name, parts] of wrong) assert.deepEqual(await stampsOf(rawTst(parts)), [], name);
  assert.notDeepEqual(await stampsOf(rawTst()), []);
});

test("a TSTInfo that is not a SEQUENCE is not read", async () => {
  assert.deepEqual(await stampsOf(tlv(0x31, integer(1n), oid("1.2.3.4"), sha256Imprint(), integer(1n), generalizedTime("20170331134016Z"))), []);
});

test("a message imprint whose hash algorithm is not a SEQUENCE holding an OID is not read", async () => {
  assert.deepEqual(await stampsOf(rawTst({ imprint: seq(explicit(0, oid(SHA256)), octets(new Uint8Array(32))) })), []);
  assert.deepEqual(await stampsOf(rawTst({ imprint: seq(seq(integer(5n)), octets(new Uint8Array(32))) })), []);
  assert.deepEqual(await stampsOf(rawTst({ imprint: seq() })), []);
  assert.deepEqual(await stampsOf(rawTst({ imprint: seq(seq()) })), []);
});

test("an empty tsa element costs every time stamp", async () => {
  assert.deepEqual(await stampsOf(rawTst({ rest: [tlv(0xa0)] })), []);
});

test("a TSTInfo of exactly a mebibyte is read and one byte more is not", { timeout: 30_000 }, async () => {
  const cap = 1024 * 1024;
  // The padding is an extensions element at the end, which the reader skips; its length is found, as the header grows with it.
  const withPad = (pad: number): Uint8Array => rawTst({ rest: [tsaName(), tlv(0xa1, new Uint8Array(pad))] });
  const base = withPad(0).length;
  const sized = (size: number): Uint8Array => {
    for (let pad = size - base - 12; pad <= size - base; pad++) {
      const info = withPad(pad);
      if (info.length === size) return info;
    }
    throw new Error(`no TSTInfo of ${size} bytes`);
  };
  assert.notDeepEqual(await stampsOf(sized(cap)), []);
  assert.deepEqual(await stampsOf(sized(cap + 1)), []);
});

// ---- the shape of the envelope ----

const evidenceOf = (...infos: Uint8Array[]): Uint8Array => explicit(0, ...infos.map(timeStampAndCrl));
const wrap = (...parts: Uint8Array[]): Uint8Array => seq(oid(ID_CT_TIMESTAMPED_DATA), explicit(0, seq(...parts)));
const embeddedText = (parsed: Parsed): string[] => parsed.embedded.map((part) => new TextDecoder().decode(part.bytes));

test("a data URI and meta data before the content are skipped", async () => {
  const data = wrap(integer(1n), text(0x16, "http://example.org/file"), seq(octets(Uint8Array.of(1))), octets(new TextEncoder().encode("body")), evidenceOf(tstInfo()));
  const parsed = await parseTsd(data);
  assert.deepEqual(embeddedText(parsed), ["body"]);
  assert.equal(parsed.metadata.get(`${LABEL}File-Parsed`), "true");
});

test("a data URI alone, and meta data alone, are skipped", async () => {
  const uri = await parseTsd(wrap(integer(1n), text(0x16, "x"), evidenceOf(tstInfo())));
  assert.equal(uri.metadata.get(`${LABEL}File-Parsed`), "true");
  const meta = await parseTsd(wrap(integer(1n), seq(), evidenceOf(tstInfo())));
  assert.equal(meta.metadata.get(`${LABEL}File-Parsed`), "true");
});

test("a SEQUENCE after the content is not meta data, and the time stamps are dropped with the envelope's shape", async () => {
  const parsed = await parseTsd(wrap(integer(1n), octets(new TextEncoder().encode("body")), seq(), evidenceOf(tstInfo())));
  assert.deepEqual(stampKeys(parsed.metadata), []);
  assert.deepEqual(embeddedText(parsed), ["body"]);
});

test("a second OCTET STRING is not the content, and the time stamps are dropped", async () => {
  const parsed = await parseTsd(wrap(integer(1n), octets(new TextEncoder().encode("one")), octets(new TextEncoder().encode("two")), evidenceOf(tstInfo())));
  assert.deepEqual(stampKeys(parsed.metadata), []);
  assert.deepEqual(embeddedText(parsed), ["one"]);
});

test("evidence that is not [0] gives no time stamps", async () => {
  const parsed = await parseTsd(wrap(integer(1n), octets(new Uint8Array(1)), explicit(1, timeStampAndCrl(tstInfo()))));
  assert.deepEqual(stampKeys(parsed.metadata), []);
});

test("evidence of the wrong kind in the TimeStampedData ends the envelope's time stamps, and a universal element is an error", async () => {
  // An INTEGER after the version is neither content, a URI, meta data nor evidence.
  const parsed = await parseTsd(wrap(integer(1n), integer(2n), octets(new Uint8Array(1)), evidenceOf(tstInfo())));
  assert.deepEqual(stampKeys(parsed.metadata), []);
  assert.deepEqual(embeddedText(parsed), []);
});

test("a TimeStampedData that does not start with an INTEGER gives neither stamps nor content", async () => {
  const parsed = await parseTsd(wrap(octets(new Uint8Array(1)), octets(new TextEncoder().encode("body")), evidenceOf(tstInfo())));
  assert.deepEqual(stampKeys(parsed.metadata), []);
  assert.deepEqual(embeddedText(parsed), []);
});

test("a time stamp token that is not a SEQUENCE, has no time stamp or is empty is dropped", async () => {
  const crl = (inner: Uint8Array): Uint8Array => explicit(0, inner);
  for (const evidence of [crl(integer(1n)), crl(seq()), crl(tlv(0x31)), explicit(0)]) {
    const parsed = await parseTsd(wrap(integer(1n), octets(new Uint8Array(1)), evidence));
    assert.deepEqual(stampKeys(parsed.metadata), []);
  }
});

/** The time stamp keys of an envelope whose evidence is the one TimeStampAndCRL `token`. */
const stampsInToken = async (token: Uint8Array): Promise<string[]> =>
  stampKeys((await parseTsd(wrap(integer(1n), octets(new Uint8Array(1)), explicit(0, token)))).metadata);

const ID_SIGNED = "1.2.840.113549.1.7.2";
const ID_TST = "1.2.840.113549.1.9.16.1.4";
const signedToken = (outer: string, signed: Uint8Array): Uint8Array => seq(seq(oid(outer), explicit(0, signed)));
const encapsulated = (type: string, content: Uint8Array): Uint8Array => seq(oid(type), explicit(0, content));

test("a token whose encapsulated content is of another type, or is not in an OCTET STRING, is dropped", async () => {
  const good = tstInfo();
  const signed = (inner: Uint8Array): Uint8Array => signedToken(ID_SIGNED, seq(integer(3n), set(), inner));
  assert.notDeepEqual(await stampsInToken(signed(encapsulated(ID_TST, octets(good)))), []);
  assert.deepEqual(await stampsInToken(signed(encapsulated("1.2.840.113549.1.9.16.1.5", octets(good)))), []);
  assert.deepEqual(await stampsInToken(signed(encapsulated(ID_TST, integer(1n)))), []);
  assert.deepEqual(await stampsInToken(signed(encapsulated(ID_TST, good))), []);
});

test("a token of another signed-data type, or without a version, digests and content in order, is dropped", async () => {
  const encap = encapsulated(ID_TST, octets(tstInfo()));
  assert.notDeepEqual(await stampsInToken(signedToken(ID_SIGNED, seq(integer(3n), set(), encap))), []);
  assert.deepEqual(await stampsInToken(signedToken("1.2.840.113549.1.7.3", seq(integer(3n), set(), encap))), []);
  // encapContentInfo is the third child of the SignedData, not the second or the fourth.
  assert.deepEqual(await stampsInToken(signedToken(ID_SIGNED, seq(integer(3n), encap))), []);
  assert.deepEqual(await stampsInToken(signedToken(ID_SIGNED, seq(integer(3n), set(), set(), encap))), []);
  assert.deepEqual(await stampsInToken(signedToken(ID_SIGNED, seq(integer(3n)))), []);
  // A token whose outer element is a SET, or whose [0] is empty or primitive, is not read either.
  assert.deepEqual(await stampsInToken(seq(tlv(0x31, oid(ID_SIGNED), explicit(0, seq(integer(3n), set(), encap))))), []);
  assert.deepEqual(await stampsInToken(seq(seq(oid(ID_SIGNED), explicit(0)))), []);
  assert.deepEqual(await stampsInToken(seq(seq(oid(ID_SIGNED), tlv(0x80, Uint8Array.of(1))))), []);
  assert.deepEqual(await stampsInToken(seq(seq(oid(ID_SIGNED)))), []);
});

test("a TSTInfo cut into OCTET STRING segments is joined, and one with a bad segment after it is dropped", async () => {
  const info = tstInfo();
  const half = Math.floor(info.length / 2);
  const segmented = tlv(0x24, octets(info.subarray(0, half)), octets(info.subarray(half)));
  const signed = (content: Uint8Array): Uint8Array => signedToken(ID_SIGNED, seq(integer(3n), set(), encapsulated(ID_TST, content)));
  assert.notDeepEqual(await stampsInToken(signed(segmented)), []);
  // The whole TSTInfo is there, then a segment that is not an OCTET STRING: the bytes are complete and the string is not.
  assert.deepEqual(await stampsInToken(signed(tlv(0x24, octets(info), integer(5n)))), []);
});

test("an envelope whose ContentInfo is shorter than its data is bounded by its own length", async () => {
  const data = envelope({ content: new TextEncoder().encode("body"), tokens: [tstInfo()] });
  // Shorten the outer SEQUENCE by one octet: the [0] it holds now runs past it, though the bytes are all there.
  const shortened = Uint8Array.from(data);
  assert.equal(shortened[0], 0x30);
  const lengthAt = shortened[1]! < 0x80 ? 1 : 2;
  if (shortened[1]! < 0x80) shortened[1] = shortened[1]! - 1;
  else shortened[2] = shortened[2]! - 1;
  assert.ok(lengthAt >= 1);
  await assert.rejects(parseTsd(shortened), MalformedDocumentError);
});

test("refusals of what is not an envelope say so", async () => {
  const refused = async (data: Uint8Array): Promise<void> => {
    await assert.rejects(parseTsd(data), (error: unknown) => error instanceof MalformedDocumentError && /Not a time stamped data envelope/.test(error.message));
  };
  await refused(integer(1n));
  await refused(seq(integer(1n)));
  await refused(seq(oid("1.2.3"), explicit(0, seq())));
  await refused(seq(oid(ID_CT_TIMESTAMPED_DATA)));
  await refused(seq(oid(ID_CT_TIMESTAMPED_DATA), tlv(0x80, Uint8Array.of(1))));
  await refused(seq(oid(ID_CT_TIMESTAMPED_DATA), explicit(1, seq())));
  await refused(seq(oid(ID_CT_TIMESTAMPED_DATA), explicit(0)));
  await refused(seq(oid(ID_CT_TIMESTAMPED_DATA), explicit(0, integer(1n))));
  await refused(seq(tlv(0x04, Uint8Array.of(1)), explicit(0, seq(integer(1n)))));
});

// ---- the embedded document hand-off ----

class RecordingExtractor implements EmbeddedDocumentExtractor {
  readonly seen: string[] = [];
  parsed = 0;
  stream: RipstreamInputStream | null = null;
  readonly #allow: boolean;
  readonly #failure: unknown;
  constructor(allow: boolean, failure?: unknown) {
    this.#allow = allow;
    this.#failure = failure;
  }
  shouldParseEmbedded(): boolean {
    return this.#allow;
  }
  async parseEmbedded(stream: RipstreamInputStream): Promise<void> {
    this.parsed++;
    this.stream = stream;
    if (this.#failure !== undefined) throw this.#failure;
  }
}

async function parseWith(extractor: RecordingExtractor, context = new ParseContext(), data = envelope({ content: new TextEncoder().encode("body"), tokens: [tstInfo()] })): Promise<void> {
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const stream = await RipstreamInputStream.from(data);
  try {
    await new TsdParser().parse(stream, new BodyContentHandler(), new Metadata(), context);
  } finally {
    await stream.close();
  }
}

test("an extractor that does not want the embedded document is not given it", async () => {
  const extractor = new RecordingExtractor(false);
  await parseWith(extractor);
  assert.equal(extractor.parsed, 0);
});

test("an envelope without content does not call the extractor", async () => {
  const extractor = new RecordingExtractor(true);
  await parseWith(extractor, new ParseContext(), envelope({ tokens: [tstInfo()] }));
  assert.equal(extractor.parsed, 0);
});

test("a failure of the embedded document is logged away and the parse ends normally", async () => {
  await parseWith(new RecordingExtractor(true, new Error("the PDF is broken")));
  await parseWith(new RecordingExtractor(true, new MalformedDocumentError("bad")));
});

test("a limit, a timeout, an abort or the end of the output is not swallowed", async () => {
  for (const failure of [new LimitExceededError("too many"), new ParseTimeoutError("slow"), new AbortError("stop"), new WriteLimitReachedError(5)]) {
    await assert.rejects(parseWith(new RecordingExtractor(true, failure)), (error: unknown) => error === failure, failure.name);
  }
});

test("an aborted context stops the parse even when the extractor fails with something else", async () => {
  const controller = new AbortController();
  const context = new ParseContext({ signal: controller.signal });
  controller.abort();
  const failure = new Error("an ordinary failure");
  await assert.rejects(parseWith(new RecordingExtractor(true, failure), context), (error: unknown) => error === failure);
});

test("the stream handed to the extractor is closed when it is done with", async () => {
  const extractor = new RecordingExtractor(true);
  await parseWith(extractor);
  assert.ok(extractor.stream !== null);
  // A closed stream has no bytes left to give; one that was left open still holds the content.
  const rest = await extractor.stream.read();
  assert.ok(rest === null || rest.length === 0);
});

test("the cut of a truncated envelope is recorded as the error's name and message", async () => {
  const data = envelope({ content: new TextEncoder().encode("hello world"), tokens: [tstInfo()], indefiniteLengths: true });
  const at = Buffer.from(data).indexOf("hello world");
  const parsed = await parseTsd(data.subarray(0, at + 5));
  assert.equal(new TextDecoder().decode(parsed.embedded[0]!.bytes), "hello");
  assert.deepEqual(parsed.embedded[0]!.metadata.getAll("tk:exception:embedded-stream-exception"), ["TruncatedAsn1Error: ASN.1 OCTET STRING is cut short"]);
});

test("the stamps go on the embedded metadata when the document already has some, and on the document when it has none", async () => {
  const data = envelope({ content: new TextEncoder().encode("body"), tokens: [tstInfo()] });
  const bare = await parseTsd(data);
  assert.equal(bare.metadata.get(`${LABEL}File-Parsed`), "true");
  assert.equal(bare.embedded[0]!.metadata.get(`${LABEL}File-Parsed`), null);
  const given = new Metadata();
  given.set("a", "b");
  const second = await parseTsd(data, new ParseContext(), given);
  assert.equal(second.metadata.get(`${LABEL}File-Parsed`), null);
  assert.equal(second.embedded[0]!.metadata.get(`${LABEL}File-Parsed`), "true");
});

// ---- BER lengths and tags as the envelope meets them ----

test("a content whose length is in two octets, three octets and four octets is read", async () => {
  for (const size of [127, 128, 255, 256, 65535, 65536, 70000]) {
    const content = new Uint8Array(size).fill(0x61);
    const parsed = await parseTsd(envelope({ content, tokens: [tstInfo()] }));
    assert.equal(parsed.embedded[0]!.bytes.length, size, `size ${size}`);
  }
});

// ---- the text of a GeneralName ----

const nameText = (element: Uint8Array): string => {
  const ber = new Ber(element);
  return generalNameToString(ber, ber.element(0, element.length), element.length);
};
const rdn = (type: string, tag: number, value: Uint8Array): Uint8Array => set(seq(oid(type), tlv(tag, value)));
const dirName = (...rdns: Uint8Array[]): Uint8Array => explicit(4, seq(...rdns));
const latin = (value: string): Uint8Array => Uint8Array.from(value, (char) => char.charCodeAt(0));

test("every attribute type BouncyCastle has a short name for is written with it", () => {
  const symbols: Array<[string, string]> = [
    ["2.5.4.3", "CN"], ["2.5.4.4", "SURNAME"], ["2.5.4.5", "SERIALNUMBER"], ["2.5.4.6", "C"], ["2.5.4.7", "L"], ["2.5.4.8", "ST"],
    ["2.5.4.9", "STREET"], ["2.5.4.10", "O"], ["2.5.4.11", "OU"], ["2.5.4.12", "T"], ["2.5.4.17", "PostalCode"], ["2.5.4.42", "GIVENNAME"],
    ["2.5.4.97", "organizationIdentifier"], ["1.2.840.113549.1.9.1", "E"], ["0.9.2342.19200300.100.1.1", "UID"], ["0.9.2342.19200300.100.1.25", "DC"],
  ];
  for (const [type, symbol] of symbols) assert.equal(nameText(dirName(rdn(type, 0x0c, latin("v")))), `4: ${symbol}=v`, type);
  assert.equal(nameText(dirName(rdn("2.5.4.99", 0x0c, latin("v")))), "4: 2.5.4.99=v");
});

test("the string types are decoded as BouncyCastle decodes them", () => {
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x0c, new TextEncoder().encode("é€")))), "4: CN=é€");
  assert.equal(nameText(dirName(rdn("2.5.4.6", 0x13, latin("IT")))), "4: C=IT");
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x14, latin("caf\xe9")))), "4: CN=caf\xe9");
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x16, latin("a@b")))), "4: CN=a@b");
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x1e, Uint8Array.of(0x00, 0x41, 0x20, 0xac)))), "4: CN=A\u20ac");
  // Types that are not strings, and a UniversalString, are the hex of their DER encoding.
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x02, Uint8Array.of(5)))), "4: CN=#020105");
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x1c, Uint8Array.of(0, 0, 0, 0x41)))), "4: CN=#1c0400000041");
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x04, Uint8Array.of(1, 2)))), "4: CN=#04020102");
  // A value of a context class or a constructed type is refused.
  assert.throws(() => nameText(dirName(set(seq(oid("2.5.4.3"), tlv(0x8c, latin("v")))))), MalformedDocumentError);
  assert.throws(() => nameText(dirName(set(seq(oid("2.5.4.3"), tlv(0x30, tlv(0x0c, latin("v"))))))), MalformedDocumentError);
});

test("the hex of an encoding is written with the length octets that DER gives it", () => {
  const value = (size: number): string => nameText(dirName(rdn("2.5.4.3", 0x1c, new Uint8Array(size))));
  assert.equal(value(127), `4: CN=#1c7f${"00".repeat(127)}`);
  assert.equal(value(128), `4: CN=#1c8180${"00".repeat(128)}`);
  assert.equal(value(255), `4: CN=#1c81ff${"00".repeat(255)}`);
  assert.equal(value(256), `4: CN=#1c820100${"00".repeat(256)}`);
  assert.equal(value(300), `4: CN=#1c82012c${"00".repeat(300)}`);
  assert.equal(value(65535), `4: CN=#1c82ffff${"00".repeat(65535)}`);
  assert.equal(value(65536), `4: CN=#1c8400010000${"00".repeat(65536)}`);
  assert.equal(value(70000), `4: CN=#1c84000111700${"00".repeat(70000)}`.replace("700", "70"));
});

test("the characters of RFC 2253 each get a backslash, and outer spaces too", () => {
  for (const char of [",", '"', "\\", "+", "=", "<", ">", ";"]) {
    assert.equal(nameText(dirName(rdn("2.5.4.3", 0x0c, latin(`a${char}b`)))), `4: CN=a\\${char}b`, char);
  }
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x0c, latin("a#b")))), "4: CN=a#b");
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x0c, latin("a b")))), "4: CN=a b");
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x0c, latin("  x  ")))), "4: CN=\\ \\ x\\ \\ ");
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x0c, latin("x ")))), "4: CN=x\\ ");
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x0c, latin(" x")))), "4: CN=\\ x");
  // A number sign first is escaped once, and what follows an escaped number sign is escaped as usual.
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x0c, latin("#a,b")))), "4: CN=\\#a\\,b");
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x0c, latin("\\#x")))), "4: CN=\\#x");
});

test("a Name that is not a SEQUENCE, an RDN that is not a SET and an attribute of one or three parts are refused", () => {
  assert.throws(() => nameText(explicit(4, set())), MalformedDocumentError);
  assert.throws(() => nameText(explicit(4, tlv(0x04, Uint8Array.of(1)))), MalformedDocumentError);
  assert.throws(() => nameText(dirName(set(seq(oid("2.5.4.3"))))), MalformedDocumentError);
  assert.throws(() => nameText(dirName(set(seq(oid("2.5.4.3"), utf8("a"), utf8("b"))))), MalformedDocumentError);
  assert.throws(() => nameText(dirName(set(seq(utf8("a"), utf8("b"))))), MalformedDocumentError);
  assert.throws(() => nameText(dirName(set(seq(explicit(0, oid("2.5.4.3")), utf8("b"))))), MalformedDocumentError);
  assert.throws(() => nameText(explicit(4)), MalformedDocumentError);
  assert.throws(() => nameText(tlv(0x88, Uint8Array.of(0x2a, 0x86))), MalformedDocumentError);
});

test("an RDN of several attributes is joined with plus signs and several RDNs with commas, with nothing around them", () => {
  assert.equal(nameText(dirName(set(seq(oid("2.5.4.3"), utf8("a")), seq(oid("2.5.4.10"), utf8("b"))), rdn("2.5.4.6", 0x13, latin("IT")))), "4: CN=a+O=b,C=IT");
  assert.equal(nameText(dirName()), "4: ");
});

test("a rfc822 name, a DNS name and a URI are text, and other names are hex", () => {
  assert.equal(nameText(text(0x81, "tsa@example.org")), "1: tsa@example.org");
  assert.equal(nameText(text(0x82, "example.org")), "2: example.org");
  assert.equal(nameText(text(0x86, "http://example.org/")), "6: http://example.org/");
  assert.equal(nameText(tlv(0x87, Uint8Array.of(10, 0, 0, 1))), "7: #0a000001");
  assert.equal(nameText(tlv(0x88, Uint8Array.of(0x2a, 0x03, 0x04))), "8: 1.2.3.4");
  assert.equal(nameText(tlv(0x80, Uint8Array.of(0xab, 0xcd))), "0: #abcd");
  assert.equal(nameText(tlv(0xa3, Uint8Array.of(0xab, 0xcd))), "3: #abcd");
  assert.equal(nameText(tlv(0x85, Uint8Array.of(0x01))), "5: #01");
});

test("a name of nothing but spaces has each one escaped once", () => {
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x0c, latin("  ")))), "4: CN=\\ \\ ");
  assert.equal(nameText(dirName(rdn("2.5.4.3", 0x0c, latin(" ")))), "4: CN=\\ ");
});

// ---- the envelope's own bounds and shapes ----

test("the parser names itself and the type it reads", () => {
  const parser = new TsdParser();
  assert.equal(parser.name, "TSDParser");
  assert.deepEqual([...parser.getSupportedTypes()].map(String), ["application/timestamped-data"]);
});

const body = new TextEncoder().encode("body");
const tokenBytes = (info = tstInfo()): Uint8Array => timeStampAndCrl(info);
const indefiniteEvidence = (): Uint8Array => indefinite(0xa0, tokenBytes());
/** The TimeStampedData of an envelope, indefinite, and the ContentInfo around it as the caller likes. */
const indefiniteTsd = (): Uint8Array => indefinite(0x30, integer(1n), octets(body), indefiniteEvidence());

test("a ContentInfo whose own length ends before its indefinite parts do is cut there, not read on into what follows", async () => {
  const inner = concat(oid(ID_CT_TIMESTAMPED_DATA), indefinite(0xa0, indefiniteTsd()));
  // Drop the last six bytes, the ends of the evidence, the TimeStampedData and the [0], and put them after the SEQUENCE instead.
  const data = concat(tlv(0x30, inner.subarray(0, inner.length - 6)), new Uint8Array(6));
  const parsed = await parseTsd(data);
  // The content comes before the evidence and is whole; the evidence is the part that does not end.
  assert.deepEqual(stampKeys(parsed.metadata), []);
  assert.deepEqual(embeddedText(parsed), ["body"]);
});

test("a [0] whose own length ends before the TimeStampedData does is cut there, not read on into what follows", async () => {
  const tsd = indefiniteTsd();
  const data = indefinite(0x30, oid(ID_CT_TIMESTAMPED_DATA), tlv(0xa0, tsd.subarray(0, tsd.length - 4)), new Uint8Array(4));
  const parsed = await parseTsd(data);
  assert.deepEqual(stampKeys(parsed.metadata), []);
  assert.deepEqual(embeddedText(parsed), ["body"]);
});

test("the type of a ContentInfo is a primitive OBJECT IDENTIFIER, not another tag with the same bytes", async () => {
  const typeBytes = oid(ID_CT_TIMESTAMPED_DATA).subarray(2);
  const good = envelope({ content: body, tokens: [tstInfo()] });
  assert.equal(stampKeys((await parseTsd(good)).metadata).length, 9);
  for (const tag of [0x26, 0x04, 0x0c]) {
    const data = seq(tlv(tag, typeBytes), explicit(0, seq(integer(1n), octets(body), explicit(0, tokenBytes()))));
    await assert.rejects(parseTsd(data), MalformedDocumentError, `tag ${tag}`);
  }
});

test("the type of a token's ContentInfo is a primitive OBJECT IDENTIFIER too", async () => {
  const typeBytes = oid(ID_SIGNED).subarray(2);
  const signed = seq(integer(3n), set(), encapsulated(ID_TST, octets(tstInfo())));
  for (const tag of [0x26, 0x04]) {
    assert.deepEqual(await stampsInToken(seq(seq(tlv(tag, typeBytes), explicit(0, signed)))), [], `tag ${tag}`);
  }
  assert.equal((await stampsInToken(signedToken(ID_SIGNED, signed))).length, 9);
});

test("a TimeStampedData that is shorter than its content is read to its own end, and the cut is recorded", async () => {
  // The OCTET STRING says ten bytes, the TimeStampedData holds five of them, and the other five lie past it in the [0].
  const tsd = tlv(0x30, integer(1n), Uint8Array.of(0x04, 10), new TextEncoder().encode("01234"));
  const data = seq(oid(ID_CT_TIMESTAMPED_DATA), explicit(0, tsd, new TextEncoder().encode("56789")));
  const parsed = await parseTsd(data);
  assert.deepEqual(embeddedText(parsed), ["01234"]);
  assert.deepEqual(parsed.embedded[0]!.metadata.getAll("tk:exception:embedded-stream-exception"), ["TruncatedAsn1Error: ASN.1 OCTET STRING is cut short"]);
});

test("a constructed content whose segments run past the end of the TimeStampedData is read only to that end", async () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);
  // The first segment is inside the TimeStampedData; the second and the end of the string lie past it, in the [0].
  const tsd = tlv(0x30, integer(1n), Uint8Array.of(0x24, 0x80), octets(text("ab")));
  const data = seq(oid(ID_CT_TIMESTAMPED_DATA), explicit(0, tsd, octets(text("cd")), new Uint8Array(2)));
  const parsed = await parseTsd(data);
  assert.deepEqual(embeddedText(parsed), ["ab"]);
  assert.deepEqual(parsed.embedded[0]!.metadata.getAll("tk:exception:embedded-stream-exception"), ["TruncatedAsn1Error: ASN.1 OCTET STRING is not closed"]);
});

test("a metaData that is not a constructed SEQUENCE is not skipped over", async () => {
  const withMeta = (meta: Uint8Array): Uint8Array => wrap(integer(1n), meta, octets(body), evidenceOf(tstInfo()));
  const ok = await parseTsd(withMeta(seq(integer(1n))));
  assert.equal(stampKeys(ok.metadata).length, 9);
  assert.deepEqual(embeddedText(ok), ["body"]);
  // Tag number 16 with the constructed bit clear.
  const bad = await parseTsd(withMeta(tlv(0x10, Uint8Array.of(1))));
  assert.deepEqual(stampKeys(bad.metadata), []);
  assert.deepEqual(embeddedText(bad), []);
});

/** The envelope of `parts` opened, for the functions that give a reason rather than an empty result. */
const stampError = (...parts: Uint8Array[]): string => {
  try {
    readTimeStamps(openEnvelope(wrap(...parts)));
  } catch (error) {
    assert.ok(error instanceof MalformedDocumentError);
    return error.message;
  }
  return "no error";
};

test("the reason time stamps are refused is the first thing that was wrong", () => {
  const stamps = tokenBytes();
  // An element of another class where the evidence is.
  assert.equal(stampError(integer(1n), octets(body), tlv(0x60, stamps)), "Unexpected element in a TimeStampedData");
  // A primitive [0], and an empty one.
  assert.equal(stampError(integer(1n), octets(body), tlv(0x80, stamps)), "No time stamp token evidence");
  assert.equal(stampError(integer(1n), octets(body), explicit(0)), "The time stamp token evidence is empty");
  assert.equal(stampError(integer(1n), octets(body)), "No time stamp token evidence");
  // One good token does not make up for a bad one before it.
  assert.equal(stampError(integer(1n), octets(body), explicit(0, seq(), stamps)), "A TimeStampAndCRL has a time stamp token");
  // A SET holding a token is not a TimeStampAndCRL.
  const token = seq(oid(ID_SIGNED), explicit(0, seq(integer(3n), set(), encapsulated(ID_TST, octets(tstInfo())))));
  assert.equal(stampError(integer(1n), octets(body), explicit(0, tlv(0x31, token))), "A TimeStampAndCRL is a SEQUENCE");
});

test("a token with a primitive [0] says it has no content, and one whose TSTInfo is not an OCTET STRING is dropped", async () => {
  const typeAndPrimitive = seq(seq(oid(ID_SIGNED), tlv(0x80, Uint8Array.of(1))));
  assert.equal(stampError(integer(1n), octets(body), explicit(0, typeAndPrimitive)), "a time stamp token has no content");
  const info = tstInfo();
  const asUtf8 = seq(integer(3n), set(), encapsulated(ID_TST, tlv(0x0c, info)));
  assert.deepEqual(await stampsInToken(signedToken(ID_SIGNED, asUtf8)), []);
  const asOctets = seq(integer(3n), set(), encapsulated(ID_TST, octets(info)));
  assert.equal((await stampsInToken(signedToken(ID_SIGNED, asOctets))).length, 9);
});

test("a time of year 0000 is year 0, and the other fields of it are as given", async () => {
  const { metadata } = await parseTsd(envelope({ content: body, tokens: [tstInfo({ genTime: "00000102030405Z" })] }));
  assert.equal(metadata.get(`${LABEL}Time-Stamp-DateTime`), "02/01/0000 03:04:05 UTC");
});
