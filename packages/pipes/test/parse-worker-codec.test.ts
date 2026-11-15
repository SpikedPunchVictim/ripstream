import assert from "node:assert/strict";
import { test } from "node:test";
import * as core from "@spikedpunch/ripstream-core";
import {
  AbortError,
  IsolationError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  MissingDependencyError,
  ParseTimeoutError,
  RipstreamConfig,
  RipstreamConfigError,
  WriteLimitReachedError,
  type ParseRecord,
} from "@spikedpunch/ripstream-core";
import {
  CONFIG_FIELDS,
  KNOWN_ERROR_CLASSES,
  decodeError,
  decodeMediaType,
  decodeMetadata,
  decodeRecords,
  effectiveParseMillis,
  encodeError,
  encodeMediaType,
  encodeMetadata,
  encodeRecords,
  specOf,
  wireInput,
  wireOptions,
  type EncodedError,
} from "../src/parse-worker-codec.ts";

/** Through structured clone, as a message to and from a worker goes. */
const roundTrip = (error: unknown): unknown => decodeError(structuredClone(encodeError(error)));

test("every Error class core exports is one the codec builds again", () => {
  const known = new Set<unknown>(KNOWN_ERROR_CLASSES.values());
  const classes = Object.entries(core).filter(([, value]) => typeof value === "function" && value.prototype instanceof Error);
  assert.ok(classes.length >= 21, `core exports ${classes.length} Error classes`);
  assert.deepEqual(classes.filter(([, value]) => !known.has(value)).map(([name]) => name), []);
});

test("an error crosses as its class, with its name, message, fields, stack and cause", () => {
  const cause = new TypeError("inner");
  const error = new IsolationError("crash", "the child died", { cause });
  const decoded = roundTrip(error) as IsolationError;
  assert.ok(decoded instanceof IsolationError);
  assert.equal(decoded.reason, "crash");
  assert.equal(decoded.code, "ISOLATION_FAILED");
  assert.equal(decoded.recoverable, false);
  assert.equal(decoded.message, "the child died");
  assert.equal(decoded.name, error.name);
  assert.equal(decoded.stack, error.stack);
  assert.ok(decoded.cause instanceof TypeError);
  assert.equal((decoded.cause as Error).message, "inner");
});

test("a RipstreamConfigError crosses with its issues", () => {
  const decoded = roundTrip(new RipstreamConfigError(["one", "two"])) as RipstreamConfigError;
  assert.ok(decoded instanceof RipstreamConfigError);
  assert.deepEqual([...decoded.issues], ["one", "two"]);
  assert.equal(decoded.message, "Invalid ripstream configuration: one; two");
});

test("a DOMException crosses with its name", () => {
  const decoded = roundTrip(new DOMException("too slow", "TimeoutError")) as DOMException;
  assert.ok(decoded instanceof DOMException);
  assert.equal(decoded.name, "TimeoutError");
  assert.equal(decoded.message, "too slow");
});

test("an AggregateError crosses with its errors", () => {
  const decoded = roundTrip(new AggregateError([new MalformedDocumentError("bad"), "text"], "both")) as AggregateError;
  assert.ok(decoded instanceof AggregateError);
  assert.equal(decoded.message, "both");
  assert.ok(decoded.errors[0] instanceof MalformedDocumentError);
  assert.equal(decoded.errors[1], "text");
});

test("errors whose constructors take fields cross with them", () => {
  const limit = roundTrip(new WriteLimitReachedError(42)) as WriteLimitReachedError;
  assert.ok(limit instanceof WriteLimitReachedError);
  assert.equal(limit.limit, 42);
  const missing = roundTrip(new MissingDependencyError("tesseract", "OCR")) as MissingDependencyError;
  assert.ok(missing instanceof MissingDependencyError);
  assert.equal(missing.message, new MissingDependencyError("tesseract", "OCR").message);
});

test("an error of a class the codec does not know crosses as its nearest known ancestor, under its own name", () => {
  class XmlDepthError extends MalformedDocumentError {
    constructor() {
      super("too deep");
      this.name = "XmlDepthError";
    }
  }
  const decoded = roundTrip(new XmlDepthError()) as Error;
  assert.ok(decoded instanceof MalformedDocumentError);
  assert.equal(decoded.name, "XmlDepthError");
  assert.equal(decoded.message, "too deep");
});

test("a system error's code crosses", () => {
  const error = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT", errno: -2 });
  const decoded = roundTrip(error) as Error & { code: string; errno: number };
  assert.equal(decoded.code, "ENOENT");
  assert.equal(decoded.errno, -2);
});

test("a thrown value that is not an Error crosses as a value", () => {
  assert.equal(roundTrip("text"), "text");
  assert.equal(roundTrip(undefined), undefined);
  assert.equal(roundTrip({ toString: () => "an object" }), "an object");
});

test("a cause chain is followed four deep", () => {
  let error: Error = new Error("0");
  for (let depth = 1; depth <= 6; depth += 1) error = new Error(String(depth), { cause: error });
  let decoded = roundTrip(error) as Error;
  let depth = 0;
  while (decoded.cause !== undefined) {
    decoded = decoded.cause as Error;
    depth += 1;
  }
  assert.equal(depth, 4);
});

test("an encoding that cannot be read decodes to a plain Error with its name and message, and never throws", () => {
  const unknown = decodeError({ kind: "NoSuchKind", name: "OddError", message: "odd", props: {} } as unknown as EncodedError) as Error;
  assert.equal(unknown.constructor, Error);
  assert.equal(unknown.name, "OddError");
  assert.equal(unknown.message, "odd");
  const nothing = decodeError(null as unknown as EncodedError) as Error;
  assert.ok(nothing instanceof Error);
  const badProps = decodeError({ kind: "Error", name: "Error", message: "m", props: null } as unknown as EncodedError) as Error;
  assert.equal(badProps.message, "m");
});

test("a media type crosses by its parts, parameters a string form would garble included", () => {
  const type = new MediaType("text", "plain", { charset: 'a;b="c"', q: "x\\y" });
  const decoded = decodeMediaType(structuredClone(encodeMediaType(type)));
  assert.ok(decoded.equals(type));
  assert.equal(decoded.getParameter("charset"), 'a;b="c"');
});

test("metadata crosses with its names in order and every value", () => {
  const metadata = new Metadata();
  metadata.set("z", "1");
  metadata.add("a", "2");
  metadata.add("a", "3");
  const decoded = decodeMetadata(structuredClone(encodeMetadata(metadata)));
  assert.deepEqual(decoded.names(), ["z", "a"]);
  assert.deepEqual(decoded.getAll("a"), ["2", "3"]);
});

test("records cross with their fields, and each one's bytes in a buffer of their own", () => {
  const shared = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const records: ParseRecord[] = [
    { metadata: new Metadata(), content: "a", embeddedResourcePath: "/", depth: 0, mediaType: MediaType.TEXT_PLAIN, exception: null },
    {
      metadata: new Metadata(),
      content: "b",
      embeddedResourcePath: "/x",
      pathParts: [{ name: "x" }] as never,
      depth: 1,
      mediaType: MediaType.OCTET_STREAM,
      exception: new MalformedDocumentError("bad"),
      handlerType: "xml",
      bytes: shared.subarray(2, 4),
    },
  ];
  const { records: encoded, transfer } = encodeRecords(records);
  assert.equal(transfer.length, 1);
  assert.equal(transfer[0]!.byteLength, 2);
  const decoded = decodeRecords(structuredClone(encoded, { transfer }));
  assert.deepEqual([...decoded[1]!.bytes!], [3, 4]);
  assert.deepEqual([...shared], [1, 2, 3, 4, 5, 6]);
  assert.ok(decoded[1]!.exception instanceof MalformedDocumentError);
  assert.equal(decoded[0]!.exception, null);
  assert.deepEqual(decoded[1]!.pathParts, [{ name: "x" }]);
  assert.equal(decoded[1]!.handlerType, "xml");
  assert.ok(decoded[1]!.mediaType.equals(MediaType.OCTET_STREAM));
});

test("an input crosses as a copy of exactly its bytes, or as a path", () => {
  const backing = new Uint8Array([9, 8, 7, 6]);
  const view = wireInput(backing.subarray(1, 3));
  assert.deepEqual([...(view.input as Uint8Array)], [8, 7]);
  assert.equal(view.transfer[0]!.byteLength, 2);
  const buffer = new Uint8Array([5, 4]).buffer;
  const whole = wireInput(buffer);
  assert.notEqual(whole.transfer[0], buffer);
  assert.deepEqual(wireInput({ path: "/some/file" }), { input: { path: "/some/file" }, transfer: [] });
});

test("an input the pool cannot copy to a worker is refused", () => {
  assert.throws(() => wireInput(new Blob(["x"]) as never), TypeError);
  assert.throws(() => wireInput({ url: "https://example.com/" } as never), TypeError);
  assert.throws(() => wireInput((async function* () {})() as never), TypeError);
});

test("parse options cross without the signal; a password must be a string", () => {
  const signal = new AbortController().signal;
  assert.deepEqual(wireOptions({ filename: "a", signal, limits: { maxDepth: 3 }, unpackBytes: 9, onDocumentFailure: "record" }), {
    filename: "a",
    limits: { maxDepth: 3 },
    unpackBytes: 9,
    onDocumentFailure: "record",
  });
  assert.throws(() => wireOptions({ password: (() => "x") as never }), TypeError);
});

test("onEmbeddedLimit and emailHeaders cross to a worker", () => {
  assert.deepEqual(wireOptions({ onEmbeddedLimit: "truncate" }), { onEmbeddedLimit: "truncate" });
  assert.deepEqual(wireOptions({ emailHeaders: true }), { emailHeaders: true });
});

test("a worker is given every configuration section a ripstream is built from, and builds the same configuration", () => {
  const sections = {
    parsers: [{ name: "text-parser", params: {} }],
    detectors: [{ name: "default-detector", params: {} }],
    limits: { maxParseMillis: 5 },
    digest: { digests: [{ algorithm: "md5", encoding: "hex" }] },
    customMimeTypes: "/x/custom-mimetypes.xml",
  };
  const config = new RipstreamConfig({ ...sections, throwOnWriteLimit: true } as never);
  const spec = specOf({ config });
  const workerFields = Object.entries(CONFIG_FIELDS)
    .filter(([, where]) => where === "worker")
    .map(([name]) => name)
    .sort();
  assert.deepEqual(Object.keys(spec.sections ?? {}).sort(), workerFields);
  const rebuilt = new RipstreamConfig(structuredClone(spec.sections) as never);
  for (const field of workerFields) {
    assert.deepEqual((rebuilt as never)[field], (config as never)[field], field);
  }
});

test("every RipstreamConfig field is placed", () => {
  const config = new RipstreamConfig({});
  const fields = new Set<string>(Object.keys(config));
  for (let proto = Object.getPrototypeOf(config); proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (name !== "constructor" && descriptor.get !== undefined) fields.add(name);
    }
  }
  assert.ok(fields.size >= 14, `RipstreamConfig has ${fields.size} fields`);
  assert.deepEqual([...fields].filter((name) => !(name in CONFIG_FIELDS)), []);
});

test("a call's maxParseMillis wins over the pool's, which wins over the configuration's", () => {
  const spec = { limits: { maxParseMillis: 20 }, sections: { limits: { maxParseMillis: 30 } } };
  assert.equal(effectiveParseMillis(spec, { maxParseMillis: 10 }), 10);
  assert.equal(effectiveParseMillis(spec, {}), 20);
  assert.equal(effectiveParseMillis({ sections: spec.sections }, undefined), 30);
  assert.equal(effectiveParseMillis({}, undefined), core.DEFAULT_LIMITS.maxParseMillis);
  assert.equal(effectiveParseMillis(spec, { maxParseMillis: 0 }), 0);
});

test("a ParseTimeoutError and an AbortError keep their classes", () => {
  assert.ok(roundTrip(new ParseTimeoutError()) instanceof ParseTimeoutError);
  assert.ok(roundTrip(new AbortError("stop")) instanceof AbortError);
});
