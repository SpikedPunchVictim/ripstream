import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  TIKA_KEYS,
} from "@spikedpunch/ripstream-core";
import { MailParser, MboxParser } from "../src/index.ts";

test("parses mbox messages", async () => {
  const mbox = [
    "From ada@example.com Mon Jan  1 00:00:00 2024",
    "From: Ada <ada@example.com>",
    "Subject: First",
    "Content-Type: text/plain",
    "",
    "Hello one",
    "From grace@example.com Tue Jan  2 00:00:00 2024",
    "From: Grace <grace@example.com>",
    "Subject: Second",
    "Content-Type: text/plain",
    "",
    "Hello two",
  ].join("\n");
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(mbox));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new MboxParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /First/);
  assert.match(handler.toString(), /Hello one/);
  assert.match(handler.toString(), /Second/);
  assert.match(handler.toString(), /Hello two/);
  assert.equal(metadata.get("Message:Count"), "2");
});

async function parseBytes(parser: MboxParser | MailParser, bytes: Uint8Array): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  await parser.parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  return handler.toString();
}

test("mbox applies the part charset to raw 8-bit bytes like .eml does", async () => {
  // ISO-8859-1 "café crème": 0xE9 and 0xE8 are not valid UTF-8 sequences.
  const body = Uint8Array.from([
    ...new TextEncoder().encode("caf"), 0xe9, ...new TextEncoder().encode(" cr"),
    0xe8, ...new TextEncoder().encode("me"),
  ]);
  const head = new TextEncoder().encode(
    "From: Ada <ada@example.com>\nSubject: Latin\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: 8bit\n\n",
  );
  const message = Uint8Array.from([...head, ...body, 0x0a]);
  const mbox = Uint8Array.from([
    ...new TextEncoder().encode("From ada@example.com Mon Jan  1 00:00:00 2024\n"),
    ...message,
  ]);
  const eml = await parseBytes(new MailParser(), message);
  const fromMbox = await parseBytes(new MboxParser(), mbox);
  assert.match(eml, /café crème/);
  assert.match(fromMbox, /café crème/);
});

async function parseMboxWithMetadata(text: string): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(text));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new MboxParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  return { text: handler.toString(), metadata };
}

const FIRST = "From ada@example.com Mon Jan  1 00:00:00 2024\nFrom: Ada <ada@example.com>\nSubject: First\nContent-Type: text/plain\n\n";
const SECOND = "From grace@example.com Tue Jan  2 00:00:00 2024\nFrom: Grace <grace@example.com>\nSubject: Second\nContent-Type: text/plain\n\nHello two\n";

test("mbox keeps a body line that starts with From inside its message (tikajs-gz44)", async () => {
  const result = await parseMboxWithMetadata(`${FIRST}Hello one\nFrom my perspective this is fine.\nlast line\n${SECOND}`);
  assert.equal(result.metadata.get("Message:Count"), "2");
  assert.match(result.text, /From my perspective this is fine\./);
  assert.match(result.text, /last line/);
  assert.match(result.text, /Hello two/);
});

test("mbox keeps a body line that starts with From after a paragraph break (tikajs-gz44)", async () => {
  const result = await parseMboxWithMetadata(`${FIRST}Hello one\n\nFrom the desk of the CEO\nmore\n${SECOND}`);
  assert.equal(result.metadata.get("Message:Count"), "2");
  assert.match(result.text, /From the desk of the CEO/);
});

test("mbox keeps a From body line that is followed by a blank line (paragraph break)", async () => {
  const result = await parseMboxWithMetadata(`${FIRST}Hello one\nFrom the desk of the CEO\n\nsecond paragraph\n${SECOND}`);
  assert.equal(result.metadata.get("Message:Count"), "2");
  assert.equal(result.metadata.get(TIKA_KEYS.EMBEDDED_EXCEPTION), null);
  assert.match(result.text, /From the desk of the CEO/);
  assert.match(result.text, /second paragraph/);
});

test("mbox continues past a message the mail parser rejects (tikajs-gz44)", async () => {
  // The first message's block is not an email at all: no header line.
  const broken = "From x@example.com Mon Jan  1 00:00:00 2024\n\nno headers here\n";
  const result = await parseMboxWithMetadata(`${broken}${SECOND}`);
  assert.equal(result.metadata.get("Message:Count"), "1");
  assert.match(result.text, /Hello two/);
});
