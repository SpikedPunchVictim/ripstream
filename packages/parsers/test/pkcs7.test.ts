import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  type EmbeddedDocumentExtractor,
} from "@spikedpunch/ripstream-core";
import { Asn1Parser } from "../src/asn1.ts";
import { Pkcs7Parser } from "../src/pkcs7.ts";
import { SHA256, concat, explicit, indefinite, integer, octets, oid, seq, set, tlv } from "./tsd-builder.ts";

/*
 * Tests of the Pkcs7Parser (tikajs-68os.70): a CMS ContentInfo is classified by its content type OID, and the content of a
 * signedData that holds its own is handed to the embedded document extractor. The CMS is built from RFC 5652 with the
 * lengths under the test's control; nothing in it is signed. The parser is constructed directly. Read from the Tika source
 * (Pkcs7Parser, CmsClassifier), not run against a Tika.
 */

const ID_DATA = "1.2.840.113549.1.7.1";
const ID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const ID_ENVELOPED_DATA = "1.2.840.113549.1.7.3";
const ID_DIGESTED_DATA = "1.2.840.113549.1.7.5";
const ID_ENCRYPTED_DATA = "1.2.840.113549.1.7.6";
const ID_COMPRESSED_DATA = "1.2.840.113549.1.9.16.1.9";

const SIGNED_TYPE = "application/pkcs7-mime; smime-type=signed-data";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A stand-in for a certificate and for a signer info: the parser looks at how many there are, not at what they hold. */
const CERTIFICATE = seq(seq(integer(1n)), seq(oid(SHA256)), tlv(0x03, Uint8Array.of(0)));
const SIGNER_INFO = seq(integer(1n));

interface SignedOptions {
  /** The content as the octets of one OCTET STRING; omitted for a detached signature. */
  content?: Uint8Array;
  /** The content as OCTET STRING segments of a constructed, indefinite-length OCTET STRING. */
  segments?: Uint8Array[];
  certificates?: boolean;
  signers?: boolean;
  indefiniteLengths?: boolean;
}

function signedData(options: SignedOptions = {}): Uint8Array {
  const wrap = options.indefiniteLengths === true ? indefinite : tlv;
  const eContent =
    options.segments !== undefined
      ? [wrap(0xa0, indefinite(0x24, ...options.segments.map(octets)))]
      : options.content !== undefined
        ? [wrap(0xa0, octets(options.content))]
        : [];
  const parts = [integer(1n), set(seq(oid(SHA256))), wrap(0x30, oid(ID_DATA), ...eContent)];
  if (options.certificates === true) parts.push(wrap(0xa0, CERTIFICATE));
  parts.push(set(...(options.signers === true ? [SIGNER_INFO] : [])));
  return contentInfo(ID_SIGNED_DATA, wrap(0x30, ...parts), options.indefiniteLengths === true);
}

function contentInfo(type: string, body: Uint8Array, indefiniteLengths = false): Uint8Array {
  const wrap = indefiniteLengths ? indefinite : tlv;
  return wrap(0x30, oid(type), wrap(0xa0, body));
}

class RecordingExtractor implements EmbeddedDocumentExtractor {
  readonly contents: Uint8Array[] = [];
  allow = true;
  readonly #failure: unknown;
  constructor(failure?: unknown) {
    this.#failure = failure;
  }
  shouldParseEmbedded(): boolean {
    return this.allow;
  }
  async parseEmbedded(stream: RipstreamInputStream): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    this.contents.push(concat(...chunks));
    if (this.#failure !== undefined) throw this.#failure;
  }
}

async function parse(
  data: Uint8Array,
  extractor = new RecordingExtractor(),
): Promise<{ metadata: Metadata; extractor: RecordingExtractor; text: string }> {
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const metadata = new Metadata();
  const handler = new BodyContentHandler();
  const stream = await RipstreamInputStream.from(data);
  try {
    await new Pkcs7Parser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { metadata, extractor, text: handler.toString() };
}

const decoded = (extractor: RecordingExtractor): string[] => extractor.contents.map((content) => new TextDecoder().decode(content));

test("a signedData with its content labels the type signed-data and embeds the content", async () => {
  const { metadata, extractor } = await parse(signedData({ content: bytes("<xml/>"), certificates: true, signers: true }));
  assert.equal(metadata.get("Content-Type"), SIGNED_TYPE);
  assert.deepEqual(decoded(extractor), ["<xml/>"]);
});

test("a signedData in BER indefinite lengths, its content cut into segments, embeds the whole content", async () => {
  const { extractor } = await parse(
    signedData({ segments: [bytes("one "), bytes("two "), bytes("three")], indefiniteLengths: true, signers: true }),
  );
  assert.deepEqual(decoded(extractor), ["one two three"]);
});

test("a detached signature (signers, no content) is application/pkcs7-signature and embeds nothing", async () => {
  const { metadata, extractor } = await parse(signedData({ certificates: true, signers: true }));
  assert.equal(metadata.get("Content-Type"), "application/pkcs7-signature");
  assert.equal(extractor.contents.length, 0);
});

test("certificates without signers or content is smime-type=certs-only", async () => {
  const { metadata } = await parse(signedData({ certificates: true }));
  assert.equal(metadata.get("Content-Type"), "application/pkcs7-mime; smime-type=certs-only");
});

test("neither certificates nor signers nor content is a detached signature, as Tika's classifier says", async () => {
  const { metadata } = await parse(signedData());
  assert.equal(metadata.get("Content-Type"), "application/pkcs7-signature");
});

for (const [name, type, label] of [
  ["enveloped", ID_ENVELOPED_DATA, "enveloped-data"],
  ["digested", ID_DIGESTED_DATA, "digested-data"],
  ["encrypted", ID_ENCRYPTED_DATA, "encrypted-data"],
  ["compressed", ID_COMPRESSED_DATA, "compressed-data"],
] as const) {
  test(`${name} data is labelled ${label} and gives an empty document`, async () => {
    const { metadata, extractor, text } = await parse(contentInfo(type, seq(integer(0n))));
    assert.equal(metadata.get("Content-Type"), `application/pkcs7-mime; smime-type=${label}`);
    assert.equal(extractor.contents.length, 0);
    assert.equal(text.trim(), "");
  });
}

test("a ContentInfo of another type is an empty document with the type left alone", async () => {
  const { metadata, text } = await parse(contentInfo(ID_DATA, octets(bytes("x"))));
  assert.equal(metadata.get("Content-Type"), null);
  assert.equal(text.trim(), "");
});

test("data that is not DER is an empty document and does not throw, as in Tika", async () => {
  const { metadata, extractor } = await parse(bytes("not asn.1 at all"));
  assert.equal(metadata.get("Content-Type"), null);
  assert.equal(extractor.contents.length, 0);
});

test("a signedData cut short inside its content is a MalformedDocumentError, not an empty document", async () => {
  const whole = signedData({ content: bytes("0123456789"), signers: true });
  await assert.rejects(parse(whole.subarray(0, whole.length - 30)), MalformedDocumentError);
});

test("a signedData whose SignedData is not a SEQUENCE is a MalformedDocumentError", async () => {
  await assert.rejects(parse(contentInfo(ID_SIGNED_DATA, octets(bytes("x")))), MalformedDocumentError);
});

test("a content length that claims gigabytes does not allocate and is refused", async () => {
  const huge = concat(Uint8Array.of(0x04, 0x84, 0x7f, 0xff, 0xff, 0xff), bytes("short"));
  const data = seq(oid(ID_SIGNED_DATA), explicit(0, seq(integer(1n), set(), seq(oid(ID_DATA), explicit(0, huge)))));
  await assert.rejects(parse(data), MalformedDocumentError);
});

test("deeply nested indefinite lengths are refused rather than recursed into", async () => {
  let nested: Uint8Array = integer(1n);
  for (let depth = 0; depth < 5000; depth++) nested = indefinite(0x30, nested);
  const data = indefinite(0x30, oid(ID_SIGNED_DATA), indefinite(0xa0, indefinite(0x30, integer(1n), nested)));
  await assert.rejects(parse(data), MalformedDocumentError);
});

test("a failure of the embedded document's parse is not swallowed", async () => {
  const failure = new LimitExceededError("too many embedded bytes");
  await assert.rejects(
    parse(signedData({ content: bytes("x"), signers: true }), new RecordingExtractor(failure)),
    LimitExceededError,
  );
});

test("the extractor can decline the content", async () => {
  const declining = new RecordingExtractor();
  declining.allow = false;
  const { extractor } = await parse(signedData({ content: bytes("x"), signers: true }), declining);
  assert.equal(extractor.contents.length, 0);
});

// ---- what the classification and the bounds depend on (mutation hardening) ----

const DIGESTS = set(seq(oid(SHA256)));
const NO_CONTENT = seq(oid(ID_DATA));

/** A signedData assembled from the children of its SEQUENCE, in the order given, with definite lengths. */
function signedOf(...children: Uint8Array[]): Uint8Array {
  return contentInfo(ID_SIGNED_DATA, seq(...children));
}

const types = (parser: { getSupportedTypes(): ReadonlySet<{ toString(): string }> }): string[] =>
  [...parser.getSupportedTypes()].map((type) => type.toString()).sort();

test("the Pkcs7Parser claims application/pkcs7-mime and application/pkcs7-signature", () => {
  assert.deepEqual(types(new Pkcs7Parser()), ["application/pkcs7-mime", "application/pkcs7-signature"]);
});

test("the generic ASN.1 parser no longer claims the two types the Pkcs7Parser has", () => {
  const claimed = types(new Asn1Parser());
  assert.equal(claimed.includes("application/pkcs7-mime"), false);
  assert.equal(claimed.includes("application/pkcs7-signature"), false);
});

test("data cut inside the first header is an empty document and does not throw", async () => {
  for (const data of [new Uint8Array(0), Uint8Array.of(0x30), Uint8Array.of(0x30, 0x82, 0x01)]) {
    const { metadata, extractor } = await parse(data);
    assert.equal(metadata.get("Content-Type"), null);
    assert.equal(extractor.contents.length, 0);
  }
});

test("only an OBJECT IDENTIFIER first element gives a type: the same bytes in an OCTET STRING give none", async () => {
  const bytesOfOid = oid(ID_ENVELOPED_DATA).subarray(2);
  const { metadata } = await parse(seq(octets(bytesOfOid), explicit(0, seq(integer(0n)))));
  assert.equal(metadata.get("Content-Type"), null);
});

test("the content is read from where the signedData is, so a content cut short is an error and not its bytes so far", async () => {
  // The eContent is a constructed OCTET STRING of indefinite length that the [0] ends in the middle of: no end-of-contents.
  const open = concat(Uint8Array.of(0x24, 0x80), octets(bytes("ab")));
  const data = signedOf(integer(1n), DIGESTS, seq(oid(ID_DATA), explicit(0, open)), set());
  const extractor = new RecordingExtractor();
  await assert.rejects(parse(data, extractor), MalformedDocumentError);
  assert.equal(extractor.contents.length, 0);
});

test("the content stops where its [0] stops: segments and an end-of-contents after it are not part of it", async () => {
  const open = concat(Uint8Array.of(0x24, 0x80), octets(bytes("ab")));
  const after = concat(octets(bytes("cd")), Uint8Array.of(0, 0));
  const data = signedOf(integer(1n), DIGESTS, seq(oid(ID_DATA), explicit(0, open), after), set());
  await assert.rejects(parse(data), MalformedDocumentError);
});

test("a content that claims more bytes than its [0] holds is refused even when the signedData has them after it", async () => {
  const claims = Uint8Array.of(0x04, 0x08, 0x41, 0x42);
  const data = signedOf(integer(1n), DIGESTS, seq(oid(ID_DATA), explicit(0, claims), bytes("CDEFGH")), set());
  const extractor = new RecordingExtractor();
  await assert.rejects(parse(data, extractor), MalformedDocumentError);
  assert.equal(extractor.contents.length, 0);
});

test("a SignedData of indefinite length ends with its [0], not with an end-of-contents that follows the ContentInfo", async () => {
  const open = concat(Uint8Array.of(0x30, 0x80), integer(1n), DIGESTS, NO_CONTENT, set());
  const data = concat(contentInfo(ID_SIGNED_DATA, open), Uint8Array.of(0, 0));
  await assert.rejects(parse(data), MalformedDocumentError);
});

test("the content of a ContentInfo that is not [0] is refused", async () => {
  const data = seq(oid(ID_SIGNED_DATA), seq(seq(integer(1n), DIGESTS, NO_CONTENT, set())));
  await assert.rejects(parse(data), /no content/);
});

test("the SignedData must be a SEQUENCE", async () => {
  await assert.rejects(parse(contentInfo(ID_SIGNED_DATA, octets(bytes("x")))), /not a SEQUENCE/);
});

test("the SignedData starts with its version, an INTEGER", async () => {
  await assert.rejects(parse(signedOf(octets(bytes("1")), DIGESTS, NO_CONTENT, set())), /no version/);
});

test("the first SET is the digest algorithms: certificates and no second SET are still certificates only", async () => {
  const { metadata } = await parse(signedOf(integer(1n), DIGESTS, NO_CONTENT, explicit(0, CERTIFICATE)));
  assert.equal(metadata.get("Content-Type"), "application/pkcs7-mime; smime-type=certs-only");
});

test("certificates are SEQUENCEs: a [0] that holds something else is no certificates, so the message is a detached signature", async () => {
  const { metadata } = await parse(signedOf(integer(1n), DIGESTS, NO_CONTENT, explicit(0, octets(bytes("x"))), set()));
  assert.equal(metadata.get("Content-Type"), "application/pkcs7-signature");
});

test("the encapsulated content must start with its type, and its content must be [0] holding an OCTET STRING", async () => {
  await assert.rejects(parse(signedOf(integer(1n), DIGESTS, seq(integer(1n)), set())), /no type/);
  await assert.rejects(parse(signedOf(integer(1n), DIGESTS, seq(oid(ID_DATA), set()), set())), /not \[0\]/);
  await assert.rejects(parse(signedOf(integer(1n), DIGESTS, seq(oid(ID_DATA), explicit(0, integer(1n))), set())), /not an OCTET STRING/);
});

test("the stream handed to the extractor is closed after it, also when the extractor fails", async () => {
  for (const failure of [undefined, new Error("embedded failure")]) {
    let closed = 0;
    const extractor = new RecordingExtractor(failure);
    const parseEmbedded = extractor.parseEmbedded.bind(extractor);
    extractor.parseEmbedded = async (stream) => {
      const close = stream.close.bind(stream);
      stream.close = async () => {
        closed++;
        await close();
      };
      await parseEmbedded(stream);
    };
    await parse(signedData({ content: bytes("x"), signers: true }), extractor).catch(() => undefined);
    assert.equal(closed, 1);
  }
});

test("a content that claims bytes beyond an unterminated [0] is refused when the claim reaches into what follows the content", async () => {
  const claims = concat(Uint8Array.of(0xa0, 0x80, 0x04, 0x04), bytes("AB"));
  const extractor = new RecordingExtractor();
  await assert.rejects(parse(signedOf(integer(1n), DIGESTS, seq(oid(ID_DATA), claims), set()), extractor), MalformedDocumentError);
  assert.equal(extractor.contents.length, 0);
});
