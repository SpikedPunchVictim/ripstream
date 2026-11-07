import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { MboxParser } from "../src/index.ts";

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
