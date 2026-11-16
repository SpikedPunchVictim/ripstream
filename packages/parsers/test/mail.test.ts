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
  type EmbeddedDocumentExtractor,
} from "@spikedpunch/ripstream-core";
import { MailParser, MboxParser } from "../src/index.ts";

const message = [
  "From: Ada <ada@example.com>",
  "To: Grace <grace@example.com>",
  "Subject: =?utf-8?B?SGVsbG8gTWFpbA==?=",
  "Date: Tue, 01 Jan 2024 00:00:00 +0000",
  "Message-ID: <abc@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Hello=20Email",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>HTML part</p></body></html>",
  "--b1--",
  "",
].join("\r\n");

async function parse(value: string): Promise<{
  text: string;
  metadata: Metadata;
}> {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(value));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  const context = new ParseContext();
  // These tests describe the body; the header block (on by default, as xberg writes it) has its own tests.
  context.set(CONTEXT_KEYS.EMAIL_HEADER_BLOCK, false);
  await new MailParser().parse(stream, handler, metadata, context);
  await stream.close();
  return { text: handler.toString(), metadata };
}

test("extracts multipart email text and headers", async () => {
  const result = await parse(message);
  assert.match(result.text, /Hello Email/);
  assert.match(result.text, /HTML part/);
  assert.equal(result.metadata.get("dc:title"), "Hello Mail");
  assert.equal(result.metadata.get("dc:creator"), "Ada <ada@example.com>");
  // Tika writes Message-ID as every header it has no key for: a raw header (tikajs-68os.46).
  assert.equal(result.metadata.get("message:raw-header:Message-ID"), "<abc@example.com>");
});

test("extracts nested message/rfc822 content", async () => {
  const nested = [
    "Subject: Outer",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    "Content-Type: message/rfc822",
    "",
    "Subject: Inner",
    "Content-Type: text/plain",
    "",
    "Nested body",
    "--outer--",
    "",
  ].join("\r\n");
  const result = await parse(nested);
  assert.match(result.text, /Nested body/);
  assert.equal(result.metadata.get("dc:title"), "Outer");
});

test("decodes base64 text parts with charset", async () => {
  const encoded = Buffer.from("Café body", "utf-8").toString("base64");
  const value = [
    "Subject: Base64",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encoded,
  ].join("\r\n");
  const result = await parse(value);
  assert.match(result.text, /Café body/);
});

test("classifies S/MIME and PGP/MIME messages", async () => {
  const signed = [
    "Subject: Signed",
    'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary="s"',
    "",
    "--s",
    "Content-Type: text/plain",
    "",
    "Signed body",
    "--s--",
    "",
  ].join("\r\n");
  const result = await parse(signed);
  assert.equal(result.metadata.get("Message:Security"), "smime");
  assert.match(result.text, /Signed body/);
});

test("rejects pathologically nested multipart with LimitExceededError", async () => {
  const depth = 300;
  let body = "Content-Type: text/plain\r\n\r\nleaf";
  for (let level = 0; level < depth; level++) {
    body = [
      `Content-Type: multipart/mixed; boundary="b${level}"`,
      "",
      `--b${level}`,
      body,
      `--b${level}--`,
      "",
    ].join("\r\n");
  }
  await assert.rejects(
    parse(`Subject: deep\r\n${body}`),
    (error: Error) => error.name === "LimitExceededError",
  );
});

// Tika's MailContentHandler: `inline` is INLINE, `attachment` is ATTACHMENT, and a part with no disposition falls back to
// ATTACHMENT in handleEmbedded.
async function embeddedTypes(parts: readonly string[]): Promise<Array<string | null>> {
  const lines = ["Subject: parts", 'Content-Type: multipart/mixed; boundary="b"', ""];
  for (const part of parts) lines.push("--b", part, "");
  lines.push("--b--", "");
  const resources = new EmbeddedDocumentBytesHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMAIL_HEADER_BLOCK, false);
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(lines.join("\r\n")));
  await new MailParser().parse(stream, new BodyContentHandler(), new Metadata(), context);
  await stream.close();
  return resources.resources.map((resource) => resource.metadata.get("tk:embedded-resource-type"));
}

const pdf = (disposition: string[]): string =>
  ["Content-Type: application/pdf", ...disposition, "Content-Transfer-Encoding: base64", "", "AAAA"].join("\r\n");

test("a mail part with Content-Disposition: attachment is an ATTACHMENT", async () => {
  assert.deepEqual(await embeddedTypes([pdf(['Content-Disposition: attachment; filename="a.pdf"'])]), ["ATTACHMENT"]);
});

test("a mail part with Content-Disposition: inline is INLINE, whatever the case", async () => {
  assert.deepEqual(
    await embeddedTypes([pdf(['Content-Disposition: inline; filename="a.pdf"']), pdf(["Content-Disposition: INLINE"])]),
    ["ATTACHMENT", "ATTACHMENT"],
  );
});

test("a mail part with no Content-Disposition, or one that is neither, is an ATTACHMENT", async () => {
  assert.deepEqual(await embeddedTypes([pdf([]), pdf(["Content-Disposition: form-data"])]), ["ATTACHMENT", "ATTACHMENT"]);
});

/*
 * Mutation-hardening of the part, body and transfer-encoding rules of MailParser. Where a test says "port" it pins what this code
 * does, which is written from memory of mime4j and is not compared with a real Tika.
 */

const crlf = (...lines: string[]): string => lines.join("\r\n");

const mixed = (...parts: string[]): string => {
  const lines = ["Subject: parts", 'Content-Type: multipart/mixed; boundary="b"', ""];
  for (const part of parts) lines.push("--b", part, "");
  lines.push("--b--", "");
  return lines.join("\r\n");
};

const textPart = (body: string, ...headers: string[]): string => [...headers, "", body].join("\r\n");

async function parseParts(
  text: string,
  context = new ParseContext(),
): Promise<{ text: string; parts: Metadata[] }> {
  const resources = new EmbeddedDocumentBytesHandler();
  context.set(CONTEXT_KEYS.EMAIL_HEADER_BLOCK, false);
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(text));
  const handler = new BodyContentHandler();
  try {
    await new MailParser().parse(stream, handler, new Metadata(), context);
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), parts: resources.resources.map((resource) => resource.metadata) };
}

test("a header block of 100000 bytes is read by default and one byte more is a LimitExceededError", async () => {
  const prefix = "Subject: s\r\nX-Pad: ";
  const block = (length: number): string => `${prefix}${"a".repeat(length - prefix.length)}\r\n\r\nbody`;
  assert.equal((await parse(block(100_000))).metadata.get("dc:title"), "s");
  await assert.rejects(parse(block(100_001)), LimitExceededError);
});

test("maxHeaderBytes: 1 is accepted, and a fraction, NaN or a negative number is a RangeError", () => {
  assert.doesNotThrow(() => new MailParser({ maxHeaderBytes: 1 }));
  for (const bad of [1.5, Number.NaN, -1]) assert.throws(() => new MailParser({ maxHeaderBytes: bad }), RangeError);
});

test("the header block of a nested message/rfc822 is capped with the same limit", async () => {
  const nested = crlf("Subject: outer", "Content-Type: message/rfc822", "", `X-Long: ${"v".repeat(200)}`, "", "body", "");
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(nested));
  try {
    await assert.rejects(
      new MailParser({ maxHeaderBytes: 100 }).parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
      LimitExceededError,
    );
  } finally {
    await stream.close();
  }
});

test("an over-long block whose first maxHeaderBytes are not headers is 'no headers', not a limit", async () => {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("xxxxxxxxxxxxxxxxxxxx\r\nSubject: s\r\n\r\nbody"));
  try {
    await assert.rejects(
      new MailParser({ maxHeaderBytes: 10 }).parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
      MalformedDocumentError,
    );
  } finally {
    await stream.close();
  }
});

test("a message that starts with a blank line has no headers", async () => {
  await assert.rejects(parse("\n\nSubject: s\n\nbody"), MalformedDocumentError);
});

test("headers in UTF-8 bytes are decoded as UTF-8", async () => {
  assert.equal((await parse("Subject: Café\r\n\r\nbody")).metadata.get("dc:title"), "Café");
});

test("a body after an LF header end is not cut by a CRLF blank line inside the body, and the other way round", async () => {
  assert.equal((await parse("A: b\n\nbody\r\n\r\nmore")).text, "body\n\nmore");
  assert.equal((await parse("A: b\r\n\r\nbody\n\nmore")).text, "body\n\nmore");
});

test("the body starts right after the blank line, with no line break of its own", async () => {
  assert.equal((await parse("A: b\r\n\r\nx")).text, "x");
  assert.equal((await parse("A: b\n\nx")).text, "x");
});

test("a part with no headers, its blank line right after the delimiter, is a text/plain part with its body (RFC 2046 5.1.1)", async () => {
  const crlfMessage = crlf("Subject: s", 'Content-Type: multipart/mixed; boundary="b"', "", "--b", "", "headerless body", "--b--", "");
  assert.equal((await parse(crlfMessage)).text, "headerless body");
  const lfMessage = 'Subject: s\nContent-Type: multipart/mixed; boundary="b"\n\n--b\n\nheaderless lf\n--b--\n';
  assert.equal((await parse(lfMessage)).text, "headerless lf");
});

test("a part that starts with a CR that is not a line break is not a part with no headers", async () => {
  const message = 'Subject: s\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\r\nContent-Type: text/plain\r\n\r\nx\r\n--b--\r\n';
  assert.equal((await parse(message)).text, "x");
});

test("the closing delimiter ends the multipart: its epilogue is not text", async () => {
  assert.doesNotMatch((await parse(`${mixed(textPart("one", "Content-Type: text/plain"))}X-Epilogue: y\r\n\r\nepilogue text`)).text, /epilogue/);
});

test("a delimiter followed by one dash is not the closing delimiter", async () => {
  const message = mixed(textPart("one", "Content-Type: text/plain")).replace("--b--", "--b-x\r\nContent-Type: text/plain\r\n\r\ntwo\r\n--b--");
  assert.match((await parse(message)).text, /two/);
});

test("a multipart with no closing delimiter keeps the last byte of its last part", async () => {
  const message = 'Subject: s\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nlast';
  assert.equal((await parse(message)).text, "last");
});

test("an empty segment between two delimiters is not a part", async () => {
  const alternative = crlf(
    "Subject: s",
    'Content-Type: multipart/alternative; boundary="b"',
    "",
    "--b",
    "--b",
    "Content-Type: text/plain",
    "",
    "real part",
    "--b--",
    "",
  );
  assert.match((await parse(alternative)).text, /real part/);
});

test("a multipart with no boundary has no parts and is not an error", async () => {
  const { text } = await parse("Subject: s\r\nContent-Type: multipart/mixed\r\n\r\nbody");
  assert.equal(text, "");
});

test("a boundary of 70 characters is read and one of 71 is a MalformedDocumentError (RFC 2046 5.1.1)", async () => {
  const withBoundary = (boundary: string): string =>
    crlf("Subject: s", `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain", "", "in part", `--${boundary}--`, "");
  assert.match((await parse(withBoundary("b".repeat(70)))).text, /in part/);
  await assert.rejects(parse(withBoundary("b".repeat(71))), MalformedDocumentError);
});

test("a type that only starts with 'multipart' is not a multipart: its bytes are the body", async () => {
  const { text } = await parse(crlf("Subject: s", 'Content-Type: multipartial/x; boundary="b"', "", "--b", "", "body", "--b--", ""));
  assert.match(text, /body/);
});

test("multipart/appledouble is not an alternative: every part is read", async () => {
  const message = crlf(
    "Subject: s",
    'Content-Type: multipart/appledouble; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "first part",
    "--b",
    "Content-Type: text/plain",
    "",
    "second part",
    "--b--",
    "",
  );
  const { text } = await parse(message);
  assert.match(text, /first part/);
  assert.match(text, /second part/);
});

test("a multipart/alternative with no parts is not an error", async () => {
  const { text } = await parse(crlf("Subject: s", 'Content-Type: multipart/alternative; boundary="b"', "", "--b--", ""));
  assert.equal(text, "");
});

const alternative = (...parts: string[]): string => {
  const lines = ["Subject: alt", 'Content-Type: multipart/alternative; boundary="b"', ""];
  for (const part of parts) lines.push("--b", part, "");
  lines.push("--b--", "");
  return lines.join("\r\n");
};
const rtfPart = textPart("{\\rtf1 rtf body}", "Content-Type: application/rtf");

test("multipart/alternative: application/rtf (2) beats text/plain (1)", async () => {
  const { text, parts } = await parseParts(alternative(textPart("plain body", "Content-Type: text/plain"), rtfPart));
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.get("Content-Type"), "application/rtf");
  assert.doesNotMatch(text, /plain body/);
});

test("multipart/alternative: text/html (3) beats application/rtf (2), whichever comes first", async () => {
  const html = textPart("<p>html body</p>", "Content-Type: text/html");
  for (const order of [[rtfPart, html], [html, rtfPart]]) {
    const { text, parts } = await parseParts(alternative(...order));
    assert.equal(parts.length, 0);
    assert.match(text, /html body/);
  }
});

test("multipart/alternative: a part of another type (4) beats text/html", async () => {
  const { text, parts } = await parseParts(alternative(textPart("<p>html body</p>", "Content-Type: text/html"), textPart("AAAA", "Content-Type: application/pdf", "Content-Transfer-Encoding: base64")));
  assert.equal(parts.length, 1);
  assert.doesNotMatch(text, /html body/);
});

test("a part is read at the depth Content-Type's nesting allows: one more level than maxNodeDepth is a LimitExceededError", async () => {
  const nest = (levels: number): string => {
    let body = "Content-Type: text/plain\r\n\r\nleaf";
    for (let level = 0; level < levels; level++) {
      body = [`Content-Type: multipart/mixed; boundary="b${level}"`, "", `--b${level}`, body, `--b${level}--`, ""].join("\r\n");
    }
    return `Subject: deep\r\n${body}`;
  };
  const parseAt = (levels: number, maxNodeDepth: number): Promise<{ text: string }> =>
    parseParts(nest(levels), new ParseContext({ limits: { maxNodeDepth } }));
  assert.match((await parseAt(3, 3)).text, /leaf/);
  await assert.rejects(parseAt(3, 2), LimitExceededError);
});

test("the parts of a nested message/rfc822 are told the multipart the nested message is in, and are named for their depth (port)", async () => {
  const nested = crlf(
    "Subject: outer",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    "Content-Type: message/rfc822",
    "",
    "Subject: inner",
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "AAAA",
    "--outer--",
    "",
  );
  const { parts } = await parseParts(nested);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.get("multipart:subtype"), "mixed");
  assert.equal(parts[0]!.get("multipart:boundary"), "outer");
  assert.equal(parts[0]!.get("tk:resource-name"), "nested_message_0.eml");
  assert.equal(parts[0]!.get("dc:title"), null);
});

test("a message/rfc822 part with an empty header block is not read (port)", async () => {
  const { text } = await parse(mixed(textPart("\r\n\r\njust text, no headers at all", "Content-Type: message/rfc822")));
  assert.doesNotMatch(text, /just text/);
});

test("an empty Content-Type is text/plain", async () => {
  assert.equal((await parse("Subject: s\r\nContent-Type: ;\r\n\r\nsemi")).text, "semi");
});

test("a text part with no charset is read as UTF-8 (port)", async () => {
  assert.equal((await parse("Subject: s\r\nContent-Type: text/plain\r\n\r\ncafé")).text, "café");
});

test("a part of charset us-ascii or ascii is read as UTF-8, and an unknown charset as UTF-8 (port)", async () => {
  for (const charset of ["us-ascii", "ASCII", "x-no-such-charset"]) {
    assert.equal((await parse(`Subject: s\r\nContent-Type: text/plain; charset=${charset}\r\n\r\ncafé`)).text, "café", charset);
  }
});

test("a charset of iso-8859-1 or latin1 reads bytes above 0x7f as windows-1252", async () => {
  const bytes = Uint8Array.from([...new TextEncoder().encode("Subject: s\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Transfer-Encoding: base64\r\n\r\n"), ...new TextEncoder().encode("g5k=")]);
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMAIL_HEADER_BLOCK, false);
  await new MailParser().parse(stream, handler, new Metadata(), context);
  await stream.close();
  assert.equal(handler.toString(), "\u0192\u2122");
});

// Tika 4.2.0 (PUT /tika/text, filename a.eml, tikajs-w7xw): a text part's label is a hint the bytes must agree with. Valid
// non-ASCII UTF-8 under a latin1 label is UTF-8; lone high bytes under a UTF-8 label fall back to the bytes' own charset.
test("a text part's charset label gives way to what its bytes are", async () => {
  assert.equal((await parse("Subject: s\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\ncafé")).text, "café");
  const latin = Uint8Array.from([
    ...new TextEncoder().encode("Subject: s\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\ncaf"),
    0xe9,
    ...new TextEncoder().encode(" au lait et du pain"),
  ]);
  const stream = await RipstreamInputStream.from(latin);
  const handler = new BodyContentHandler();
  await new MailParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /caf\u00e9 au lait/);
});

test("the first Content-Type header is the entity's (port)", async () => {
  assert.equal((await parse("Subject: s\r\nContent-Type: text/plain\r\nContent-Type: text/html\r\n\r\n<b>x</b>")).text, "<b>x</b>");
});

test("quoted-printable: a soft line break is removed whether it is CRLF or LF, and =xx takes either case of hex", async () => {
  const qp = (body: string, eol: string): Promise<{ text: string }> =>
    parse(["Subject: s", "Content-Type: text/plain", "Content-Transfer-Encoding: quoted-printable", "", body].join(eol));
  assert.equal((await qp("long=\r\nline", "\r\n")).text, "longline");
  assert.equal((await qp("long=\nline", "\n")).text, "longline");
  assert.equal((await qp("=4f=4F=c3=A9", "\r\n")).text, "OOé");
});

test("quoted-printable: an = that is not followed by two hex digits is kept", async () => {
  const { text } = await parse("Subject: s\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\na=4Zb=");
  assert.equal(text, "a=4Zb=");
});

test("base64 stops at the first padding character", async () => {
  const { text } = await parse("Subject: s\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\nQQ==\r\nQUI=");
  assert.equal(text, "A");
});

test("Message:Security is smime, pgp or unknown-binary by the top-level type, whatever its case", async () => {
  const security = async (headers: string[]): Promise<string | null> => {
    const metadata = new Metadata();
    const stream = await RipstreamInputStream.from(new TextEncoder().encode([...headers, "", "body"].join("\r\n")));
    const context = new ParseContext();
    context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, new EmbeddedDocumentBytesHandler());
    await new MailParser().parse(stream, new BodyContentHandler(), metadata, context);
    await stream.close();
    return metadata.get("Message:Security");
  };
  assert.equal(await security(["Subject: s", "Content-Type: application/pkcs7-mime; smime-type=enveloped-data"]), "smime");
  assert.equal(await security(["Subject: s", "Content-Type: Multipart/Signed; boundary=b"]), "smime");
  assert.equal(await security(["Subject: s", "Content-Type: multipart/encrypted; boundary=b"]), "pgp");
  assert.equal(await security(["Subject: s", "Content-Type: application/pgp-encrypted"]), "pgp");
  assert.equal(await security(["Subject: s", "Content-Type: Application/Octet-Stream", "Content-Transfer-Encoding: BASE64"]), "unknown-binary");
  assert.equal(await security(["Subject: s", "Content-Type: application/octet-stream"]), null);
  assert.equal(await security(["Subject: s", "Content-Type: text/plain", "Content-Transfer-Encoding: base64"]), null);
});

test("an embedded part is named by its Content-Type name, else its Content-Disposition filename, else part-<depth>", async () => {
  const pdfPart = (...headers: string[]): string => textPart("AAAA", "Content-Type: application/pdf", ...headers);
  const { parts } = await parseParts(
    mixed(
      textPart("AAAA", 'Content-Type: application/pdf; name="from-type.pdf"'),
      pdfPart('Content-Disposition: attachment; filename="from-disposition.pdf"'),
      textPart("AAAA", 'Content-Type: application/pdf; name="type-wins.pdf"', 'Content-Disposition: attachment; filename="loses.pdf"'),
      pdfPart(),
    ),
  );
  assert.deepEqual(
    parts.map((part) => part.get("tk:resource-name")),
    ["from-type.pdf", "from-disposition.pdf", "loses.pdf", "attachment_3"],
  );
});

test("an embedded part has its Content-Type, and its Subject decoded as dc:title", async () => {
  const { parts } = await parseParts(mixed(textPart("AAAA", "Content-Type: application/pdf", "Subject: =?utf-8?B?Q2Fmw6k=?=")));
  assert.equal(parts[0]!.get("Content-Type"), "application/pdf");
  assert.equal(parts[0]!.get("dc:title"), null);
});

test("without an extractor the attachment is listed but not extracted as a record", async () => {
  const { text } = await parse(mixed(textPart("AAAA", "Content-Type: application/pdf")));
  assert.equal(text, "Attachments:\n\n  unnamed (6B)");
});

/** Parses one embedded part whose extractor throws `error`; returns what the extractor was handed, and the parse's outcome. */
async function parseWithThrowingExtractor(error: unknown, context = new ParseContext()): Promise<{ handed: Metadata; outcome: unknown }> {
  let handed = new Metadata();
  const extractor: EmbeddedDocumentExtractor = {
    shouldParseEmbedded: () => true,
    parseEmbedded: async (_stream, _handler, metadata) => {
      handed = metadata;
      throw error;
    },
  };
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(mixed(textPart("AAAA", "Content-Type: application/pdf"))));
  let outcome: unknown = "parsed";
  try {
    await new MailParser().parse(stream, new BodyContentHandler(), new Metadata(), context);
  } catch (thrown) {
    outcome = thrown;
  } finally {
    await stream.close();
  }
  return { handed, outcome };
}

test("an embedded part that fails with an ordinary error is recorded as tk:exception:embedded-exception, and the message goes on", async () => {
  const { handed, outcome } = await parseWithThrowingExtractor(new TypeError("broken part"));
  assert.equal(outcome, "parsed");
  assert.equal(handed.get("tk:exception:embedded-exception"), "TypeError: broken part");
});

test("an embedded part that throws something that is not an Error is recorded as its string", async () => {
  const { handed } = await parseWithThrowingExtractor("plain string");
  assert.equal(handed.get("tk:exception:embedded-exception"), "plain string");
});

test("LimitExceededError, ParseTimeoutError and AbortError from an embedded part end the parse", async () => {
  for (const error of [new LimitExceededError("too much"), new ParseTimeoutError(), new AbortError()]) {
    assert.equal((await parseWithThrowingExtractor(error)).outcome, error);
  }
});

test("any error from an embedded part ends the parse once the parse is aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const failure = new TypeError("after abort");
  assert.equal((await parseWithThrowingExtractor(failure, new ParseContext({ signal: controller.signal }))).outcome, failure);
});

test("an outer boundary that is a prefix of a nested one does not shred the nested multipart (tikajs-gz44)", async () => {
  const text = [
    "From: Ada <ada@example.com>",
    "Subject: nested",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="part"',
    "",
    "--part",
    'Content-Type: multipart/alternative; boundary="part_alt"',
    "",
    "--part_alt",
    "Content-Type: text/plain",
    "",
    "PLAIN BODY",
    "--part_alt",
    "Content-Type: text/html",
    "",
    "<p>HTML BODY</p>",
    "--part_alt--",
    "--part",
    "Content-Type: text/plain",
    "",
    "SECOND PART",
    "--part--",
    "",
  ].join("\r\n");
  const result = await parse(text);
  assert.doesNotMatch(result.text, /PLAIN BODY/, "only the best alternative is rendered");
  assert.match(result.text, /HTML BODY/);
  assert.match(result.text, /SECOND PART/);
});

test("a boundary string inside a text line is not a delimiter (tikajs-gz44)", async () => {
  const text = [
    "From: Ada <ada@example.com>",
    "Subject: inline",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain",
    "",
    "see the marker --b1 here, not a delimiter",
    "--b1--",
    "",
  ].join("\r\n");
  const result = await parse(text);
  assert.match(result.text, /see the marker --b1 here, not a delimiter/);
});

// ParseOptions.emailHeaders (tikajs-5qkk) reaches the parser as a context key; declarative cases are in fixtures/mail/email-headers-*.json.
async function parseWithHeaders(parser: { parse: MailParser["parse"] }, value: string, emailHeaders: boolean): Promise<string> {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(value));
  const handler = new BodyContentHandler();
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.EMAIL_HEADER_BLOCK, emailHeaders);
  await parser.parse(stream, handler, new Metadata(), ctx);
  await stream.close();
  return handler.toString();
}

test("the header block is written by default and false leaves it out", async () => {
  const message = "Subject: S\nFrom: a@example.com\n\nBody\n";
  assert.equal(await parseWithHeaders(new MailParser(), message, false), "Body");
  const ctx = new ParseContext();
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(message));
  const handler = new BodyContentHandler();
  await new MailParser().parse(stream, handler, new Metadata(), ctx);
  await stream.close();
  assert.equal(handler.toString(), "Subject: S\nFrom: a@example.com\n\nBody");
});

test("a header that occurs twice: the last Subject and Date, every From, To, CC and BCC", async () => {
  const text = await parseWithHeaders(
    new MailParser(),
    [
      "Subject: first", "Subject: second",
      "From: a@example.com", "From: b@example.com",
      "To: c@example.com", "To: d@example.com",
      "Date: Mon, 01 Jan 2024 00:00:00 +0000", "Date: Tue, 02 Jan 2024 00:00:00 +0000",
      "", "Body", "",
    ].join("\n"),
    true,
  );
  assert.equal(
    text,
    "Subject: second\nFrom: a@example.com\nTo: c@example.com, d@example.com\nDate: Tue, 02 Jan 2024 00:00:00 +0000\n\nBody",
  );
});

test("a header with nothing in it has no line, and a message with no header to show has no block", async () => {
  assert.equal(await parseWithHeaders(new MailParser(), "Subject:\nTo:   \nX-Other: 1\n\nBody\n", true), "Body");
});

test("an mbox writes each message's own header block, as paragraphs like the rest of the message (the mbox parser drops blank lines)", async () => {
  const mbox = [
    "From a@example.com Tue Oct  1 12:34:56 2024", "From: a@example.com", "Subject: One", "", "First body.", "",
    "From b@example.com Tue Oct  1 13:00:00 2024", "From: b@example.com", "Subject: Two", "", "Second body.", "",
  ].join("\n");
  const text = await parseWithHeaders(new MboxParser(), mbox, true);
  assert.match(text, /Subject: One\nFrom: a@example.com\nFirst body\./);
  assert.match(text, /Subject: Two\nFrom: b@example.com\nSecond body\./);
  assert.doesNotMatch(await parseWithHeaders(new MboxParser(), mbox, false), /Subject:/);
});

// Tika 4.2.0 (PUT /rmeta/body, filename a.eml, tikajs-w12u): mime4j decodes every hard line break of a quoted-printable body
// to CRLF, drops the white space before it, and a soft break is removed.
test("quoted-printable: a hard line break is a CRLF, and the spaces before it are dropped", async () => {
  const qp = (body: string): Promise<{ text: string }> =>
    parse(`Subject: s\nContent-Type: text/plain\nContent-Transfer-Encoding: quoted-printable\n\n${body}`);
  assert.equal((await qp("a\nb\n\nc")).text, "a\nb\n\nc");
  assert.equal((await qp("abc   \ndef=20\nghi")).text, "abc\ndef \nghi");
  assert.equal((await qp("a=0D\nb")).text, "a\n\nb");
});

// A multipart part that is not an alternative is wrapped in two divs by Tika, and the line break before a delimiter is the
// delimiter's: a plain text part ends with its text, one paragraph break, and the two divs' line breaks.
test("text parts of a multipart/mixed are each wrapped in two divs; the line break before a delimiter is not text", async () => {
  const message = 'Subject: s\nContent-Type: multipart/mixed; boundary="b"\n\n--b\nContent-Type: text/plain\n\nfirst\n\n--b\nContent-Type: text/plain\n\nsecond\n--b--\n';
  assert.equal((await parse(message)).text, "first\n\nsecond");
});
