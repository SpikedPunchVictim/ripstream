import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
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
