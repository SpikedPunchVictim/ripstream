import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  LimitExceededError,
  TIKA_KEYS,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { Ber } from "../src/ber.ts";
import { generalNameToString } from "../src/general-name.ts";
import { TsdParser } from "../src/tsd.ts";
import {
  COMMON_NAME,
  ORGANIZATION,
  ORGANIZATIONAL_UNIT,
  concat,
  directoryName,
  envelope,
  explicit,
  indefinite,
  integer,
  octets,
  oid,
  seq,
  text,
  tlv,
  tstInfo,
} from "./tsd-builder.ts";

/*
 * TSDParser (tikajs-68os.21), from Tika 4.2.0's TSDParserTest (the module test and the integration test), which ships the
 * seven envelopes read here. What the fixtures in fixtures/timestamped-data/*.json say about text is not repeated. Read from
 * the Tika source, not run against a Tika; BouncyCastle, which Tika reads the envelope with, was not available.
 */

const TSD = "application/timestamped-data";
const LABEL = "Time-Stamp-n.1 - ";

const file = (name: string): Uint8Array => readFileSync(new URL(`./fixtures/timestamped-data/${name}`, import.meta.url));
const JAVA_FILES = ["MANIFEST.XML.TSD", "Test1.txt.tsd", "Test2.txt.tsd", "Test3.docx.tsd", "Test4.pdf.tsd", "Test5.PNG.tsd"];

interface Embedded {
  readonly metadata: Metadata;
  readonly bytes: Uint8Array;
}

/** TSDParser called directly, as the Java test calls it: nothing parses the stamped file, its bytes are kept. */
async function parseDirect(
  data: Uint8Array,
  metadata = new Metadata(),
): Promise<{ metadata: Metadata; embedded: Embedded[] }> {
  const resources = new EmbeddedDocumentBytesHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  const stream = await RipstreamInputStream.from(data);
  try {
    await new TsdParser().parse(stream, new BodyContentHandler(), metadata, context);
  } finally {
    await stream.close();
  }
  return { metadata, embedded: resources.resources.map(({ metadata: meta, bytes }) => ({ metadata: meta, bytes })) };
}

const keysWithLabel = (metadata: Metadata): string[] => metadata.names().filter((name) => name.startsWith("Time-Stamp-n."));

// ---- what Tika asserts ----

for (const name of JAVA_FILES) {
  test(`${name}: the document's own metadata names the envelope and says it was parsed (testTSDFileData)`, async () => {
    const { metadata } = await parseDirect(file(name));
    assert.equal(metadata.get(`${LABEL}Description`), "Time Stamped Data Envelope");
    assert.equal(metadata.get(`${LABEL}Content-Type`), TSD);
    assert.equal(metadata.get(`${LABEL}File-Parsed`), "true");
  });
}

test("Test1.txt.tsd: what the token says, read from the file (Tika asserts none of these values)", async () => {
  const { metadata, embedded } = await parseDirect(file("Test1.txt.tsd"));
  assert.equal(metadata.get(`${LABEL}Policy-Id`), "1.3.6.1.4.1.8526.1.2.4");
  assert.equal(metadata.get(`${LABEL}Time-Stamp-DateTime`), "31/03/2017 13:40:16 UTC");
  assert.equal(metadata.get(`${LABEL}Serial-Number`), "3631433933");
  assert.equal(metadata.get(`${LABEL}Algorithm`), "SHA256");
  assert.equal(
    metadata.get(`${LABEL}TSA`),
    "4: C=IT,O=Consiglio Nazionale del Notariato,OU=Servizio Marcatura Temporale,CN=Consiglio Nazionale del Notariato Time Stamping Authority 14",
  );
  assert.match(metadata.get(`${LABEL}File-Parsed-DateTime`) ?? "", /^\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d UTC$/);
  assert.equal(embedded.length, 1);
  assert.equal(new TextDecoder().decode(embedded[0]!.bytes), "This is a test");
});

// ---- where the time stamp metadata goes ----

test("with metadata already on the document the time stamps go on the embedded document instead", async () => {
  const metadata = new Metadata();
  metadata.set("Content-Type", TSD);
  const { embedded } = await parseDirect(file("Test1.txt.tsd"), metadata);
  assert.deepEqual(keysWithLabel(metadata), []);
  assert.equal(embedded[0]!.metadata.get(`${LABEL}Description`), "Time Stamped Data Envelope");
});

// ---- the token's fields, from envelopes built to say them ----

test("a token's fields are written as Tika writes them", async () => {
  const data = envelope({
    content: new TextEncoder().encode("hello"),
    tokens: [
      tstInfo({
        policy: "1.2.3.4.5",
        serial: 0xdeadbeefn,
        genTime: "20201231235959Z",
        algorithm: "1.3.14.3.2.26",
        tsa: directoryName([[COMMON_NAME, "Test TSA"]], [[ORGANIZATION, "Acme"]]),
      }),
    ],
  });
  const { metadata, embedded } = await parseDirect(data);
  assert.equal(metadata.get(`${LABEL}Policy-Id`), "1.2.3.4.5");
  assert.equal(metadata.get(`${LABEL}Serial-Number`), "deadbeef");
  assert.equal(metadata.get(`${LABEL}Time-Stamp-DateTime`), "31/12/2020 23:59:59 UTC");
  assert.equal(metadata.get(`${LABEL}Algorithm`), "SHA1");
  assert.equal(metadata.get(`${LABEL}TSA`), "4: CN=Test TSA,O=Acme");
  assert.equal(new TextDecoder().decode(embedded[0]!.bytes), "hello");
});

test("an algorithm Tika has no name for is written as its OID, a token without a TSA as null", async () => {
  const data = envelope({ content: new Uint8Array(1), tokens: [tstInfo({ algorithm: "1.2.3.4.99", tsa: null })] });
  const { metadata } = await parseDirect(data);
  assert.equal(metadata.get(`${LABEL}Algorithm`), "1.2.3.4.99");
  assert.equal(metadata.get(`${LABEL}TSA`), "null");
});

test("a negative serial number is written with a minus sign and a time with a zone is moved to UTC", async () => {
  const data = envelope({
    content: new Uint8Array(1),
    tokens: [tstInfo({ serial: -255n, genTime: "20170331134016.123+0200" })],
  });
  const { metadata } = await parseDirect(data);
  assert.equal(metadata.get(`${LABEL}Serial-Number`), "-ff");
  assert.equal(metadata.get(`${LABEL}Time-Stamp-DateTime`), "31/03/2017 11:40:16 UTC");
});

test("two tokens are numbered from one", async () => {
  const data = envelope({
    content: new Uint8Array(1),
    tokens: [tstInfo({ policy: "1.1" }), tstInfo({ policy: "1.2" })],
  });
  const { metadata } = await parseDirect(data);
  assert.equal(metadata.get("Time-Stamp-n.1 - Policy-Id"), "1.1");
  assert.equal(metadata.get("Time-Stamp-n.2 - Policy-Id"), "1.2");
});

test("indefinite lengths all the way down read the same as definite ones", async () => {
  const options = { content: new TextEncoder().encode("same"), tokens: [tstInfo({ policy: "1.9.9" })] };
  const definite = await parseDirect(envelope(options));
  const streamed = await parseDirect(envelope({ ...options, indefiniteLengths: true }));
  assert.equal(streamed.metadata.get(`${LABEL}Policy-Id`), definite.metadata.get(`${LABEL}Policy-Id`));
  assert.equal(new TextDecoder().decode(streamed.embedded[0]!.bytes), "same");
});

test("a constructed content OCTET STRING is joined, as BER allows for a long one", async () => {
  const content = indefinite(0x24, octets(new TextEncoder().encode("one ")), octets(new TextEncoder().encode("two")));
  const body = indefinite(0x30, integer(1n), content);
  const data = indefinite(0x30, oid("1.2.840.113549.1.9.16.1.31"), indefinite(0xa0, body));
  const { embedded } = await parseDirect(data);
  assert.equal(new TextDecoder().decode(embedded[0]!.bytes), "one two");
});

test("an envelope without evidence still gives its content, without time stamps", async () => {
  const { metadata, embedded } = await parseDirect(envelope({ content: new TextEncoder().encode("bare") }));
  assert.deepEqual(keysWithLabel(metadata), []);
  assert.equal(embedded.length, 1);
});

test("an envelope without content gives time stamps and no embedded document", async () => {
  const { metadata, embedded } = await parseDirect(envelope({ tokens: [tstInfo()] }));
  assert.equal(metadata.get(`${LABEL}File-Parsed`), "true");
  assert.equal(embedded.length, 0);
});

test("a token that cannot be read costs every token, and the content is still read (Tika's choice)", async () => {
  const broken = seq(integer(1n)); // a TSTInfo without its fields
  const data = envelope({ content: new TextEncoder().encode("kept"), tokens: [tstInfo(), broken] });
  const { metadata, embedded } = await parseDirect(data);
  assert.deepEqual(keysWithLabel(metadata), []);
  assert.equal(new TextDecoder().decode(embedded[0]!.bytes), "kept");
});

// ---- an envelope cut short ----

test("an envelope cut inside its content gives the bytes before the cut, and says so on the embedded document", async () => {
  const full = file("Test4.pdf.tsd");
  const cut = full.subarray(0, 4000);
  const { embedded } = await parseDirect(cut);
  assert.equal(embedded.length, 1);
  assert.ok(embedded[0]!.bytes.length > 0 && embedded[0]!.bytes.length < 4000);
  assert.match(embedded[0]!.metadata.get("tk:exception:embedded-stream-exception") ?? "", /cut short/);
});

test("every prefix of Test1.txt.tsd parses, with a prefix of the content or as an empty non-envelope", async () => {
  const full = file("Test1.txt.tsd");
  const whole = (await parseDirect(full)).embedded[0]!.bytes;
  for (let length = 0; length <= full.length; length++) {
    const { embedded } = await parseDirect(full.subarray(0, length));
    for (const part of embedded) {
      assert.deepEqual(part.bytes, whole.subarray(0, part.bytes.length), `prefix of ${length} bytes`);
    }
  }
});

test("prefixes of Test3.docx.tsd parse", async () => {
  const full = file("Test3.docx.tsd");
  for (let length = 0; length <= full.length; length += 127) await parseDirect(full.subarray(0, length));
});

// ---- hostile input ----

test("a content length of four gigabytes is not allocated: the bytes there are read, the cut recorded", { timeout: 30_000 }, async () => {
  const body = concat(Uint8Array.of(0x04, 0x84, 0xff, 0xff, 0xff, 0xff), new TextEncoder().encode("only ten b"));
  const data = indefinite(0x30, oid("1.2.840.113549.1.9.16.1.31"), indefinite(0xa0, indefinite(0x30, integer(1n), body)));
  const { embedded } = await parseDirect(data);
  // The three indefinite-length wrappers around the content have their end-of-contents octets in the data, and a content
  // that says it runs past the end of the data runs over those too.
  const text = new TextDecoder().decode(embedded[0]!.bytes);
  assert.ok(text.startsWith("only ten b") && text.length <= "only ten b".length + 6, JSON.stringify(text));
  assert.match(embedded[0]!.metadata.get("tk:exception:embedded-stream-exception") ?? "", /cut short/);
});

test("a hundred thousand nested indefinite lengths are refused as nesting, not recursed into", { timeout: 30_000 }, async () => {
  const depth = 100_000;
  const nest = new Uint8Array(depth * 2);
  for (let index = 0; index < depth; index++) {
    nest[index * 2] = 0x30;
    nest[index * 2 + 1] = 0x80;
  }
  const data = indefinite(0x30, oid("1.2.840.113549.1.9.16.1.31"), indefinite(0xa0, indefinite(0x30, integer(1n), nest)));
  const { metadata, embedded } = await parseDirect(data);
  assert.deepEqual(keysWithLabel(metadata), []);
  assert.equal(embedded.length, 0);
});

test("half a million empty content segments give an empty content in one pass", { timeout: 30_000 }, async () => {
  const count = 500_000;
  const segments = new Uint8Array(count * 2);
  for (let index = 0; index < count; index++) segments[index * 2] = 0x04;
  const content = concat(Uint8Array.of(0x24, 0x80), segments, Uint8Array.of(0, 0));
  const data = indefinite(0x30, oid("1.2.840.113549.1.9.16.1.31"), indefinite(0xa0, indefinite(0x30, integer(1n), content)));
  const { embedded } = await parseDirect(data);
  assert.equal(embedded[0]!.bytes.length, 0);
});

test("a thousand tokens are read and a thousand and one are a limit, not a hundred thousand metadata values", async () => {
  const token = tstInfo();
  const accepted = await parseDirect(envelope({ content: new Uint8Array(1), tokens: Array.from({ length: 1000 }, () => token) }));
  assert.equal(accepted.metadata.get("Time-Stamp-n.1000 - File-Parsed"), "true");
  await assert.rejects(
    parseDirect(envelope({ content: new Uint8Array(1), tokens: Array.from({ length: 1001 }, () => token) })),
    LimitExceededError,
  );
});

test("a TSTInfo of more than a mebibyte is not read as a time stamp", { timeout: 30_000 }, async () => {
  const huge = seq(integer(1n), tlv(0x04, new Uint8Array(1024 * 1024 + 1)));
  const { metadata, embedded } = await parseDirect(envelope({ content: new Uint8Array(1), tokens: [huge] }));
  assert.deepEqual(keysWithLabel(metadata), []);
  assert.equal(embedded.length, 1);
});

test("text, an empty file and a ContentInfo of another type are an empty success, as Tika's TSDParser", async () => {
  for (const input of [
    new TextEncoder().encode("this is not a time stamped data envelope"),
    new Uint8Array(0),
    seq(oid("1.2.840.113549.1.7.2"), explicit(0, seq(integer(1n)))),
  ]) {
    const { metadata, embedded } = await parseDirect(input);
    assert.deepEqual(keysWithLabel(metadata), []);
    assert.equal(embedded.length, 0);
  }
});

// ---- GeneralName text ----

const nameText = (element: Uint8Array): string => {
  const ber = new Ber(element);
  return generalNameToString(ber, ber.element(0, element.length), element.length);
};

test("a GeneralName is its tag number and its value", () => {
  assert.equal(nameText(text(0x82, "example.org")), "2: example.org");
  assert.equal(nameText(text(0x81, "tsa@example.org")), "1: tsa@example.org");
  assert.equal(nameText(text(0x86, "http://example.org/tsa")), "6: http://example.org/tsa");
  assert.equal(nameText(tlv(0x88, oid("1.2.3").subarray(2))), "8: 1.2.3");
  assert.equal(nameText(tlv(0x87, Uint8Array.of(10, 0, 0, 1))), "7: #0a000001");
});

test("a directory name has its RDNs in encoded order, a plus sign inside an RDN, and the specials escaped", () => {
  const name = directoryName(
    [[COMMON_NAME, "a,b"], [ORGANIZATIONAL_UNIT, "x+y"]],
    [[ORGANIZATION, ' lead "q" <trail> ']],
    [["1.2.3.4", "dotted"]],
  );
  assert.equal(nameText(name), '4: CN=a\\,b+OU=x\\+y,O=\\ lead \\"q\\" \\<trail\\>\\ ,1.2.3.4=dotted');
});

test("a value that starts with a number sign is escaped, and a UniversalString is the hex of its encoding", () => {
  assert.equal(nameText(directoryName([[COMMON_NAME, "#1"]])), "4: CN=\\#1");
  const universal = explicit(4, seq(tlv(0x31, seq(oid(COMMON_NAME), tlv(0x1c, Uint8Array.of(0, 0, 0, 0x41))))));
  assert.equal(nameText(universal), "4: CN=#1c0400000041");
});

test("a GeneralName that is not context-tagged is refused", () => {
  assert.throws(() => nameText(seq()), MalformedDocumentError);
});

test("a failed embedded document puts its exception on the TSD's metadata; a limit still ends the parse", async () => {
  const run = async (failure: Error): Promise<Metadata> => {
    const context = new ParseContext();
    context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, {
      shouldParseEmbedded: () => true,
      parseEmbedded: () => Promise.reject(failure),
    });
    const metadata = new Metadata();
    const stream = await RipstreamInputStream.from(file("Test1.txt.tsd"));
    try {
      await new TsdParser().parse(stream, new BodyContentHandler(), metadata, context);
    } finally {
      await stream.close();
    }
    return metadata;
  };
  const metadata = await run(new MalformedDocumentError("content is cut short"));
  assert.deepEqual(metadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION), ["MalformedDocumentError: content is cut short"]);
  await assert.rejects(run(new LimitExceededError("too big")), LimitExceededError);
});
