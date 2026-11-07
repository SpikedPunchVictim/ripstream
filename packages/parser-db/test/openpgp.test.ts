import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { OpenPgpParser } from "../src/index.ts";

test("reads OpenPGP key packets", async () => {
  const user = new TextEncoder().encode("Ada <ada@example.com>");
  const key = [4, 0, 0, 0, 0, 1];
  const data = Uint8Array.from([
    0x98, key.length, ...key,
    0xb4, user.length, ...user,
  ]);
  const armored = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${Buffer.from(data).toString("base64")}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(armored));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new OpenPgpParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.deepEqual(metadata.getAll("pgp:packet"), ["Public Key", "User ID"]);
  assert.deepEqual(metadata.getAll("pgp:user-id"), ["Ada <ada@example.com>"]);
  assert.match(handler.toString(), /Ada/);
});

test("armor with many BEGIN markers decodes in linear time", { timeout: 30_000 }, async () => {
  const noise = "-----BEGIN PGP X-----\n".repeat(50_000);
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(noise));
  const start = performance.now();
  await new OpenPgpParser()
    .parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext())
    .catch(() => undefined);
  await stream.close();
  assert.ok(performance.now() - start < 5000);
});

async function parseArmored(armored: string): Promise<Metadata> {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(armored));
  const metadata = new Metadata();
  await new OpenPgpParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  return metadata;
}

function keyBytes(): Uint8Array {
  const user = new TextEncoder().encode("Ada <ada@example.com>");
  const key = [4, 0, 0, 0, 0, 1];
  return Uint8Array.from([0x98, key.length, ...key, 0xb4, user.length, ...user]);
}

test("armor with Version/Comment headers and CRC24 line parses", async () => {
  const body = Buffer.from(keyBytes()).toString("base64");
  const armored =
    `-----BEGIN PGP PUBLIC KEY BLOCK-----\nVersion: GnuPG v2\nComment: test key\n\n${body}\n=AbCd\n-----END PGP PUBLIC KEY BLOCK-----\n`;
  const metadata = await parseArmored(armored);
  assert.deepEqual(metadata.getAll("pgp:packet"), ["Public Key", "User ID"]);
  assert.deepEqual(metadata.getAll("pgp:user-id"), ["Ada <ada@example.com>"]);
});

test("armor with CRLF line endings, headers and CRC24 parses", async () => {
  const body = Buffer.from(keyBytes()).toString("base64");
  const armored =
    `-----BEGIN PGP PUBLIC KEY BLOCK-----\r\nComment: x\r\n\r\n${body}\r\n=AbCd\r\n-----END PGP PUBLIC KEY BLOCK-----\r\n`;
  const metadata = await parseArmored(armored);
  assert.deepEqual(metadata.getAll("pgp:user-id"), ["Ada <ada@example.com>"]);
});

test("armor with CRC24 but no headers parses", async () => {
  const body = Buffer.from(keyBytes()).toString("base64");
  const armored = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${body}\n=AbCd\n-----END PGP PUBLIC KEY BLOCK-----\n`;
  const metadata = await parseArmored(armored);
  assert.deepEqual(metadata.getAll("pgp:packet"), ["Public Key", "User ID"]);
});
