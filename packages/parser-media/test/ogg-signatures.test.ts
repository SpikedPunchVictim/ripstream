import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream, createOutputHandler } from "@spikedpunch/ripstream-core";
import { OGG_STREAM_SIGNATURES } from "../../mime/src/containers/ogg.ts";
import { OGG_SIGNATURES, OggParser } from "../src/ogg.ts";
import { concat, enc, oggPage } from "./ogg-builder.ts";

/*
 * The Ogg stream signature table exists twice: in packages/mime, for detection, and in this package, for OggParser's
 * stream counts (parser-media does not depend on mime). They must name the same streams in the same order, as the
 * first signature that matches wins.
 */

test("OggParser's signature table is the one of the Ogg detector in packages/mime", () => {
  const detector = OGG_STREAM_SIGNATURES.map(({ bytes, minLength, type }) => ({ bytes, minLength, mime: type.mime.toString(), kind: type.kind }));
  const parser = OGG_SIGNATURES.map(({ bytes, minLength, mime, kind }) => ({ bytes, minLength, mime, kind }));
  assert.deepEqual(parser, detector);
});

test("the table names OGM and Ogg RGB video streams", () => {
  const mimes = OGG_SIGNATURES.map((signature) => signature.mime);
  assert.ok(mimes.includes("video/x-ogm"));
  assert.ok(mimes.includes("video/x-oggrgb"));
});

test("OggParser counts an OGM stream and a raw RGB stream by type, not as unknown (tikajs-68os.62)", async () => {
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [concat(enc("\u0001video\0\0\0"), new Uint8Array(50))], granule: 0n }),
    oggPage({ sid: 2, bos: true, packets: [concat(enc("\u0001RGB"), new Uint8Array(30))], granule: 0n }),
  );
  const metadata = new Metadata();
  const stream = await RipstreamInputStream.from(file);
  try {
    await new OggParser().parse(stream, createOutputHandler("body"), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  assert.deepEqual(metadata.getAll("ogg:streams-ogm"), ["1"]);
  assert.deepEqual(metadata.getAll("ogg:streams-oggrgb"), ["1"]);
  assert.deepEqual(metadata.getAll("ogg:streams-video"), ["2"]);
  assert.equal(metadata.has("ogg:streams-unknown"), false);
});

test("OggParser counts an OGM or Ogg RGB packet from 28 bytes, and a shorter one as unknown", async () => {
  const counts = async (signature: string, length: number): Promise<Metadata> => {
    const file = oggPage({ sid: 1, bos: true, packets: [concat(enc(signature), new Uint8Array(length - signature.length))], granule: 0n });
    const metadata = new Metadata();
    const stream = await RipstreamInputStream.from(file);
    try {
      await new OggParser().parse(stream, createOutputHandler("body"), metadata, new ParseContext());
    } finally {
      await stream.close();
    }
    return metadata;
  };
  assert.deepEqual((await counts("\u0001video", 28)).getAll("ogg:streams-ogm"), ["1"]);
  assert.deepEqual((await counts("\u0001video", 27)).getAll("ogg:streams-ogm"), []);
  assert.deepEqual((await counts("\u0001RGB", 28)).getAll("ogg:streams-oggrgb"), ["1"]);
  assert.deepEqual((await counts("\u0001RGB", 27)).getAll("ogg:streams-oggrgb"), []);
});
