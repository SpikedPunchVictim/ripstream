import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitExceededError,
  MalformedDocumentError,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { OpcPackage } from "../src/opc.ts";

async function sample(): Promise<RipstreamInputStream> {
  return RipstreamInputStream.from(
    zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8("<w:document>hello</w:document>"),
      "word/media/large.bin": new Uint8Array(1_000_000),
    }),
  );
}

test("reads requested OPC parts from the central directory", async () => {
  const stream = await sample();
  const context = new ParseContext();
  const pkg = await OpcPackage.open(stream, context.limits);
  try {
    assert.deepEqual(
      pkg.names.sort(),
      ["[Content_Types].xml", "word/document.xml", "word/media/large.bin"],
    );
    assert.equal(
      new TextDecoder().decode(await pkg.read("word/document.xml")),
      "<w:document>hello</w:document>",
    );
    await assert.rejects(pkg.read("missing.xml"), MalformedDocumentError);
  } finally {
    await pkg.close();
    await stream.close();
  }
});

test("enforces per-entry decompression ratio", async () => {
  const stream = await sample();
  const context = new ParseContext({ limits: { maxDecompressionRatio: 2 } });
  const pkg = await OpcPackage.open(stream, context.limits);
  try {
    await assert.rejects(pkg.read("word/media/large.bin"), LimitExceededError);
  } finally {
    await pkg.close();
    await stream.close();
  }
});

test("rejects non-ZIP input", async () => {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("nope"));
  await assert.rejects(
    OpcPackage.open(stream, new ParseContext().limits),
    MalformedDocumentError,
  );
  await stream.close();
});

test("lying uncompressed size cannot exceed the entry budget", async () => {
  const bytes = zipSync({ "word/bomb.bin": new Uint8Array(5_000_000) });
  // Patch declared uncompressed size to 100 in local and central headers.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(22, 100, true);
  for (let i = 0; i < bytes.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 100, true);
  }
  const stream = await RipstreamInputStream.from(bytes);
  const pkg = await OpcPackage.open(stream, {
    ...new ParseContext().limits,
    maxDecompressionRatio: 1_000_000,
    maxEmbeddedResourceBytes: 1_000_000,
  });
  try {
    await assert.rejects(pkg.read("word/bomb.bin"), LimitExceededError);
  } finally {
    await pkg.close();
    await stream.close();
  }
});
