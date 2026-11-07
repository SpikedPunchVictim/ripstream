import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { MailParser } from "../src/index.ts";

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
  await new MailParser().parse(
    stream,
    handler,
    metadata,
    new ParseContext(),
  );
  await stream.close();
  return { text: handler.toString(), metadata };
}

test("extracts multipart email text and headers", async () => {
  const result = await parse(message);
  assert.match(result.text, /Hello Email/);
  assert.match(result.text, /HTML part/);
  assert.equal(result.metadata.get("dc:title"), "Hello Mail");
  assert.equal(result.metadata.get("dc:creator"), "Ada <ada@example.com>");
  assert.equal(result.metadata.get("Message-ID"), "<abc@example.com>");
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
