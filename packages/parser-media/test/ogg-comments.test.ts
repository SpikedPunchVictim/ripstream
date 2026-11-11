import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { decodeMimeBase64, parseComments, parsePictureBlock } from "../src/ogg-comments.ts";
import { VORBIS_COMMENT_PREFIX, commentBlock, concat, enc, u32be, u32le } from "./ogg-builder.ts";

/*
 * The Vorbis comment header and the FLAC picture block inside it, as OggAudioParser reads them (rawFields,
 * PictureBlock.parse and the JDK's MIME Base64 decoder). Read from Tika's source; not run against a Tika.
 */

test("vendor and comments are read, names lowercased and a comment without an equals sign left out", () => {
  const block = commentBlock("Xiph.Org libVorbis", ["TITLE=Test Title", "Artist=A=B", "no equals sign", "empty=", "title=Second"]);
  const comments = parseComments(block, 0);
  assert.equal(comments.vendor, "Xiph.Org libVorbis");
  assert.deepEqual([...comments.fields], [
    ["title", ["Test Title", "Second"]],
    ["artist", ["A=B"]],
    ["empty", [""]],
  ]);
});

test("the bytes before the vendor length are skipped as the codec says", () => {
  const block = commentBlock("v", ["title=T"], VORBIS_COMMENT_PREFIX);
  assert.equal(parseComments(block, VORBIS_COMMENT_PREFIX.length).fields.get("title")?.[0], "T");
});

test("text is UTF-8 with U+FFFD for bytes that are not, and a byte order mark is kept", () => {
  const block = commentBlock("v", [concat(enc("title="), Uint8Array.of(0xc3, 0xa9, 0xff)), concat(enc("artist="), Uint8Array.of(0xef, 0xbb, 0xbf), enc("A"))]);
  const { fields } = parseComments(block, 0);
  assert.equal(fields.get("title")?.[0], "é�");
  assert.equal(fields.get("artist")?.[0], "﻿A");
});

test("a comment block that stops short is refused as malformed", () => {
  const full = commentBlock("vendor", ["title=Test", "artist=Other"]);
  for (let length = 0; length < full.length; length++) {
    assert.throws(() => parseComments(full.subarray(0, length), 0), MalformedDocumentError, `prefix ${length}`);
  }
  assert.doesNotThrow(() => parseComments(full, 0));
});

test("a vendor length, a comment count or a comment length beyond the bytes present is refused, with nothing allocated for it", () => {
  const vendorTooLong = concat(u32le(0x7fffffff), enc("v"));
  assert.throws(() => parseComments(vendorTooLong, 0), MalformedDocumentError);

  // Four billion comments in a header of a few bytes: each takes at least its 4 byte length.
  const countTooBig = concat(u32le(0), u32le(0xffffffff), u32le(0));
  assert.throws(() => parseComments(countTooBig, 0), MalformedDocumentError);

  const lengthTooLong = concat(u32le(0), u32le(1), u32le(0xfffffff0), enc("title=x"));
  assert.throws(() => parseComments(lengthTooLong, 0), MalformedDocumentError);
});

test("more comments than any file has are refused as a limit, once the bytes for them are there", () => {
  const empties = Array.from({ length: 10_001 }, () => "");
  assert.throws(() => parseComments(commentBlock("v", empties), 0), LimitExceededError);
  assert.equal(parseComments(commentBlock("v", empties.slice(1)), 0).fields.size, 0);
});

test("the MIME Base64 decoder of the JDK: characters outside the alphabet are skipped, bad padding is refused", () => {
  const text = (bytes: Uint8Array | null): string | null => (bytes === null ? null : new TextDecoder().decode(bytes));
  assert.equal(text(decodeMimeBase64("QUJD")), "ABC");
  assert.equal(text(decodeMimeBase64("QUI=")), "AB");
  assert.equal(text(decodeMimeBase64("QQ==")), "A");
  // The last unit may stop short without padding, as Base64.Decoder accepts it.
  assert.equal(text(decodeMimeBase64("QUJDQQ")), "ABCA");
  assert.equal(text(decodeMimeBase64("QUJDQUI")), "ABCAB");
  // Line breaks, spaces, URL-safe characters and anything else outside the alphabet are skipped, not refused.
  assert.equal(text(decodeMimeBase64("QU\r\nJD\n QQ==")), "ABCA");
  assert.equal(text(decodeMimeBase64("Q-U_J D")), "ABC");
  assert.equal(text(decodeMimeBase64("QUJDĀé")), "ABC");
  assert.equal(text(decodeMimeBase64("")), "");

  assert.equal(decodeMimeBase64("QQ="), null, "a single = where two are needed");
  assert.equal(decodeMimeBase64("Q"), null, "a dangling sextet");
  assert.equal(decodeMimeBase64("QUJDQ"), null, "a dangling sextet at the end");
  assert.equal(decodeMimeBase64("QUJD="), null, "padding with no bits pending");
  assert.equal(decodeMimeBase64("===="), null);
  assert.equal(decodeMimeBase64("QQ==QUJD"), null, "alphabet characters after the padding");
  assert.equal(text(decodeMimeBase64("QQ==\r\n- ")), "A", "only skipped characters after the padding");
});

function pictureBlock(parts: { type?: number; mime?: string; description?: string; data?: Uint8Array; dataLength?: number } = {}): Uint8Array {
  const mime = enc(parts.mime ?? "image/png");
  const description = enc(parts.description ?? "Cover");
  const data = parts.data ?? Uint8Array.of(1, 2, 3, 4);
  return concat(
    u32be(parts.type ?? 3),
    u32be(mime.length),
    mime,
    u32be(description.length),
    description,
    new Uint8Array(16),
    u32be(parts.dataLength ?? data.length),
    data,
  );
}

test("a picture block gives its type, mime type, description and data", () => {
  const picture = parsePictureBlock(pictureBlock({ type: 4, mime: "image/jpeg", description: "Back" }));
  assert.deepEqual(picture, { type: 4, mimeType: "image/jpeg", description: "Back", data: Uint8Array.of(1, 2, 3, 4) });
});

test("a picture block that links, stops short or declares more than it holds is not a picture", () => {
  assert.equal(parsePictureBlock(pictureBlock({ mime: "-->" })), null, "a link, not a picture");
  assert.equal(parsePictureBlock(pictureBlock({ dataLength: 0, data: new Uint8Array(0) })), null, "no data");
  assert.equal(parsePictureBlock(pictureBlock({ dataLength: 5 })), null, "more data declared than present");
  assert.equal(parsePictureBlock(pictureBlock({ dataLength: 0x80000000 })), null, "a negative length");
  const full = pictureBlock();
  for (let length = 0; length < full.length; length++) {
    assert.equal(parsePictureBlock(full.subarray(0, length)), null, `prefix ${length}`);
  }
  assert.notEqual(parsePictureBlock(full), null);
});

test("a picture type beyond 31 bits is read as the signed number it is", () => {
  assert.equal(parsePictureBlock(pictureBlock({ type: 0xfffffffe }))?.type, -2);
});
