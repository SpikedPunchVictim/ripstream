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
    "Content-Type": ["text/plain"],
    "X-TIKA:embedded_resource_path": ["/a.txt"],
    "X-TIKA:embedded_depth": ["1"],
    "X-TIKA:content": "inside",
    "X-TIKA:EXCEPTION:MalformedDocumentError": ["bad entry"],
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
