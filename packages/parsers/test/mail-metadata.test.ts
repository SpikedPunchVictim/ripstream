import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  LimitExceededError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { MailParser } from "../src/index.ts";
import { parseAddressList, splitPersonAndEmail } from "../src/mail-address.ts";
import { parseStructured } from "../src/mail-structured.ts";

/*
 * The metadata and the multipart/alternative choice of Tika's RFC822Parser and MailContentHandler (tika-parser-mail-module),
 * for what a fixture cannot say: values with more than one entry, options, limits, and what an embedded part is told about the
 * multipart around it. The single-valued results from Tika's own test files are the fixtures in fixtures/mail/. Read from Tika
 * source, not run against a Tika; mime4j, which Tika builds on, is not in the Tika tree, so how it reads an address is
 * written from memory and marked below.
 */

const encoder = new TextEncoder();

async function parse(
  text: string,
  options: ConstructorParameters<typeof MailParser>[0] = {},
): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(encoder.encode(text));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    const context = new ParseContext();
    context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, new EmbeddedDocumentBytesHandler());
    await new MailParser(options).parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

const crlf = (...lines: string[]): string => lines.join("\r\n");

test("RFC822ParserTest.testSomeMissingHeaders: a From and a To of bare words are one entry each, in order", async () => {
  const { metadata } = await parse("From: xyz, abc\nSent: Monday, May 03, 2010 4:21 PM\nTo: abc, def\nSubject: abcd\n\nfoo:\n\nbar biz bat\n");
  assert.deepEqual(metadata.getAll("dc:creator"), ["xyz", "abc"]);
  assert.deepEqual(metadata.getAll("message:from"), ["xyz", "abc"]);
  assert.deepEqual(metadata.getAll("message:to"), ["abc", "def"]);
  assert.equal(metadata.get("dc:title"), "abcd");
  assert.equal(metadata.get("message:raw-header:Sent"), "Monday, May 03, 2010 4:21 PM");
});

test("a comma inside a quoted display name does not split the address list", async () => {
  const { metadata } = await parse('From: a@example.com\nTo: "Venabili, Dors" <dors@example.com>, Hari <hari@example.com>\nSubject: s\n\nbody\n');
  assert.deepEqual(metadata.getAll("message:to"), ["Venabili, Dors <dors@example.com>", "Hari <hari@example.com>"]);
});

test("Cc and Bcc are written, as message:cc and message:bcc", async () => {
  const { metadata } = await parse("From: a@example.com\nCc: B <b@example.com>\nBCC: c@example.com\nSubject: s\n\nbody\n");
  assert.deepEqual(metadata.getAll("message:cc"), ["B <b@example.com>"]);
  assert.deepEqual(metadata.getAll("message:bcc"), ["c@example.com"]);
});

test("a To that is not an address list is split at its commas (MailContentHandler.processAddressList's fallback)", async () => {
  const { metadata } = await parse('From: a@example.com\nTo: "unfinished <x@example.com>, plain\nSubject: s\n\nbody\n');
  assert.deepEqual(metadata.getAll("message:to"), ['"unfinished <x@example.com>', "plain"]);
});

test("RFC822ParserTest.testMultipleSubjects: of two Subject headers the last is the title", async () => {
  const { metadata } = await parse("From: Shawn Jones [chiroshawn@yahoo.com]\nSubject: 2006N-3502\nSubject: I Urge You to Require Notice of Mercury");
  assert.equal(metadata.get("dc:title"), "I Urge You to Require Notice of Mercury");
});

test("a header that appears more than once is a raw header with each value", async () => {
  const { metadata } = await parse("From: a@example.com\nReceived: first\nReceived: second\nSubject: s\n\nbody\n");
  assert.deepEqual(metadata.getAll("message:raw-header:Received"), ["first", "second"]);
});

test("the headers of a part are not the message's: only the first block is read", async () => {
  const { metadata } = await parse(
    crlf(
      "From: a@example.com",
      "Subject: outer",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "X-Part-Only: yes",
      "Subject: inner",
      "",
      "body",
      "--b--",
      "",
    ),
  );
  assert.equal(metadata.get("dc:title"), "outer");
  assert.equal(metadata.get("message:raw-header:X-Part-Only"), null);
});

const ALTERNATIVE = crlf(
  "From: a@example.com",
  "Subject: alt",
  'Content-Type: multipart/alternative; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "plain version",
  "--b",
  "Content-Type: text/html",
  "",
  "<html><body><p>html version</p></body></html>",
  "--b--",
  "",
);

test("multipart/alternative: only the best part is the body, and text/html beats text/plain (MailContentHandler.score)", async () => {
  const { text } = await parse(ALTERNATIVE);
  assert.match(text, /html version/);
  assert.doesNotMatch(text, /plain version/);
});

test("multipart/alternative: text/html listed first still beats text/plain, and the first of equal scores wins", async () => {
  const reversed = crlf(
    "Subject: alt",
    'Content-Type: multipart/alternative; boundary="b"',
    "",
    "--b",
    "Content-Type: text/html",
    "",
    "<p>html version</p>",
    "--b",
    "Content-Type: text/plain",
    "",
    "plain version",
    "--b",
    "Content-Type: text/html",
    "",
    "<p>second html</p>",
    "--b--",
    "",
  );
  const { text } = await parse(reversed);
  assert.match(text, /html version/);
  assert.doesNotMatch(text, /plain version|second html/);
});

test("multipart/alternative: text/plain alone is the body", async () => {
  const plainOnly = crlf("Subject: alt", 'Content-Type: multipart/alternative; boundary="b"', "", "--b", "Content-Type: text/plain", "", "only plain", "--b--", "");
  assert.match((await parse(plainOnly)).text, /only plain/);
});

test("extractAllAlternatives writes every alternative, as Tika's legacy setting does", async () => {
  const { text } = await parse(ALTERNATIVE, { extractAllAlternatives: true });
  assert.match(text, /html version/);
  assert.match(text, /plain version/);
});

test("a multipart child of a multipart/alternative scores 4 and outranks text/html; all of its parts are the body", async () => {
  const nested = crlf(
    "Subject: alt",
    'Content-Type: multipart/alternative; boundary="a"',
    "",
    "--a",
    "Content-Type: text/html",
    "",
    "<p>html version</p>",
    "--a",
    'Content-Type: multipart/mixed; boundary="m"',
    "",
    "--m",
    "Content-Type: text/plain",
    "",
    "first chunk",
    "--m",
    "Content-Type: text/plain",
    "",
    "second chunk",
    "--m--",
    "--a--",
    "",
  );
  const { text } = await parse(nested);
  assert.match(text, /first chunk/);
  assert.match(text, /second chunk/);
  assert.doesNotMatch(text, /html version/);
});

test("a multipart/alternative inside a multipart/alternative picks its best part again", async () => {
  const nested = crlf(
    "Subject: alt",
    'Content-Type: multipart/alternative; boundary="a"',
    "",
    "--a",
    'Content-Type: multipart/alternative; boundary="n"',
    "",
    "--n",
    "Content-Type: text/plain",
    "",
    "inner plain",
    "--n",
    "Content-Type: text/html",
    "",
    "<p>inner html</p>",
    "--n--",
    "--a--",
    "",
  );
  const { text } = await parse(nested);
  assert.match(text, /inner html/);
  assert.doesNotMatch(text, /inner plain/);
});

test("an embedded part is told the subtype and boundary of the multipart it is in (TIKA-2455)", async () => {
  const message = crlf(
    "Subject: parts",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    'Content-Type: multipart/alternative; boundary="inner"',
    "",
    "--inner",
    "Content-Type: text/plain",
    "",
    "plain",
    "--inner--",
    "--outer",
    'Content-Type: application/pdf; name="a.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "AAAA",
    "--outer--",
    "",
  );
  const resources = new EmbeddedDocumentBytesHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  const stream = await RipstreamInputStream.from(encoder.encode(message));
  await new MailParser().parse(stream, new BodyContentHandler(), new Metadata(), context);
  await stream.close();
  assert.equal(resources.resources.length, 1);
  assert.equal(resources.resources[0]!.metadata.get("multipart:subtype"), "mixed");
  assert.equal(resources.resources[0]!.metadata.get("multipart:boundary"), "outer");
});

test("RFC822ParserTest.testLongHeader: a header block over 100000 bytes is a LimitExceededError", async () => {
  const name = "really really really really really really long name ".repeat(2000);
  await assert.rejects(parse(`Status: 520\r\nFrom: ${name}\r\n\r\n`), LimitExceededError);
});

test("the header cap is an option, and a header block at the cap is read", async () => {
  const message = "Subject: s\r\nFrom: a@example.com\r\n\r\nbody\r\n";
  const headers = Buffer.byteLength("Subject: s\r\nFrom: a@example.com");
  assert.equal((await parse(message, { maxHeaderBytes: headers })).metadata.get("dc:title"), "s");
  await assert.rejects(parse(message, { maxHeaderBytes: headers - 1 }), LimitExceededError);
});

test("maxHeaderBytes must be a positive integer", () => {
  assert.throws(() => new MailParser({ maxHeaderBytes: 0 }), RangeError);
});

test("a part's header block is capped as well", async () => {
  const message = crlf("Subject: s", 'Content-Type: multipart/mixed; boundary="b"', "", "--b", `X-Long: ${"v".repeat(200)}`, "", "body", "--b--", "");
  await assert.rejects(parse(message, { maxHeaderBytes: 100 }), LimitExceededError);
});

/*
 * Mutation-hardening of the header folding and the address reading. The address list is mime4j's in Tika and is written here from
 * memory, so what these tests pin is what this code does, not what Tika does.
 */

test("a folded header that no key is written for keeps its line breaks in the raw header, CRLF or LF as written", async () => {
  const crlfFold = await parse("From: a@example.com\r\nX-Folded: one\r\n two\r\n\tthree\r\nSubject: s\r\n\r\nbody");
  assert.equal(crlfFold.metadata.get("message:raw-header:X-Folded"), "one\r\n two\r\n\tthree");
  const lfFold = await parse("From: a@example.com\nX-Folded: one\n two\nSubject: s\n\nbody");
  assert.equal(lfFold.metadata.get("message:raw-header:X-Folded"), "one\n two");
});

test("a continuation line that has a colon is still part of the header before it", async () => {
  const { metadata } = await parse("X-Folded: one\r\n two: not a header\r\nSubject: s\r\n\r\nbody");
  assert.equal(metadata.get("message:raw-header:X-Folded"), "one\r\n two: not a header");
  assert.equal(metadata.get("message:raw-header:two"), null);
});

test("a continuation line with no header before it is dropped", async () => {
  const { metadata } = await parse(" folded first\r\nSubject: s\r\n\r\nbody");
  assert.equal(metadata.get("dc:title"), "s");
});

test("a line that starts with a colon is not a header", async () => {
  const { metadata } = await parse(":no name\r\nSubject: s\r\n\r\nbody");
  assert.equal(metadata.get("message:raw-header:"), null);
});

test("a header name is trimmed and read in any case, and a tab after the colon is not part of the value", async () => {
  const { metadata } = await parse("SUBJECT : the title\r\nX-Tab:\tvalue\r\n\r\nbody");
  assert.equal(metadata.get("dc:title"), "the title");
  assert.equal(metadata.get("message:raw-header:X-Tab"), "value");
});

test("a folded Subject is one line, trimmed, whether it was folded with CRLF or LF", async () => {
  assert.equal((await parse("Subject: one\r\n two  \r\n\r\nbody")).metadata.get("dc:title"), "one two");
  assert.equal((await parse("Subject: one\n two\n\nbody")).metadata.get("dc:title"), "one two");
});

test("a folded Date is read", async () => {
  const { metadata } = await parse("Date: Tue, 01 Jan 2024\r\n 00:00:00 +0000\r\nSubject: s\r\n\r\nbody");
  assert.equal(metadata.get("dcterms:created"), "2024-01-01T00:00:00Z");
});

test("a Content-Type that is not type/subtype is not a raw header, and neither is one that starts with a slash", async () => {
  assert.equal((await parse("Content-Type: weird\r\nSubject: s\r\n\r\nbody")).metadata.get("message:raw-header:Content-Type"), null);
  assert.equal((await parse("Content-Type: /x\r\nSubject: s\r\n\r\nbody")).metadata.get("message:raw-header:Content-Type"), null);
});

test("a multipart Content-Type gives the subtype and boundary, and no raw header", async () => {
  const { metadata } = await parse('Content-Type: multipart/related; boundary="x y"\r\nSubject: s\r\n\r\nbody');
  assert.equal(metadata.get("multipart:subtype"), "related");
  assert.equal(metadata.get("multipart:boundary"), "x y");
  assert.equal(metadata.get("message:raw-header:Content-Type"), null);
});

test("a From that is not an address list is the text as written without its outer brackets (MailContentHandler's fallback)", async () => {
  const group = await parse("From: <a@b.example> : <d@e.example>\r\n\r\nbody");
  assert.deepEqual(group.metadata.getAll("message:from"), ["a@b.example> : <d@e.example"]);
  assert.deepEqual(group.metadata.getAll("dc:creator"), ["a@b.example> : <d@e.example"]);
  const open = await parse("From: <a@b.example\r\n\r\nbody");
  assert.deepEqual(open.metadata.getAll("message:from"), ["a@b.example"]);
  const close = await parse("From: Team: x@b.example>\r\n\r\nbody");
  assert.deepEqual(close.metadata.getAll("message:from"), ["Team: x@b.example"]);
});

test("a From that is not an address list still gives its name and address", async () => {
  const { metadata } = await parse("From: Team Name: x@b.example\r\n\r\nbody");
  assert.equal(metadata.get("message:from-email"), "x@b.example");
  assert.equal(metadata.get("message:from-name"), "Team Name:");
});

test("a From of a bare word has a name and no address, and a From of a bare address has an address and no name", async () => {
  const word = await parse("From: xyz\r\n\r\nbody");
  assert.equal(word.metadata.get("message:from-name"), "xyz");
  assert.equal(word.metadata.get("message:from-email"), null);
  const address = await parse("From: <a@b.example>\r\n\r\nbody");
  assert.equal(address.metadata.get("message:from-name"), null);
  assert.equal(address.metadata.get("message:from-email"), "a@b.example");
});

test("a recipient list that is not an address list is split at its commas from the raw text, trimmed, and an empty piece is not added", async () => {
  const { metadata } = await parse('To: "broken, one\r\n two, ,last\r\n\r\nbody');
  assert.deepEqual(metadata.getAll("message:to"), ['"broken', "one\r\n two", "last"]);
});

test("empty entries of an address list are skipped", async () => {
  const { metadata } = await parse("To: a@example.com,, b@example.com, ,\r\n\r\nbody");
  assert.deepEqual(metadata.getAll("message:to"), ["a@example.com", "b@example.com"]);
});

const mailboxes = (value: string): Array<{ name: string | null; address: string }> | null => {
  const found = parseAddressList(value);
  return found === null ? null : found.map(({ name, address }) => ({ name, address }));
};

test("parseAddressList: a mailbox with no display name has a null name; one with a name has it trimmed, unquoted and its address trimmed", () => {
  assert.deepEqual(mailboxes("<a@x.example>"), [{ name: null, address: "a@x.example" }]);
  assert.deepEqual(mailboxes("  Ann  < a@x.example >"), [{ name: "Ann", address: "a@x.example" }]);
  assert.deepEqual(mailboxes('"quoted@x.example"'), [{ name: null, address: "quoted@x.example" }]);
});

test("parseAddressList: a comma in a quoted name, in a comment or in angle brackets does not split, and a quoted pair does not end the quote", () => {
  assert.deepEqual(mailboxes('"Doe, Jo" <jo@x.example>'), [{ name: "Doe, Jo", address: "jo@x.example" }]);
  assert.deepEqual(mailboxes('"Doe \\"Jo, J" <jo@x.example>'), [{ name: 'Doe "Jo, J', address: "jo@x.example" }]);
  assert.deepEqual(mailboxes("Bob (the, boss) <b@x.example>, c@x.example"), [
    { name: "Bob", address: "b@x.example" },
    { name: null, address: "c@x.example" },
  ]);
  assert.deepEqual(mailboxes("<a,b@x.example>"), [{ name: null, address: "a,b@x.example" }]);
});

test("parseAddressList: comments nest, and a quoted pair in a comment does not close it", () => {
  assert.deepEqual(mailboxes("Bob (a (b, c), d) <b@x.example>, c@x.example"), [
    { name: "Bob", address: "b@x.example" },
    { name: null, address: "c@x.example" },
  ]);
  assert.deepEqual(mailboxes("Bob (a \\) , b) <b@x.example>"), [{ name: "Bob", address: "b@x.example" }]);
  assert.deepEqual(mailboxes('"a" (c) <x@y.example>'), [{ name: "a", address: "x@y.example" }]);
});

test("parseAddressList: a comment in a quoted name stays, and so does a < in one", () => {
  assert.deepEqual(mailboxes('"A \\"(B)\\" C" <x@y.example>'), [{ name: 'A "(B)" C', address: "x@y.example" }]);
  assert.deepEqual(mailboxes('"a<b" <x@y.example>'), [{ name: "a<b", address: "x@y.example" }]);
  assert.deepEqual(mailboxes('"a\\"<b" <x@y.example>'), [{ name: 'a"<b', address: "x@y.example" }]);
});

test("parseAddressList: a group, or an unterminated quote, comment or angle address, is not a list", () => {
  assert.equal(parseAddressList("Team: a@x.example, b@x.example;"), null);
  assert.equal(parseAddressList('"unfinished <a@x.example>'), null);
  assert.equal(parseAddressList("a@x.example (unfinished"), null);
  assert.equal(parseAddressList("Bob <a@x.example"), null);
});

test("parseAddressList: a colon inside angle brackets is part of the address", () => {
  assert.deepEqual(mailboxes("<a:b@x.example>"), [{ name: null, address: "a:b@x.example" }]);
});

test("a recipient with a name that has encoded words is decoded, and a name that is empty is the address alone", async () => {
  const { metadata } = await parse("To: =?utf-8?Q?Caf=C3=A9?= <c@x.example>, <d@x.example>\r\n\r\nbody");
  assert.deepEqual(metadata.getAll("message:to"), ["Café <c@x.example>", "d@x.example"]);
});

test("the person and address are read from the display string: the last address wins, and < > and quotes are blanks", async () => {
  const { metadata } = await parse('From: "Ann" <ann@x.example>, Bo <bo@y.example>\r\n\r\nbody');
  assert.equal(metadata.get("message:from-name"), "Bo");
  assert.equal(metadata.get("message:from-email"), "bo@y.example");
});

test("an address is a run with an @ and no < @ or white space before it, and no @ > or space after it", async () => {
  const email = async (from: string): Promise<string | null> =>
    (await parse(`From: ${from}\r\n\r\nbody`)).metadata.get("message:from-email");
  assert.equal(await email("<a@b.example>"), "a@b.example");
  assert.equal(await email("Team: a@b@c.example"), "a@b");
  assert.equal(await email("Team: x:y@b.example"), "x:y@b.example");
  assert.equal(await email("Team: a b@c.example"), "b@c.example");
  assert.equal(await email("Team: a\tb@c.example"), "b@c.example");
  assert.equal(await email("Team: a@"), null);
  assert.equal(await email("Team: @a.example"), null);
});

test("parseAddressList: a backslash outside quotes is kept in a name, also after a quote has closed", () => {
  assert.deepEqual(mailboxes("Jo\\e <a@x.example>"), [{ name: "Jo\\e", address: "a@x.example" }]);
  assert.deepEqual(mailboxes('"a" b\\c <x@y.example>'), [{ name: "a b\\c", address: "x@y.example" }]);
});

test("splitPersonAndEmail: every address in the text is taken out, the last is the address, and the rest is the person with its ends trimmed", () => {
  assert.deepEqual(splitPersonAndEmail("a@b.example c@d.example"), { person: "", email: "c@d.example" });
  assert.deepEqual(splitPersonAndEmail("x a@b.example y"), { person: "x  y", email: "a@b.example" });
  assert.deepEqual(splitPersonAndEmail('"Ann" <a@b.example>'), { person: "Ann", email: "a@b.example" });
  assert.deepEqual(splitPersonAndEmail("  just a name  "), { person: "just a name", email: "" });
});

test("splitPersonAndEmail: the part before the @ stops at white space of every kind, at < and at @", () => {
  for (const space of ["\n", "\v", "\f", "\r", "\t", " "]) {
    assert.equal(splitPersonAndEmail(`a${space}b@c.example`).email, "b@c.example", JSON.stringify(space));
  }
  assert.equal(splitPersonAndEmail("<a@b.example>").email, "a@b.example");
  assert.equal(splitPersonAndEmail("a@b@c.example").email, "a@b");
});

test("parseStructured: the type is lower case and, for an empty value, text/plain; the parameters are lower-cased names with trimmed values", () => {
  assert.equal(parseStructured("").type, "text/plain");
  assert.equal(parseStructured("TEXT/Plain; CharSet = utf-8 ").type, "text/plain");
  assert.deepEqual([...parseStructured("text/plain;  CharSet = utf-8 ; Name=x").parameters], [["charset", "utf-8"], ["name", "x"]]);
});

test("parseStructured: a part with no = is not a parameter", () => {
  assert.deepEqual([...parseStructured("text/plain; flag; charset=utf-8").parameters], [["charset", "utf-8"]]);
});

test("parseStructured: a quoted value loses its quotes and its quoted pairs; a ; or an escaped quote inside quotes does not end it", () => {
  const { parameters } = parseStructured('attachment; filename="a;b \\"c\\".pdf"; size=1');
  assert.equal(parameters.get("filename"), 'a;b "c".pdf');
  assert.equal(parseStructured('attachment; filename="a\\";b.pdf"').parameters.get("filename"), 'a";b.pdf');
  assert.equal(parameters.get("size"), "1");
});

test("parseStructured: a value that only starts with a quote keeps it, and the last parameter needs no ;", () => {
  assert.equal(parseStructured('x; a="open').parameters.get("a"), '"open');
  assert.equal(parseStructured('x; a=open"').parameters.get("a"), 'open"');
  assert.equal(parseStructured("x; a=1;").parameters.get("a"), "1");
  assert.equal(parseStructured("x; a=1;   ").parameters.size, 1);
});

test("Subject: white space between encoded words is dropped, a tab as well as a space, and kept next to anything else", async () => {
  const title = async (subject: string): Promise<string | null> => (await parse(`Subject: ${subject}\r\n\r\nbody`)).metadata.get("dc:title");
  assert.equal(await title("=?utf-8?Q?a?=\t=?utf-8?Q?b?="), "ab");
  assert.equal(await title("=?utf-8?Q?a?=   =?utf-8?B?Yg==?="), "ab");
  assert.equal(await title("=?utf-8?Q?a?=\r=?utf-8?Q?b?="), "ab");
  assert.equal(await title("=?utf-8?Q?a?= text =?utf-8?Q?b?="), "a text b");
  assert.equal(await title("=?utf-8?Q?a?= =?utf-8?x?junk?="), "a =?utf-8?x?junk?=");
});

test("a Subject encoded word in Q takes _ as a space and every one of them", async () => {
  assert.equal((await parse("Subject: =?utf-8?Q?a_b_c?=\r\n\r\nbody")).metadata.get("dc:title"), "a b c");
});

test("a From that is not an address list and is folded is read from its raw text", async () => {
  const { metadata } = await parse("From: <a@b.example> :\r\n <d@e.example>\r\n\r\nbody");
  assert.deepEqual(metadata.getAll("message:from"), ["a@b.example> :\r\n <d@e.example"]);
});
