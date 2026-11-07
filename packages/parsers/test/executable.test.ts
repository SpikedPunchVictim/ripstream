import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { ExecutableParser } from "../src/index.ts";

test("describes ELF headers", async () => {
  const elf = new Uint8Array(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  const view = new DataView(elf.buffer);
  view.setUint16(18, 62, true);
  const stream = await RipstreamInputStream.from(elf);
  const handler = new BodyContentHandler();
  await new ExecutableParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /ELF64/);
  assert.match(handler.toString(), /x86-64/);
});

test("rejects unknown binaries", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(
    new ExecutableParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
});
