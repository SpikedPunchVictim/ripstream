import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  AutoDetectParser,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Ripstream,
  UnsupportedFormatError,
  ZeroByteFileError,
  type ContentHandler,
  type Detector,
  type Parser,
} from "../src/index.ts";

const detector: Detector = { detect: async () => MediaType.TEXT_PLAIN };

/** Writes "partial" and then fails with `failure` (or finishes when there is none). */
function parserThatFails(failure?: Error): Parser {
  return {
    name: "Failing",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(_stream, handler: ContentHandler): Promise<void> {
      await handler.startElement?.("", "body", "body", new AttributesImpl([]));
      await handler.characters?.("partial", 0, 7);
      await handler.endElement?.("", "body", "body");
      if (failure !== undefined) throw failure;
    },
  };
}

const engine = (failure?: Error): Ripstream => new Ripstream({ detector, parser: parserThatFails(failure) });
const bytes = new Uint8Array([1, 2, 3]);

test("parse: a document that cannot be read rejects by default", async () => {
  await assert.rejects(engine(new MalformedDocumentError("bad")).parse(bytes), MalformedDocumentError);
});

test("parse, recording: the failure is on the result and the metadata, with the text extracted before it", async () => {
  const result = await engine(new MalformedDocumentError("bad")).parse(bytes, { onDocumentFailure: "record" });
  assert.equal(result.text, "partial");
  assert.ok(result.exception instanceof MalformedDocumentError);
  assert.equal(result.metadata.get("tk:exception:container-exception"), "MalformedDocumentError: bad");
});

test("parse, recording: a document that reads has no exception", async () => {
  const result = await engine().parse(bytes, { onDocumentFailure: "record" });
  assert.equal(result.exception, undefined);
  assert.equal(result.metadata.get("tk:exception:container-exception"), null);
});

test("parse, recording: what is not about the document still rejects", async () => {
  await assert.rejects(engine(new LimitExceededError("too much")).parse(bytes, { onDocumentFailure: "record" }), LimitExceededError);
  await assert.rejects(engine(new TypeError("parser bug")).parse(bytes, { onDocumentFailure: "record" }), TypeError);
});

test("parse, recording: a format no parser takes is an empty document, named for the EmptyParser", async () => {
  const result = await engine(new UnsupportedFormatError("No parser for application/x-nothing")).parse(bytes, {
    onDocumentFailure: "record",
  });
  assert.equal(result.exception, undefined);
  assert.equal(result.metadata.get("tk:exception:container-exception"), null);
  assert.deepEqual(result.metadata.getAll("tk:parsed-by"), ["EmptyParser"]);
  await assert.rejects(engine(new UnsupportedFormatError("No parser")).parse(bytes), UnsupportedFormatError);
});

test("parseToString and parseToHandler throw whatever the option says: they have nowhere to put a failure", async () => {
  const failing = engine(new MalformedDocumentError("bad"));
  await assert.rejects(failing.parseToString(bytes, { onDocumentFailure: "record" }), MalformedDocumentError);
  await assert.rejects(
    failing.parseToHandler(bytes, { startDocument() {}, endDocument() {} }, { onDocumentFailure: "record" }),
    MalformedDocumentError,
  );
});

test("parseRecursive, recording: the container's record keeps its text and carries the failure", async () => {
  const records = await engine(new MalformedDocumentError("bad")).parseRecursive(bytes, { onDocumentFailure: "record" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.content, "partial");
  assert.ok(records[0]?.exception instanceof MalformedDocumentError);
  assert.equal(records[0]?.metadata.get("tk:exception:container-exception"), "MalformedDocumentError: bad");
  await assert.rejects(engine(new MalformedDocumentError("bad")).parseRecursive(bytes), MalformedDocumentError);
});

test("parseRecursive, recording: an unsupported container is a record with no exception; a limit still rejects", async () => {
  const [record] = await engine(new UnsupportedFormatError("No parser")).parseRecursive(bytes, { onDocumentFailure: "record" });
  assert.equal(record?.exception, null);
  assert.deepEqual(record?.metadata.getAll("tk:parsed-by"), ["EmptyParser"]);
  await assert.rejects(
    engine(new LimitExceededError("too much")).parseRecursive(bytes, { onDocumentFailure: "record" }),
    LimitExceededError,
  );
});

test("AutoDetectParser: an input of zero bytes is refused after the type is recorded", async () => {
  const auto = new AutoDetectParser({ detector, parser: parserThatFails() });
  const engineOfAuto = new Ripstream({ detector, parser: auto });
  await assert.rejects(engineOfAuto.parse(new Uint8Array(0)), ZeroByteFileError);
  const result = await engineOfAuto.parse(new Uint8Array(0), { onDocumentFailure: "record" });
  assert.equal(result.metadata.get("Content-Type"), "text/plain", "an empty document still reports its detected type");
  assert.equal(
    result.metadata.get("tk:exception:container-exception"),
    "ZeroByteFileError: InputStream must have > 0 bytes",
  );
  assert.equal((await engineOfAuto.parse(bytes)).text, "partial", "a document with bytes parses as before");
});
