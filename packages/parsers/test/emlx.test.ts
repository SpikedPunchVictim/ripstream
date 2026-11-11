import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { MailParser, createRipstream } from "../src/index.ts";

/*
 * Apple Mail's emlx: a byte-count line, the RFC822 message, then an XML plist. Tika's RFC822Parser.stripEmlxFraming drops
 * the count line, and bounds the message to the count when the plist really starts there; EMLXTest is the source of
 * these cases. Read from Tika source, not run against a Tika.
 */

const encoder = new TextEncoder();
const ripstream = createRipstream();

const PLIST =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n<dict>\n\t<key>date-received</key>\n\t<integer>1698393810</integer>\n</dict>\n</plist>\n';

const SINGLE_PART = [
  "Subject: Trial balance",
  "Mime-Version: 1.0",
  "Content-Type: text/html;",
  "\tcharset=utf-8",
  "Message-Id: <0F1D2C3B@example.com>",
  "Date: Fri, 27 Oct 2023 10:03:30 +0200",
  "To: dors.venabili@example.com",
  "Content-Transfer-Encoding: 7bit",
  "From: Hari Seldon <hseldon@example.com>",
  "",
  '<html><head></head><body dir="auto">The trial balance is ready for review.</body></html>',
  "",
].join("\n");

const MULTIPART = [
  "Delivered-To: dors.venabili@example.com",
  ...Array.from({ length: 40 }, (_, index) => `X-Header-${index}: ${"v".repeat(70)}`),
  "Subject: Set the Foundation Straight",
  "From: Hari Seldon <hseldon@example.com>",
  "To: dors.venabili@example.com",
  'Content-Type: multipart/alternative; boundary="Apple-Boundary"',
  "",
  "--Apple-Boundary",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "The plan is in the HTML part.",
  "--Apple-Boundary",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>The plan for the Foundation is in this message's HTML part.</p></body></html>",
  "--Apple-Boundary--",
  "",
].join("\n");

const padded = (count: number): string => `${count}`.padEnd(10, " ");
const emlx = (message: string, count: string = padded(Buffer.byteLength(message))): Uint8Array =>
  encoder.encode(`${count}\n${message}${PLIST}`);

async function parseWithMailParser(bytes: Uint8Array): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await new MailParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

test("an emlx is detected as message/x-emlx and read as a message, its count line and plist dropped", async () => {
  const bytes = emlx(SINGLE_PART);
  const result = await ripstream.parse(bytes, { filename: "1.emlx" });
  assert.equal(result.metadata.get("Content-Type"), "message/x-emlx");
  assert.equal(result.metadata.get("dc:title"), "Trial balance");
  assert.match(result.text, /The trial balance is ready for review\./);
  assert.doesNotMatch(result.text, /date-received|plist|1698393810/);
  assert.doesNotMatch(result.text, new RegExp(`\\b${Buffer.byteLength(SINGLE_PART)}\\b`));
});

test("an emlx with a long header block and an HTML alternative is read in full", async () => {
  const result = await ripstream.parse(emlx(MULTIPART), { filename: "2.emlx" });
  assert.equal(result.metadata.get("Content-Type"), "message/x-emlx");
  assert.equal(result.metadata.get("dc:title"), "Set the Foundation Straight");
  assert.match(result.text, /The plan for the Foundation is in this message's HTML part\./);
  assert.doesNotMatch(result.text, /date-received|plist/);
});

test("a count that does not land on the plist is not trusted: the message is not cut, the count line is still dropped", async () => {
  // An edited file: the count no longer lands on "<?xml". Tika parses the message whole rather than cut it.
  for (const bad of [0, 100, 1500, 99999, 9_999_999_999]) {
    const bytes = emlx(SINGLE_PART, padded(bad));
    const result = await parseWithMailParser(bytes);
    assert.equal(result.metadata.get("dc:title"), "Trial balance", `count ${bad}`);
    assert.match(result.text, /The trial balance is ready for review\./, `count ${bad}`);
    assert.ok(!result.text.includes(padded(bad).trim() + "\n"), `count ${bad}: the count line is dropped`);
  }
});

test("a byte count with no padding is read", async () => {
  const message = "Subject: Unpadded\nFrom: a@example.com\nTo: b@example.com\n\nthe body\n";
  const result = await parseWithMailParser(emlx(message, `${Buffer.byteLength(message)}`));
  assert.equal(result.metadata.get("dc:title"), "Unpadded");
  assert.match(result.text, /the body/);
  assert.doesNotMatch(result.text, /date-received|plist/);
});

test("the framing is stripped for a message handed to the parser as message/rfc822 as well", async () => {
  const message = "Subject: Forced\nFrom: a@example.com\n\nthe body\n";
  const stream = await RipstreamInputStream.from(emlx(message, padded(Buffer.byteLength(message))));
  const metadata = new Metadata();
  metadata.set("Content-Type", "message/rfc822");
  const handler = new BodyContentHandler();
  try {
    await new MailParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  assert.equal(metadata.get("dc:title"), "Forced");
  assert.match(handler.toString(), /the body/);
  assert.doesNotMatch(handler.toString(), /date-received|plist/);
});

test("a CRLF count line is not framing: the file is left alone", async () => {
  const crlf = encoder.encode(new TextDecoder().decode(emlx(SINGLE_PART)).replaceAll("\n", "\r\n"));
  const result = await parseWithMailParser(crlf);
  assert.equal(result.metadata.get("dc:title"), "Trial balance");
  assert.match(result.text, /The trial balance is ready for review\./);
});

test("only the first 11 bytes are read as a count line: a long run of digits is not one", async () => {
  // Hostile: megabytes of digits and no newline. The count line must come from a bounded look at the head, and the
  // document must be rejected as having no headers, not scanned for a plist.
  const bytes = encoder.encode(`${"1".repeat(2_000_000)}\nplain text, with no header in it at all`);
  await assert.rejects(parseWithMailParser(bytes), (error: Error) => error.name === "MalformedDocumentError");
});

test("a digit after the padding is not a count line: the framing is left in place, plist and all", async () => {
  // "1 5" is not a padded count. A reader that took it for 15 would cut the 15 byte message and drop the plist.
  const message = "Subject: s\n\nxy\n";
  assert.equal(Buffer.byteLength(message), 15);
  const result = await parseWithMailParser(encoder.encode(`1 5\n${message}${PLIST}`));
  assert.match(result.text, /date-received/);
});

test("a count of 90 is read: its 9 and its 0 are digits, and the message is bounded to 90 bytes", async () => {
  const message = `Subject: s\n\n${"x".repeat(90 - "Subject: s\n\n".length)}`;
  assert.equal(Buffer.byteLength(message), 90);
  const result = await parseWithMailParser(emlx(message));
  assert.doesNotMatch(result.text, /date-received/);
});

test("a count line is at most 11 bytes: eleven digits and the newline are not one, so the plist is not cut off", async () => {
  const message = "Subject: s\n\nxy\n";
  const count = `${Buffer.byteLength(message)}`.padStart(11, "0");
  const result = await parseWithMailParser(emlx(message, count));
  assert.match(result.text, /date-received/);
});

test("a plist that is only its first five bytes, at the very end of the data, still bounds the message", async () => {
  const message = "Subject: s\n\nxy\n";
  const result = await parseWithMailParser(encoder.encode(`${padded(Buffer.byteLength(message))}\n${message}<?xml`));
  assert.doesNotMatch(result.text, /<\?xml/);
});
