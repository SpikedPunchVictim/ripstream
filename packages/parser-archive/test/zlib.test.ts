import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import {
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
} from "@spikedpunch/ripstream-core";
import { ZlibParser } from "../src/index.ts";
import {
  boundedContext,
  capturingContext,
  fromBase64,
  runParser,
  type Captured,
} from "./stream-helpers.ts";

// Tika's own tika-parser-pkg-module/src/test/resources/test-documents/testTXT.zlib.
const TIKA_TESTTXT_ZLIB = "eJwLSS0uUUhRz8xLSa1ILMnMz1NISVUIqSjhyigpKbDS1y8vL9dLLEhMzkjVyy9K5wIAlRwQnw==";

test("ZlibParser claims application/zlib, the type Tika's CompressorParser claims", () => {
  const types = [...new ZlibParser().getSupportedTypes()].map((type) => type.toString());
  assert.deepEqual(types, ["application/zlib"]);
});

test("decodes Tika's testTXT.zlib sample", async () => {
  const captured: Captured[] = [];
  await runParser(new ZlibParser(), fromBase64(TIKA_TESTTXT_ZLIB), capturingContext(captured));
  assert.equal(captured.length, 1);
  assert.equal(
    new TextDecoder().decode(captured[0]!.bytes),
    "Test d'indexation de Txt\nhttp://www.apache.org\n",
  );
});

test("names the embedded document after the container, minus .zlib", async () => {
  const captured: Captured[] = [];
  const metadata = new Metadata();
  metadata.set("tk:resource-name", "report.txt.zlib");
  await runParser(new ZlibParser(), deflateSync(Buffer.from("hello")), capturingContext(captured), metadata);
  assert.equal(captured[0]!.name, "report.txt");
});

test("every strict prefix of a zlib stream is refused as malformed", async () => {
  const valid = deflateSync(Buffer.from("a zlib stream that is long enough to be cut in many places"));
  for (let length = 0; length < valid.byteLength; length++) {
    await assert.rejects(
      runParser(new ZlibParser(), valid.subarray(0, length), capturingContext([])),
      MalformedDocumentError,
      `prefix of ${length} bytes`,
    );
  }
});

test("rejects bytes that are not zlib", async () => {
  await assert.rejects(
    runParser(new ZlibParser(), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), capturingContext([])),
    MalformedDocumentError,
  );
});

test("a zlib bomb fails with LimitExceededError at the output cap", async () => {
  await assert.rejects(
    runParser(new ZlibParser(), deflateSync(new Uint8Array(1_000_000)), boundedContext()),
    LimitExceededError,
  );
});
