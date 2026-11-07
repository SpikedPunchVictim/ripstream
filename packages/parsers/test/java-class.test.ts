import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { JavaClassParser } from "../src/index.ts";

function sampleClass(): Uint8Array {
  const bytes: number[] = [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 5];
  const utf8 = (value: string): number[] => [1, 0, value.length, ...new TextEncoder().encode(value)];
  bytes.push(...utf8("Hello"), 7, 0, 1, ...utf8("java/lang/Object"), 7, 0, 3);
  bytes.push(0, 0x21, 0, 2, 0, 4, 0, 0); // access, this, super, interfaces
  bytes.push(0, 0); // fields
  bytes.push(0, 1, 0, 1, 0, 1, 0, 1, 0, 0); // one method: name/desc -> #1
  bytes.push(0, 0); // class attributes
  return new Uint8Array(bytes);
}

test("reads Java class identity and methods", async () => {
  const stream = await RipstreamInputStream.from(sampleClass());
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new JavaClassParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("dc:title"), "Hello");
  assert.equal(metadata.get("java:superclass"), "java.lang.Object");
  assert.match(handler.toString(), /Hello/);
  assert.match(handler.toString(), /java.lang.Object/);
});

test("rejects non-class data", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array([1, 2, 3]));
  await assert.rejects(
    new JavaClassParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
});
