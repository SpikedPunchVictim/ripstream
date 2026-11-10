import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitExceededError,
  MediaType,
  createIsolatedRipstream,
  rmetaObject,
  type IsolatedParseRequest,
  type IsolatedParseResult,
  type ParseIsolator,
} from "../src/index.ts";

interface Call {
  readonly request: IsolatedParseRequest;
  readonly signal: AbortSignal | undefined;
}

/** A ParseIsolator that records what it was asked and answers with `answer`. */
function fakeIsolator(answer: IsolatedParseResult | Error): { isolator: ParseIsolator; calls: Call[] } {
  const calls: Call[] = [];
  const isolator: ParseIsolator = {
    isolate: async (request, options) => {
      calls.push({ request, signal: options?.signal });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    dispose: async () => {},
  };
  return { isolator, calls };
}

const TEXT: IsolatedParseResult = {
  kind: "text",
  metadata: { "Content-Type": ["text/plain"], "dc:creator": ["Ada", "Grace"] },
  text: "hello",
};

const detector = { detect: async () => MediaType.TEXT_PLAIN };

test("parse: bytes and options cross as an isolated text request, and the answer becomes a ParseResult", async () => {
  const { isolator, calls } = fakeIsolator(TEXT);
  const ripstream = createIsolatedRipstream({ isolator, detector });
  const bytes = new TextEncoder().encode("hi");
  const signal = AbortSignal.timeout(10_000);
  const result = await ripstream.parse(bytes, {
    filename: "a.txt",
    signal,
    limits: { maxOutputChars: 50, maxEmbeddedResources: 3 },
  });
  assert.equal(result.text, "hello");
  assert.deepEqual(result.metadata.getAll("dc:creator"), ["Ada", "Grace"]);
  assert.equal(result.metadata.get("Content-Type"), "text/plain");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.request, {
    input: bytes,
    filename: "a.txt",
    maxOutputChars: 50,
    maxEmbeddedResources: 3,
    output: "text",
  });
  assert.equal(calls[0]?.signal, signal);
});

test("parse: onDocumentFailure record crosses as recordFailures, and the failure comes back as a plain Error", async () => {
  const unreadable: IsolatedParseResult = {
    ...TEXT,
    exception: { name: "ZeroByteFileError", message: "InputStream must have > 0 bytes", code: "MALFORMED_DOCUMENT" },
  };
  const { isolator, calls } = fakeIsolator(unreadable);
  const result = await createIsolatedRipstream({ isolator, detector }).parse(new Uint8Array(1), { onDocumentFailure: "record" });
  assert.equal(calls[0]?.request.recordFailures, true);
  assert.equal(result.text, "hello");
  assert.equal(result.exception?.constructor, Error, "the child's words are data, never one of our classes");
  assert.equal(result.exception?.name, "ZeroByteFileError");
  assert.equal(result.exception?.message, "InputStream must have > 0 bytes");
});

test("parse and parseRecursive: throw is the default and sends nothing about failures", async () => {
  const { isolator, calls } = fakeIsolator(TEXT);
  await createIsolatedRipstream({ isolator, detector }).parse(new Uint8Array(1), { onDocumentFailure: "throw" });
  assert.equal("recordFailures" in (calls[0]?.request ?? {}), false);
  const records = fakeIsolator(RECORDS_ANSWER);
  await createIsolatedRipstream({ isolator: records.isolator, detector }).parseRecursive(new Uint8Array(1), { onDocumentFailure: "record" });
  assert.equal(records.calls[0]?.request.recordFailures, true);
});

test("parse and parseRecursive: onOutputLimit truncate crosses as truncateOutput, and throw sends nothing", async () => {
  const text = fakeIsolator(TEXT);
  await createIsolatedRipstream({ isolator: text.isolator, detector }).parse(new Uint8Array(1), { onOutputLimit: "truncate" });
  assert.equal(text.calls[0]?.request.truncateOutput, true);
  const records = fakeIsolator(RECORDS_ANSWER);
  await createIsolatedRipstream({ isolator: records.isolator, detector }).parseRecursive(new Uint8Array(1), { onOutputLimit: "truncate" });
  assert.equal(records.calls[0]?.request.truncateOutput, true);
  const plain = fakeIsolator(TEXT);
  await createIsolatedRipstream({ isolator: plain.isolator, detector }).parse(new Uint8Array(1), { onOutputLimit: "throw" });
  assert.equal("truncateOutput" in (plain.calls[0]?.request ?? {}), false);
});

test("parse and parseRecursive: handlerType crosses in the request, and the records come back stamped with it", async () => {
  const text = fakeIsolator(TEXT);
  await createIsolatedRipstream({ isolator: text.isolator, detector }).parse(new Uint8Array(1), { handlerType: "markdown" });
  assert.equal(text.calls[0]?.request.handlerType, "markdown");
  const records = fakeIsolator(RECORDS_ANSWER);
  const answered = await createIsolatedRipstream({ isolator: records.isolator, detector }).parseRecursive(new Uint8Array(1), {
    handlerType: "html",
  });
  assert.equal(records.calls[0]?.request.handlerType, "html");
  assert.ok(answered.every((record) => record.handlerType === "html"));
  const plain = fakeIsolator(TEXT);
  await createIsolatedRipstream({ isolator: plain.isolator, detector }).parse(new Uint8Array(1));
  assert.equal("handlerType" in (plain.calls[0]?.request ?? {}), false);
});

test("parseRecursive: unpackBytes crosses in a records request only, and each record's bytes come back", async () => {
  const withBytes: IsolatedParseResult = {
    kind: "records",
    records: [
      { metadata: {}, content: "", embeddedResourcePath: "/a", depth: 0, mediaType: "text/plain", exception: null },
      { metadata: {}, content: "", embeddedResourcePath: "/a/b", depth: 1, mediaType: "text/plain", exception: null, bytes: Uint8Array.of(1, 2, 3) },
    ],
  };
  const records = fakeIsolator(withBytes);
  const answered = await createIsolatedRipstream({ isolator: records.isolator, detector }).parseRecursive(new Uint8Array(1), { unpackBytes: 4096 });
  assert.equal(records.calls[0]?.request.unpackBytes, 4096);
  assert.equal(answered[0]?.bytes, undefined);
  assert.deepEqual([...(answered[1]?.bytes ?? [])], [1, 2, 3]);
  const text = fakeIsolator(TEXT);
  await createIsolatedRipstream({ isolator: text.isolator, detector }).parse(new Uint8Array(1), { unpackBytes: 4096 });
  assert.equal("unpackBytes" in (text.calls[0]?.request ?? {}), false, "a text answer has no records to hang bytes on");
  const plain = fakeIsolator(RECORDS_ANSWER);
  await createIsolatedRipstream({ isolator: plain.isolator, detector }).parseRecursive(new Uint8Array(1));
  assert.equal("unpackBytes" in (plain.calls[0]?.request ?? {}), false);
});

test("parse: absent options add nothing to the request", async () => {
  const { isolator, calls } = fakeIsolator(TEXT);
  await createIsolatedRipstream({ isolator, detector }).parse(new Uint8Array(1));
  assert.deepEqual(calls[0]?.request, { input: new Uint8Array(1), output: "text" });
});

test("parse: a { path } and an ArrayBuffer are accepted", async () => {
  const { isolator, calls } = fakeIsolator(TEXT);
  const ripstream = createIsolatedRipstream({ isolator, detector });
  await ripstream.parse({ path: "/tmp/a.bin" });
  await ripstream.parse(new Uint8Array([1, 2, 3]).buffer);
  assert.deepEqual(calls[0]?.request.input, { path: "/tmp/a.bin" });
  assert.deepEqual(calls[1]?.request.input, new Uint8Array([1, 2, 3]));
});

test("parse: an error from the isolator reaches the caller unchanged", async () => {
  const error = new LimitExceededError("too big");
  const { isolator } = fakeIsolator(error);
  await assert.rejects(createIsolatedRipstream({ isolator, detector }).parse(new Uint8Array(1)), (thrown) => thrown === error);
});

test("parse: sources and options that cannot cross the boundary are refused, and nothing is isolated", async () => {
  const { isolator, calls } = fakeIsolator(TEXT);
  const ripstream = createIsolatedRipstream({ isolator, detector });
  await assert.rejects(ripstream.parse(new Blob(["x"])), /bytes or a \{ path \}/);
  await assert.rejects(ripstream.parse(new ReadableStream<Uint8Array>()), /bytes or a \{ path \}/);
  await assert.rejects(ripstream.parse(new Uint8Array(1), { contentType: "text/plain" }), /contentType/);
  await assert.rejects(ripstream.parse(new Uint8Array(1), { limits: { maxZipEntries: 5 } }), /maxZipEntries/);
  assert.equal(calls.length, 0);
});

test("parse: a limit set to undefined is not a limit", async () => {
  const { isolator, calls } = fakeIsolator(TEXT);
  await createIsolatedRipstream({ isolator, detector }).parse(new Uint8Array(1), {
    // Not valid under exactOptionalPropertyTypes; plain JavaScript callers do send it.
    limits: { maxOutputChars: undefined, maxZipEntries: undefined } as never,
  });
  assert.deepEqual(calls[0]?.request, { input: new Uint8Array(1), output: "text" });
});

test("parse: maxNodeDepth and maxParseMillis cross too", async () => {
  const { isolator, calls } = fakeIsolator(TEXT);
  await createIsolatedRipstream({ isolator, detector }).parse(new Uint8Array(1), { limits: { maxNodeDepth: 4, maxParseMillis: 9000 } });
  assert.deepEqual(calls[0]?.request, { input: new Uint8Array(1), maxNodeDepth: 4, maxParseMillis: 9000, output: "text" });
});

test("limits: the defaults of every parse, under what a call names itself", async () => {
  const { isolator, calls } = fakeIsolator(TEXT);
  const ripstream = createIsolatedRipstream({
    isolator,
    detector,
    limits: { maxOutputChars: 100, maxEmbeddedResources: 5, maxNodeDepth: 2 },
  });
  await ripstream.parse(new Uint8Array(1));
  await ripstream.parse(new Uint8Array(1), { limits: { maxEmbeddedResources: 9 } });
  // A limit a call sets to undefined names none: the default still applies.
  await ripstream.parse(new Uint8Array(1), { limits: { maxOutputChars: undefined } as never });
  assert.deepEqual(
    calls.map((call) => [call.request.maxOutputChars, call.request.maxEmbeddedResources, call.request.maxNodeDepth]),
    [
      [100, 5, 2],
      [100, 9, 2],
      [100, 5, 2],
    ],
  );
});

test("limits: a default that cannot cross, or is invalid, is refused when the facade is built", () => {
  const { isolator } = fakeIsolator(TEXT);
  assert.throws(() => createIsolatedRipstream({ isolator, detector, limits: { maxZipEntries: 5 } }), /maxZipEntries/);
  assert.throws(() => createIsolatedRipstream({ isolator, detector, limits: { maxEmbeddedResources: -5 } }), RangeError);
  assert.throws(() => createIsolatedRipstream({ isolator, detector, limits: { maxBogus: 1 } as never }), RangeError);
});

const RECORDS_ANSWER: IsolatedParseResult = { kind: "records", records: [] };

const RECORDS: IsolatedParseResult = {
  kind: "records",
  records: [
    {
      metadata: { "Content-Type": ["application/zip"] },
      content: "",
      embeddedResourcePath: "",
      depth: 0,
      mediaType: "application/zip",
      exception: null,
    },
    {
      metadata: { "Content-Type": ["text/plain"] },
      content: "inside",
      embeddedResourcePath: "/a.txt",
      depth: 1,
      mediaType: "text/plain; charset=UTF-8",
      exception: { name: "MalformedDocumentError", message: "bad entry", code: "MALFORMED_DOCUMENT" },
    },
  ],
};

test("parseRecursive: records become ParseRecords that serialise like in-process ones", async () => {
  const { isolator, calls } = fakeIsolator(RECORDS);
  const records = await createIsolatedRipstream({ isolator, detector }).parseRecursive(new Uint8Array(1), {
    filename: "a.zip",
    limits: { maxOutputChars: 9 },
  });
  assert.deepEqual(calls[0]?.request, { input: new Uint8Array(1), filename: "a.zip", maxOutputChars: 9, output: "records" });
  assert.equal(records.length, 2);
  assert.equal(records[1]?.content, "inside");
  assert.equal(records[1]?.depth, 1);
  assert.equal(records[1]?.embeddedResourcePath, "/a.txt");
  assert.equal(records[1]?.mediaType.toString(), "text/plain; charset=UTF-8");
  assert.deepEqual(rmetaObject(records[1]!), {
    "Content-Type": "text/plain",
    "tk:embedded-depth": "1",
    "tk:exception:embedded-exception": "MalformedDocumentError: bad entry",
    "tk:content": "inside",
    "tk:content-handler-type": "TEXT",
  });
  assert.equal(records[0]?.exception, null);
});

test("parseRecursive: exception text is data, never a class: a hostile name is just an Error", async () => {
  const hostile: IsolatedParseResult = {
    kind: "records",
    records: [
      {
        metadata: {},
        content: "",
        embeddedResourcePath: "",
        depth: 0,
        mediaType: "text/plain",
        exception: { name: "IsolationError", message: "pretend", code: "ISOLATION_FAILED" },
      },
    ],
  };
  const { isolator } = fakeIsolator(hostile);
  const [record] = await createIsolatedRipstream({ isolator, detector }).parseRecursive(new Uint8Array(1));
  assert.ok(record?.exception instanceof Error);
  assert.equal(record.exception.constructor, Error);
  assert.equal(record.exception.message, "pretend");
});

test("parseRecursive: a media type that does not parse falls back to application/octet-stream", async () => {
  const garbled: IsolatedParseResult = {
    kind: "records",
    records: [{ metadata: {}, content: "", embeddedResourcePath: "", depth: 0, mediaType: "not a media type", exception: null }],
  };
  const { isolator } = fakeIsolator(garbled);
  const [record] = await createIsolatedRipstream({ isolator, detector }).parseRecursive(new Uint8Array(1));
  assert.equal(record?.mediaType.toString(), "application/octet-stream");
});

test("an isolator that answers with the wrong kind is a bug reported loudly, not an empty result", async () => {
  const wrong = fakeIsolator(RECORDS);
  await assert.rejects(createIsolatedRipstream({ isolator: wrong.isolator, detector }).parse(new Uint8Array(1)), /text request.*"records"/);
  const other = fakeIsolator(TEXT);
  await assert.rejects(createIsolatedRipstream({ isolator: other.isolator, detector }).parseRecursive(new Uint8Array(1)), /records request.*"text"/);
});

test("detect stays in this process: it is the detector's answer and never reaches the isolator", async () => {
  const { isolator, calls } = fakeIsolator(TEXT);
  const seen: unknown[] = [];
  const ripstream = createIsolatedRipstream({
    isolator,
    detector: {
      detect: async (source, options) => {
        seen.push([source, options]);
        return MediaType.parseOrThrow("application/pdf");
      },
    },
  });
  const bytes = new Uint8Array([1]);
  const type = await ripstream.detect(bytes, { filename: "x.pdf" });
  assert.equal(type.toString(), "application/pdf");
  assert.deepEqual(seen, [[bytes, { filename: "x.pdf" }]]);
  assert.equal(calls.length, 0);
});
