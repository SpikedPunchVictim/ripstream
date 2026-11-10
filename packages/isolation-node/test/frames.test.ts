import assert from "node:assert/strict";
import { test } from "node:test";
import { IsolationError } from "@spikedpunch/ripstream-core";
import {
  DEFAULT_MAX_FRAMES,
  DEFAULT_MAX_METADATA_KEYS,
  DEFAULT_MAX_METADATA_VALUES,
  FrameReader,
  type Frame,
  type FrameEvent,
  type FrameReaderOptions,
} from "../src/frames.ts";

const enc = new TextEncoder();
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const bytes = (text: string): Uint8Array => enc.encode(text);

const READY = { t: "ready", pid: 42 };
const META = { t: "meta", metadata: { a: ["1"] } };
const DONE = { t: "done" };
const RECORD = {
  metadata: { "dc:title": ["T"] },
  content: "hello",
  embeddedResourcePath: "/a.txt",
  depth: 1,
  mediaType: "text/plain",
  exception: null,
};

function reader(options: Partial<FrameReaderOptions> = {}): FrameReader {
  return new FrameReader({ maxTotalBytes: 10_000_000, output: "text", ...options });
}

function recordsReader(options: Partial<FrameReaderOptions> = {}): FrameReader {
  return reader({ output: "records", ...options });
}

function feedAll(r: FrameReader, text: string): FrameEvent[] {
  return r.push(bytes(text));
}

function feedByByte(r: FrameReader, data: Uint8Array): FrameEvent[] {
  const events: FrameEvent[] = [];
  for (const byte of data) events.push(...r.push(Uint8Array.of(byte)));
  return events;
}

function frames(events: FrameEvent[]): Frame[] {
  return events.flatMap((event) => (event.type === "frame" ? [event.frame] : []));
}

function violationKinds(events: FrameEvent[]): string[] {
  return events.flatMap((event) => (event.type === "violation" ? [event.kind] : []));
}

// ---- happy path --------------------------------------------------------------

test("text output accepts ready, meta, text..., done", () => {
  const input = [READY, { t: "meta", metadata: { a: ["1", "2"] } }, { t: "text", chunk: "abc" }, DONE].map(line).join("");
  assert.deepEqual(
    frames(feedAll(reader(), input)).map((f) => f.t),
    ["ready", "meta", "text", "done"],
  );
});

test("records output accepts ready, record..., done", () => {
  const input = [READY, { t: "record", record: RECORD }, { t: "record", record: RECORD }, DONE].map(line).join("");
  assert.deepEqual(
    frames(feedAll(recordsReader(), input)).map((f) => f.t),
    ["ready", "record", "record", "done"],
  );
});

test("returns the validated frame content", () => {
  const [frame] = frames(feedAll(reader(), line(READY)));
  assert.deepEqual(frame, { t: "ready", pid: 42 });
});

test("a record with an exception and code is accepted", () => {
  const exception = { name: "Err", message: "m", code: "C" };
  const events = feedAll(recordsReader(), line(READY) + line({ t: "record", record: { ...RECORD, exception } }));
  assert.deepEqual(frames(events)[1], { t: "record", record: { ...RECORD, exception } });
});

test("multiple frames in one chunk are all returned", () => {
  assert.equal(frames(feedAll(reader(), line(READY) + line(META) + line(DONE))).length, 3);
});

test("a frame is not returned until its newline arrives", () => {
  const r = reader();
  assert.deepEqual(r.push(bytes(JSON.stringify(READY))), []);
});

test("a frame is returned when its newline arrives in a later chunk", () => {
  const r = reader();
  r.push(bytes(JSON.stringify(READY)));
  assert.equal(frames(r.push(bytes("\n"))).length, 1);
});

const WHOLE_TEXT = [
  READY,
  { t: "meta", metadata: { "kéy": ["v\u{1F600}"] } },
  { t: "text", chunk: "é€\u{1F600}" },
  DONE,
]
  .map(line)
  .join("");

const WHOLE_RECORDS = [READY, { t: "record", record: { ...RECORD, content: "é€\u{1F600}" } }, DONE].map(line).join("");

for (const [label, whole, make] of [
  ["text", WHOLE_TEXT, reader],
  ["records", WHOLE_RECORDS, recordsReader],
] as const) {
  test(`${label}: feeding one byte at a time yields the same frames as feeding everything`, () => {
    const expected = feedAll(make(), whole);
    assert.deepEqual(feedByByte(make(), bytes(whole)), expected);
  });

  test(`${label}: splitting the stream at every byte boundary yields the same frames and result`, () => {
    const data = bytes(whole);
    const whole1 = make();
    const expected = feedAll(whole1, whole);
    for (let cut = 1; cut < data.length; cut++) {
      const r = make();
      const events = [...r.push(data.subarray(0, cut)), ...r.push(data.subarray(cut))];
      assert.deepEqual(events, expected, `cut at ${cut}`);
      assert.deepEqual(r.result(), whole1.result(), `result, cut at ${cut}`);
    }
  });
}

test("a reused input buffer does not corrupt a pending partial line", () => {
  const r = reader();
  const buffer = bytes(`${JSON.stringify(READY).slice(0, 6)}`);
  r.push(buffer);
  buffer.fill(0x7a);
  assert.equal(frames(r.push(bytes(`${JSON.stringify(READY).slice(6)}\n`))).length, 1);
});

// ---- per-frame cap -------------------------------------------------------------

test("a line of exactly maxFrameBytes is accepted", () => {
  const text = JSON.stringify({ t: "text", chunk: "x".repeat(100) });
  const r = reader({ maxFrameBytes: text.length });
  r.push(bytes(line(READY) + line(META)));
  assert.equal(frames(r.push(bytes(`${text}\n`))).length, 1);
});

test("a line one byte over maxFrameBytes is a frame_too_large violation", () => {
  const text = JSON.stringify({ t: "text", chunk: "x".repeat(100) });
  const r = reader({ maxFrameBytes: text.length - 1 });
  assert.deepEqual(violationKinds(r.push(bytes(`${text}\n`))), ["frame_too_large"]);
});

test("an unterminated line over the cap is a violation immediately, without a newline", () => {
  const r = reader({ maxFrameBytes: 100 });
  assert.deepEqual(violationKinds(r.push(new Uint8Array(101).fill(0x78))), ["frame_too_large"]);
});

test("the cap accumulates across chunks of the same line", () => {
  const r = reader({ maxFrameBytes: 100 });
  r.push(new Uint8Array(60).fill(0x78));
  assert.deepEqual(violationKinds(r.push(new Uint8Array(41).fill(0x78))), ["frame_too_large"]);
});

test("the cap applies before JSON.parse: garbage over the cap is frame_too_large, not protocol", () => {
  const r = reader({ maxFrameBytes: 10 });
  assert.deepEqual(violationKinds(r.push(bytes("not json at all\n"))), ["frame_too_large"]);
});

test("the per-frame count resets after each newline", () => {
  const r = reader({ maxFrameBytes: 30 });
  const meta = { t: "meta", metadata: {} }; // 26 bytes
  const text = { t: "text", chunk: "a" }; // 24 bytes per line; the lines together are far over 30
  assert.deepEqual(violationKinds(feedAll(r, line(READY) + line(meta) + line(text) + line(text))), []);
});

test("default per-frame cap is 1 MiB", () => {
  const r = reader();
  assert.deepEqual(violationKinds(r.push(new Uint8Array(1024 * 1024 + 1).fill(0x78))), ["frame_too_large"]);
});

test("a hostile 64 MiB single line is rejected on the first chunks, not buffered", () => {
  const r = reader({ maxFrameBytes: 1024 });
  const chunk = new Uint8Array(65_536).fill(0x30);
  const kinds: string[] = [];
  for (let index = 0; index < 1024 && kinds.length === 0; index++) kinds.push(...violationKinds(r.push(chunk)));
  assert.deepEqual(kinds, ["frame_too_large"]);
});

// ---- total cap -------------------------------------------------------------------

test("total cap counts every byte, newlines included, and allows exactly the cap", () => {
  const input = line(READY) + line(META) + line(DONE);
  const r = reader({ maxTotalBytes: input.length });
  assert.deepEqual(violationKinds(feedAll(r, input)), []);
});

test("one byte past the total cap is a total_too_large violation", () => {
  const input = line(READY) + line(META) + line(DONE);
  const r = reader({ maxTotalBytes: input.length - 1 });
  assert.deepEqual(violationKinds(feedAll(r, input)), ["total_too_large"]);
});

test("frames completed before the total cap is hit are still delivered", () => {
  const first = line(READY);
  const r = reader({ maxTotalBytes: first.length + 3 });
  const events = feedAll(r, first + line(DONE));
  assert.deepEqual(
    events.map((event) => (event.type === "frame" ? event.frame.t : event.kind)),
    ["ready", "total_too_large"],
  );
});

test("total cap accumulates across chunks", () => {
  const r = reader({ maxTotalBytes: 100, maxFrameBytes: 100 });
  r.push(bytes(line(READY)));
  assert.deepEqual(violationKinds(r.push(new Uint8Array(100).fill(0x20))), ["total_too_large"]);
});

test("a violation inside the allowed prefix wins over total_too_large in the same chunk", () => {
  const r = reader({ maxTotalBytes: 30 });
  assert.deepEqual(violationKinds(r.push(bytes('{"t":"nope"}\n' + "x".repeat(100)))), ["protocol"]);
});

// ---- protocol violations ---------------------------------------------------------

test("malformed JSON is a protocol violation", () => {
  assert.deepEqual(violationKinds(feedAll(reader(), "{nope\n")), ["protocol"]);
});

test("an empty line is a protocol violation", () => {
  assert.deepEqual(violationKinds(feedAll(reader(), "\n")), ["protocol"]);
});

test("invalid UTF-8 is a protocol violation", () => {
  const r = reader();
  assert.deepEqual(violationKinds(r.push(Uint8Array.of(0x7b, 0xff, 0x7d, 0x0a))), ["protocol"]);
});

test("a CRLF-terminated frame is a protocol violation", () => {
  assert.deepEqual(violationKinds(feedAll(reader(), `${JSON.stringify(READY)}\r\n`)), ["protocol"]);
});

const notFrames: [string, unknown][] = [
  ["unknown t", { t: "hello" }],
  ["missing t", { pid: 1 }],
  ["numeric t", { t: 1 }],
  ["array", []],
  ["null", null],
  ["string", "ready"],
  ["number", 7],
  ["ready without pid", { t: "ready" }],
  ["ready with string pid", { t: "ready", pid: "1" }],
  ["ready with zero pid", { t: "ready", pid: 0 }],
  ["ready with float pid", { t: "ready", pid: 1.5 }],
  ["ready with extra field", { t: "ready", pid: 1, x: 1 }],
];

for (const [label, value] of notFrames) {
  test(`${label} is a protocol violation`, () => {
    assert.deepEqual(violationKinds(feedAll(reader(), line(value))), ["protocol"]);
  });
}

const afterReady: [string, unknown][] = [
  ["meta with array", { t: "meta", metadata: [] }],
  ["meta missing metadata", { t: "meta" }],
  ["meta value not an array", { t: "meta", metadata: { a: "x" } }],
  ["meta array of numbers", { t: "meta", metadata: { a: [1] } }],
  ["meta with extra field", { t: "meta", metadata: {}, x: 1 }],
  ["meta with a string exception", { t: "meta", metadata: {}, exception: "boom" }],
  ["meta with a null exception", { t: "meta", metadata: {}, exception: null }],
  ["meta with an exception that has no message", { t: "meta", metadata: {}, exception: { name: "E" } }],
  ["meta with an exception with an extra field", { t: "meta", metadata: {}, exception: { name: "E", message: "m", stack: "s" } }],
  ["text without chunk", { t: "text" }],
  ["text with numeric chunk", { t: "text", chunk: 5 }],
  ["done with extra field", { t: "done", x: 1 }],
  ["error with unknown kind", { t: "error", kind: "weird", message: "m" }],
  ["error with a class name", { t: "error", kind: "limit", message: "m", name: "LimitExceededError" }],
  ["error with no message", { t: "error", kind: "limit" }],
  ["error with numeric code", { t: "error", kind: "limit", message: "m", code: 5 }],
  ["record frame without record", { t: "record" }],
  ["record with extra frame field", { t: "record", record: RECORD, x: 1 }],
  ["record with extra record field", { t: "record", record: { ...RECORD, x: 1 } }],
  ["record with non-string content", { t: "record", record: { ...RECORD, content: 1 } }],
  ["record with non-string path", { t: "record", record: { ...RECORD, embeddedResourcePath: null } }],
  ["record with non-string mediaType", { t: "record", record: { ...RECORD, mediaType: 1 } }],
  ["record with negative depth", { t: "record", record: { ...RECORD, depth: -1 } }],
  ["record with float depth", { t: "record", record: { ...RECORD, depth: 0.5 } }],
  ["record with string depth", { t: "record", record: { ...RECORD, depth: "1" } }],
  ["record with bad metadata", { t: "record", record: { ...RECORD, metadata: { a: [1] } } }],
  ["record with missing metadata", { t: "record", record: { ...RECORD, metadata: undefined } }],
  ["record with undefined exception", { t: "record", record: { ...RECORD, exception: undefined } }],
  ["record with string exception", { t: "record", record: { ...RECORD, exception: "boom" } }],
  ["record exception without message", { t: "record", record: { ...RECORD, exception: { name: "E" } } }],
  [
    "record exception with numeric code",
    { t: "record", record: { ...RECORD, exception: { name: "E", message: "m", code: 1 } } },
  ],
  [
    "record exception with extra field",
    { t: "record", record: { ...RECORD, exception: { name: "E", message: "m", x: 1 } } },
  ],
];

/** Feeds the frames that make `value` in order, so its SHAPE is what is wrong with it, not its position. */
function afterPrelude(value: unknown): FrameReader {
  const t = (value as { t?: unknown }).t;
  const r = t === "record" ? recordsReader() : reader();
  r.push(bytes(line(READY)));
  if (t === "text" || t === "done") r.push(bytes(line(META)));
  return r;
}

for (const [label, value] of afterReady) {
  test(`${label} is a protocol violation`, () => {
    const r = afterPrelude(value);
    assert.deepEqual(violationKinds(r.push(bytes(line(value)))), ["protocol"]);
  });
}

const beforeReady: [string, unknown][] = [
  ["meta", { t: "meta", metadata: {} }],
  ["text", { t: "text", chunk: "x" }],
  ["record", { t: "record", record: RECORD }],
  ["done", DONE],
  ["error", { t: "error", kind: "crash", message: "m" }],
];

for (const [label, value] of beforeReady) {
  test(`${label} frame before ready is a protocol violation`, () => {
    assert.deepEqual(violationKinds(feedAll(reader(), line(value))), ["protocol"]);
  });
}

test("a second ready frame is a protocol violation", () => {
  assert.deepEqual(violationKinds(feedAll(reader(), line(READY) + line(READY))), ["protocol"]);
});

// The terminal verdict is final. Whatever follows it in the stream is IGNORED, not a violation: the supervisor
// has already acted on the terminal frame and will group-kill the child after its grace period, and a violation
// at that point could only throw away a result that was already complete (see the R1 tests below).
for (const [label, terminal] of [
  ["done", DONE],
  ["error", { t: "error", kind: "crash", message: "m" }],
] as const) {
  for (const [nextLabel, next] of [
    ["text", { t: "text", chunk: "x" }],
    ["done", DONE],
    ["ready", READY],
  ] as const) {
    test(`${nextLabel} frame after ${label} is ignored: no event, no violation`, () => {
      const r = reader();
      const events = feedAll(r, line(READY) + line(META) + line(terminal) + line(next));
      assert.deepEqual(violationKinds(events), []);
      assert.deepEqual(frames(events).map((frame) => frame.t), ["ready", "meta", label]);
      assert.equal(r.violation, null);
      assert.equal(r.terminal, label);
      assert.deepEqual(feedAll(r, line(next)), []); // and later pushes too
    });
  }
}

test("a stream ending inside a frame is a protocol violation on finish", () => {
  const r = reader();
  r.push(bytes(JSON.stringify(READY)));
  assert.deepEqual(violationKinds(r.finish()), ["protocol"]);
});

test("finish after a complete frame reports nothing", () => {
  const r = reader();
  feedAll(r, line(READY));
  assert.deepEqual(r.finish(), []);
});

const PROTO_META = '{"t":"meta","metadata":{"__proto__":["x"],"constructor":["y"],"ok":["z"]}}\n';

test("a __proto__ metadata key is dropped from a meta frame; constructor and other keys stay", () => {
  const r = reader();
  r.push(bytes(line(READY)));
  const [frame] = frames(r.push(bytes(PROTO_META)));
  assert.ok(frame?.t === "meta");
  assert.deepEqual(Object.keys(frame.metadata), ["constructor", "ok"]);
  assert.equal(Object.getPrototypeOf(frame.metadata), Object.prototype);
});

test("a later Object.assign of the metadata cannot swap the target's prototype", () => {
  const r = reader();
  r.push(bytes(line(READY) + PROTO_META + line(DONE)));
  const target: Record<string, unknown> = {};
  const result = r.result();
  Object.assign(target, result.kind === "text" ? result.metadata : {});
  assert.equal(Object.getPrototypeOf(target), Object.prototype);
  assert.deepEqual(Object.keys(target), ["constructor", "ok"]);
});

test("a __proto__ key in record metadata is dropped too", () => {
  // JSON.stringify would not emit a __proto__ own key, so splice the raw text in.
  const withProto = JSON.stringify({ t: "record", record: { ...RECORD, metadata: {} } }).replace(
    '"metadata":{}',
    '"metadata":{"__proto__":["x"],"k":["v"]}',
  );
  assert.match(withProto, /"__proto__"/);
  const text = `${withProto}\n`;
  const r = recordsReader();
  r.push(bytes(line(READY)));
  const [frame] = frames(r.push(bytes(text)));
  assert.ok(frame?.t === "record");
  assert.deepEqual(Object.keys(frame.record.metadata), ["k"]);
  assert.equal(Object.getPrototypeOf(frame.record.metadata), Object.prototype);
});

test("metadata with a __proto__ key does not pollute Object.prototype", () => {
  const r = reader();
  r.push(bytes(line(READY)));
  r.push(bytes(PROTO_META));
  assert.equal(({} as Record<string, unknown>).length, undefined);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

// ---- terminal behaviour ----------------------------------------------------------

test("after a violation all further input is ignored", () => {
  const r = reader();
  feedAll(r, "garbage\n");
  assert.deepEqual(feedAll(r, line(READY)), []);
});

test("finish after a violation reports nothing more", () => {
  const r = reader();
  feedAll(r, "garbage\n");
  assert.deepEqual(r.finish(), []);
});

test("the violation is exposed on the reader", () => {
  const r = reader();
  feedAll(r, "garbage\n");
  assert.equal(r.violation?.kind, "protocol");
});

test("frames before the violating line in the same chunk are returned", () => {
  const events = feedAll(reader(), line(READY) + "garbage\n" + line(DONE));
  assert.deepEqual(
    events.map((event) => (event.type === "frame" ? event.frame.t : event.kind)),
    ["ready", "protocol"],
  );
});

test("phase is pre-ready until the ready frame arrives", () => {
  const r = reader();
  assert.equal(r.phase, "pre-ready");
});

test("phase is post-ready after the ready frame", () => {
  const r = reader();
  feedAll(r, line(READY));
  assert.equal(r.phase, "post-ready");
});

test("terminal is null until done or error", () => {
  const r = reader();
  feedAll(r, line(READY));
  assert.equal(r.terminal, null);
});

test("terminal is done after the done frame", () => {
  const r = reader();
  feedAll(r, line(READY) + line(META) + line(DONE));
  assert.equal(r.terminal, "done");
});

test("terminal is error and errorFrame is kept after an error frame", () => {
  const r = reader();
  feedAll(r, line(READY) + line({ t: "error", kind: "limit", message: "boom", code: "X" }));
  assert.deepEqual([r.terminal, r.errorFrame], ["error", { t: "error", kind: "limit", message: "boom", code: "X" }]);
});

test("bytes after the terminal frame are ignored, whatever they are: terminal stays set, no violation", () => {
  const r = reader();
  feedAll(r, line(READY) + line(META) + line(DONE) + "garbage\n");
  assert.equal(r.terminal, "done");
  assert.equal(r.violation, null);
  assert.deepEqual(r.finish(), []);
});

// ---- R1: a terminal frame is final; later input can never discard the folded result -----------------------

const TEXT_ABC = { t: "text", chunk: "IMPORTANT CONTENT" };
const LATE = { t: "text", chunk: "late" };

for (const [label, tail] of [
  ["a late text frame", line(LATE)],
  ["garbage", "garbage\n"],
  ["a frame that is not JSON", "{not json\n"],
  ["a second ready", line(READY)],
  ["a carriage return", "\r\n"],
  ["a partial line with no newline", '{"t":"te'],
] as const) {
  test(`text: ${label} in the SAME push as done leaves the result intact`, () => {
    const r = reader();
    const events = feedAll(r, line(READY) + line(META) + line(TEXT_ABC) + line(DONE) + tail);
    assert.deepEqual(violationKinds(events), []);
    assert.deepEqual(r.finish(), []);
    assert.deepEqual(r.result(), { kind: "text", metadata: { a: ["1"] }, text: "IMPORTANT CONTENT" });
  });

  test(`records: ${label} in the SAME push as done leaves the result intact`, () => {
    const r = recordsReader();
    const events = feedAll(r, line(READY) + line({ t: "record", record: RECORD }) + line(DONE) + tail);
    assert.deepEqual(violationKinds(events), []);
    assert.deepEqual(r.finish(), []);
    assert.deepEqual(r.result(), { kind: "records", records: [RECORD] });
  });
}

test("text: the failure of a document that could not be read rides on the meta frame into the result", () => {
  const exception = { name: "ZeroByteFileError", message: "InputStream must have > 0 bytes", code: "MALFORMED_DOCUMENT" };
  const r = reader();
  const events = feedAll(r, line(READY) + line({ ...META, exception }) + line(TEXT_ABC) + line(DONE));
  assert.deepEqual(violationKinds(events), []);
  assert.deepEqual(r.result(), { kind: "text", metadata: { a: ["1"] }, text: "IMPORTANT CONTENT", exception });
});

test("text: a result with no failure has no exception key", () => {
  const r = reader();
  feedAll(r, line(READY) + line(META) + line(DONE));
  assert.equal("exception" in r.result(), false);
});

test("text: done followed by bytes that cross the TOTAL cap in the same chunk: result intact, no total_too_large", () => {
  const head = line(READY) + line(META) + line(TEXT_ABC) + line(DONE);
  const r = reader({ maxTotalBytes: head.length + 10 });
  const events = feedAll(r, head + "x".repeat(5000));
  assert.deepEqual(violationKinds(events), []);
  assert.equal(r.violation, null);
  assert.deepEqual(r.result(), { kind: "text", metadata: { a: ["1"] }, text: "IMPORTANT CONTENT" });
});

test("records: done followed by bytes that cross the TOTAL cap in the same chunk: result intact", () => {
  const head = line(READY) + line({ t: "record", record: RECORD }) + line(DONE);
  const r = recordsReader({ maxTotalBytes: head.length + 10 });
  const events = feedAll(r, head + "x".repeat(5000));
  assert.deepEqual(violationKinds(events), []);
  assert.deepEqual(r.result(), { kind: "records", records: [RECORD] });
});

test("done followed by an OVERSIZE line (over maxFrameBytes) in the same chunk: result intact, no frame_too_large", () => {
  const head = line(READY) + line(META) + line(TEXT_ABC) + line(DONE);
  const r = reader({ maxFrameBytes: 200 });
  const events = feedAll(r, head + "y".repeat(5000) + "\n");
  assert.deepEqual(violationKinds(events), []);
  assert.deepEqual(r.result(), { kind: "text", metadata: { a: ["1"] }, text: "IMPORTANT CONTENT" });
});

test("bytes after done arriving in LATER pushes (a trickle, a flood) change nothing", () => {
  const r = reader({ maxTotalBytes: 400 });
  feedAll(r, line(READY) + line(META) + line(TEXT_ABC) + line(DONE));
  for (let index = 0; index < 100; index++) {
    assert.deepEqual(r.push(bytes("z".repeat(1000))), []);
    assert.deepEqual(r.push(bytes("garbage\n")), []);
  }
  assert.deepEqual(r.finish(), []);
  assert.equal(r.violation, null);
  assert.equal(r.partialLineCapacity, 0, "ignored bytes are not buffered");
  assert.deepEqual(r.result(), { kind: "text", metadata: { a: ["1"] }, text: "IMPORTANT CONTENT" });
});

test("an error frame is final too: later bytes cannot turn it into a violation", () => {
  const r = reader();
  const errorLine = line({ t: "error", kind: "limit", message: "too big" });
  const events = feedAll(r, line(READY) + errorLine + "garbage\n" + line(DONE));
  assert.deepEqual(violationKinds(events), []);
  assert.equal(r.terminal, "error");
  assert.equal(r.errorFrame?.kind, "limit");
});

for (const kind of ["limit", "timeout", "malformed", "abort", "crash"]) {
  test(`error kind "${kind}" is accepted`, () => {
    const r = reader();
    feedAll(r, line(READY) + line({ t: "error", kind, message: "m" }));
    assert.equal(r.errorFrame?.kind, kind);
  });
}

test("a violation does not set the ready phase", () => {
  const r = reader();
  feedAll(r, line(DONE));
  assert.equal(r.phase, "pre-ready");
});

// ---- constructor -------------------------------------------------------------------

for (const [label, options] of [
  ["zero maxFrameBytes", { maxFrameBytes: 0, maxTotalBytes: 10 }],
  ["float maxFrameBytes", { maxFrameBytes: 1.5, maxTotalBytes: 10 }],
  ["zero maxTotalBytes", { maxTotalBytes: 0 }],
  ["NaN maxTotalBytes", { maxTotalBytes: Number.NaN }],
  ["missing maxTotalBytes", { output: "text" }],
  ["zero maxFrames", { maxTotalBytes: 10, output: "text", maxFrames: 0 }],
  ["float maxMetadataKeys", { maxTotalBytes: 10, output: "text", maxMetadataKeys: 1.5 }],
  ["zero maxMetadataValues", { maxTotalBytes: 10, output: "text", maxMetadataValues: 0 }],
] as const) {
  test(`constructor rejects ${label}`, () => {
    assert.throws(() => new FrameReader(options as unknown as FrameReaderOptions), RangeError);
  });
}

test("constructor rejects an unknown output", () => {
  assert.throws(() => new FrameReader({ maxTotalBytes: 10, output: "html" as "text" }), TypeError);
});

// ---- sequence rules, enforced as the frames arrive ----------------------------------------

type Mode = "text" | "records";
const rec = (content: string) => ({ t: "record", record: { ...RECORD, content } });
const textFrame = (chunk: string) => ({ t: "text", chunk });
const ERROR_FRAME = { t: "error", kind: "crash", message: "m" };

function feedFrames(mode: Mode, sequence: unknown[]): { r: FrameReader; events: FrameEvent[] } {
  const r = reader({ output: mode });
  return { r, events: r.push(bytes(sequence.map(line).join(""))) };
}

const badSequences: [string, Mode, unknown[], RegExp][] = [
  ["text requested, record received", "text", [READY, rec("x")], /record/],
  ["records requested, text received", "records", [READY, META, textFrame("x")], /meta/],
  ["records requested, meta received", "records", [READY, META], /meta/],
  ["text requested, no meta before text", "text", [READY, textFrame("x")], /text/],
  ["text with two meta frames", "text", [READY, META, META], /meta/],
  ["text with two meta frames, text between", "text", [READY, META, textFrame("x"), META], /meta/],
  ["text with no meta at done", "text", [READY, DONE], /meta/],
];

for (const [label, mode, sequence, pattern] of badSequences) {
  test(`${label}: a protocol violation at the offending frame, not at the end`, () => {
    const { r, events } = feedFrames(mode, sequence);
    assert.deepEqual(violationKinds(events), ["protocol"]);
    assert.match(r.violation?.message ?? "", pattern);
    assert.equal(events.at(-1)?.type, "violation", "the offending frame is the last event");
  });
}

test("an error terminal is accepted before any meta (the child failed before it had metadata)", () => {
  const { r, events } = feedFrames("text", [READY, ERROR_FRAME]);
  assert.deepEqual(violationKinds(events), []);
  assert.equal(r.terminal, "error");
});

test("an error terminal is accepted in records mode after some records", () => {
  const { r, events } = feedFrames("records", [READY, rec("a"), ERROR_FRAME]);
  assert.deepEqual(violationKinds(events), []);
  assert.equal(r.terminal, "error");
});

// ---- result() --------------------------------------------------------------------------

test("text result concatenates chunks in order and carries metadata", () => {
  const { r } = feedFrames("text", [READY, META, textFrame("ab"), textFrame("cd"), DONE]);
  assert.deepEqual(r.result(), { kind: "text", metadata: { a: ["1"] }, text: "abcd" });
});

test("text result with no text chunks yields empty text; empty chunks add nothing", () => {
  const { r } = feedFrames("text", [READY, META, textFrame(""), textFrame("x"), textFrame(""), DONE]);
  assert.deepEqual(r.result(), { kind: "text", metadata: { a: ["1"] }, text: "x" });
  assert.equal(feedFrames("text", [READY, META, DONE]).r.result().kind, "text");
});

test("records result keeps records in order; zero records is a valid result", () => {
  const { r } = feedFrames("records", [READY, rec("one"), rec("two"), DONE]);
  const result = r.result();
  assert.deepEqual(result.kind === "records" && result.records.map((x) => x.content), ["one", "two"]);
  assert.deepEqual(feedFrames("records", [READY, DONE]).r.result(), { kind: "records", records: [] });
});

for (const [label, mode, sequence] of [
  ["no frames at all", "text", []],
  ["only ready", "text", [READY]],
  ["ready and meta, no done", "text", [READY, META]],
  ["an error terminal", "text", [READY, ERROR_FRAME]],
  ["records without done", "records", [READY, rec("x")]],
] as [string, Mode, unknown[]][]) {
  test(`result() on ${label} throws IsolationError crash`, () => {
    const { r } = feedFrames(mode, sequence);
    assert.throws(
      () => r.result(),
      (error: unknown) => error instanceof IsolationError && error.reason === "crash",
    );
  });
}

test("the reader keeps no per-frame objects: many tiny text frames fold into one result", () => {
  const r = reader();
  r.push(bytes(line(READY) + line(META)));
  const frame = bytes(line(textFrame("a")));
  for (let i = 0; i < 50_000; i++) r.push(frame);
  r.push(bytes(line(DONE)));
  const result = r.result();
  assert.equal(result.kind === "text" && result.text.length, 50_000);
  assert.equal(r.frameCount, 50_003);
});

// ---- bounded memory: partial lines, frame counts, metadata ---------------------------------

test("a partial line lives in ONE buffer that grows with its bytes, not with the number of chunks", () => {
  const r = reader({ maxFrameBytes: 1024 * 1024 });
  const one = Uint8Array.of(0x20);
  const pushes = 100_000;
  for (let i = 0; i < pushes; i++) r.push(one);
  assert.ok(r.partialLineCapacity >= pushes, "holds every byte");
  assert.ok(r.partialLineCapacity <= 2 * pushes + 4096, `${r.partialLineCapacity} bytes allocated for ${pushes} bytes`);
});

test("a partial line grows by doubling: 200k one-byte writes allocate a handful of buffers, not 200k", () => {
  const r = reader({ maxFrameBytes: 1024 * 1024 });
  const one = Uint8Array.of(0x20);
  for (let i = 0; i < 200_000; i++) r.push(one);
  // 4 KiB doubling up to 256 KiB is 7 allocations; leave room, but nowhere near one per write.
  assert.ok(r.partialLineAllocations >= 1, "the counter counts");
  assert.ok(r.partialLineAllocations <= 12, `${r.partialLineAllocations} buffers allocated for 200000 writes`);
});

test("a partial line that fits the initial buffer allocates exactly once", () => {
  const r = reader();
  for (let i = 0; i < 1000; i++) r.push(Uint8Array.of(0x20));
  assert.equal(r.partialLineAllocations, 1);
});

for (const output of ["text", "records"] as const) {
  test(`after a violation the reader retains nothing large (${output}): no partial line, no folded pieces`, () => {
    const r = reader({ output, maxFrameBytes: 512 * 1024 });
    const head =
      output === "text"
        ? line(READY) + line(META) + line({ t: "text", chunk: "x".repeat(1000) }).repeat(500)
        : line(READY) + line({ t: "record", record: RECORD }).repeat(500);
    assert.deepEqual(violationKinds(feedAll(r, head)), []);
    assert.equal(r.retainedPieces, 500, "the folded result is held while the stream is healthy");
    // A partial line of 300 KB makes the buffer large, then the next push overflows maxFrameBytes.
    r.push(new Uint8Array(300 * 1024).fill(0x20));
    assert.ok(r.partialLineCapacity >= 300 * 1024);
    const events = r.push(new Uint8Array(300 * 1024).fill(0x20));
    assert.deepEqual(violationKinds(events), ["frame_too_large"]);
    assert.equal(r.partialLineCapacity, 0, "the partial-line buffer was released");
    assert.equal(r.retainedPieces, 0, "the folded pieces were released");
  });
}

test("empty text chunks are not retained: 100k of them add nothing to the folded result", () => {
  const r = reader();
  feedAll(r, line(READY) + line(META));
  const empty = bytes(line({ t: "text", chunk: "" }));
  for (let i = 0; i < 100_000; i++) r.push(empty);
  assert.equal(r.frameCount, 100_002, "they are frames and count towards maxFrames");
  assert.equal(r.retainedPieces, 0, "but nothing is kept for them");
  feedAll(r, line(TEXT_ABC) + line(DONE));
  assert.deepEqual(r.result(), { kind: "text", metadata: { a: ["1"] }, text: "IMPORTANT CONTENT" });
});

test("a byte-at-a-time partial line still produces the frame when it completes", () => {
  const r = reader();
  assert.equal(frames(feedByByte(r, bytes(line(READY)))).length, 1);
});

test("a pending partial line is not corrupted by a later, longer line", () => {
  const r = reader();
  r.push(bytes(line(READY)));
  r.push(bytes(`{"t":"meta","metad`));
  const events = r.push(bytes(`ata":{"a":["1"]}}\n{"t":"text","chunk":"hello"}\n{"t":"te`));
  assert.deepEqual(frames(events).map((f) => f.t), ["meta", "text"]);
  assert.deepEqual(frames(r.push(bytes(`xt","chunk":"!"}\n`))).map((f) => f.t), ["text"]);
});

test("more frames than maxFrames is a protocol violation at the first excess frame", () => {
  const r = reader({ maxFrames: 5 });
  const events = r.push(bytes(line(READY) + line(META) + [1, 2, 3, 4].map((n) => line(textFrame(String(n)))).join("")));
  assert.deepEqual(frames(events).length, 5);
  assert.deepEqual(violationKinds(events), ["protocol"]);
  assert.match(r.violation?.message ?? "", /more than 5 frames/);
});

test("exactly maxFrames frames is fine", () => {
  const r = reader({ maxFrames: 4 });
  assert.deepEqual(violationKinds(r.push(bytes(line(READY) + line(META) + line(textFrame("a")) + line(DONE)))), []);
});

test("the defaults are the documented values", () => {
  assert.deepEqual([DEFAULT_MAX_FRAMES, DEFAULT_MAX_METADATA_KEYS, DEFAULT_MAX_METADATA_VALUES], [1_000_000, 200_000, 1_000_000]);
});

function metadataWith(keys: number, valuesPerKey: number): Record<string, string[]> {
  const metadata: Record<string, string[]> = {};
  for (let k = 0; k < keys; k++) metadata[`k${k}`] = Array.from({ length: valuesPerKey }, (_, v) => `v${v}`);
  return metadata;
}

test("a meta frame with more keys than maxMetadataKeys is a metadata_cap violation", () => {
  const r = reader({ maxMetadataKeys: 10 });
  r.push(bytes(line(READY)));
  assert.deepEqual(violationKinds(r.push(bytes(line({ t: "meta", metadata: metadataWith(11, 1) })))), ["metadata_cap"]);
  assert.match(r.violation?.message ?? "", /more than 10 keys/);
});

test("a meta frame with exactly maxMetadataKeys keys is accepted", () => {
  const r = reader({ maxMetadataKeys: 10 });
  r.push(bytes(line(READY)));
  assert.deepEqual(violationKinds(r.push(bytes(line({ t: "meta", metadata: metadataWith(10, 1) })))), []);
});

test("a meta frame with more values than maxMetadataValues is a metadata_cap violation", () => {
  const r = reader({ maxMetadataValues: 20 });
  r.push(bytes(line(READY)));
  assert.deepEqual(violationKinds(r.push(bytes(line({ t: "meta", metadata: metadataWith(3, 7) })))), ["metadata_cap"]);
  assert.match(r.violation?.message ?? "", /more than 20 values/);
});

test("exactly maxMetadataValues values is accepted", () => {
  const r = reader({ maxMetadataValues: 20 });
  r.push(bytes(line(READY)));
  assert.deepEqual(violationKinds(r.push(bytes(line({ t: "meta", metadata: metadataWith(4, 5) })))), []);
});

test("record metadata is bounded the same way", () => {
  const r = recordsReader({ maxMetadataKeys: 3 });
  r.push(bytes(line(READY)));
  const events = r.push(bytes(line({ t: "record", record: { ...RECORD, metadata: metadataWith(4, 1) } })));
  assert.deepEqual(violationKinds(events), ["metadata_cap"]);
});

test("empty values do not slip past the value bound", () => {
  const r = reader({ maxMetadataValues: 5 });
  r.push(bytes(line(READY)));
  const metadata = { a: ["", "", "", "", "", ""] };
  assert.deepEqual(violationKinds(r.push(bytes(line({ t: "meta", metadata })))), ["metadata_cap"]);
});

test("a structurally wrong metadata object stays a protocol violation, not a cap", () => {
  const r = reader({ maxMetadataKeys: 3 });
  r.push(bytes(line(READY)));
  assert.deepEqual(violationKinds(r.push(bytes(line({ t: "meta", metadata: { a: "not-an-array" } })))), ["protocol"]);
});

test("a document with 80,000 metadata keys is accepted by the defaults (at the 8 MiB text frame cap the facade uses)", () => {
  const r = reader({ maxFrameBytes: 8 * 1024 * 1024 });
  r.push(bytes(line(READY)));
  assert.deepEqual(violationKinds(r.push(bytes(line({ t: "meta", metadata: metadataWith(80_000, 1) })))), []);
});

// ---- embedded bytes (records output, `unpackBytes`) ----------------------------

const b64 = (...values: number[]): string => Buffer.from(values).toString("base64");
const withBytes = (length: number): object => ({ t: "record", record: RECORD, byteLength: length });
const chunkFrame = (...values: number[]): object => ({ t: "bytes", chunk: b64(...values) });

function feedLines(r: FrameReader, frameList: readonly object[]): FrameEvent[] {
  return frameList.flatMap((frame) => feedAll(r, line(frame)));
}

test("bytes: a record announces its length and the bytes frames after it carry exactly that many, in pieces", () => {
  const r = recordsReader({ unpackBytes: 100 });
  const events = feedLines(r, [READY, withBytes(5), chunkFrame(1, 2), chunkFrame(3, 4, 5), { t: "record", record: RECORD }, DONE]);
  assert.deepEqual(violationKinds(events), []);
  const result = r.result();
  assert.equal(result.kind, "records");
  const records = result.kind === "records" ? result.records : [];
  assert.deepEqual([...(records[0]?.bytes ?? [])], [1, 2, 3, 4, 5]);
  assert.equal(records[1]?.bytes, undefined, "a record that announced nothing has no bytes");
});

test("bytes: an empty document announces 0 and has an empty array, with no bytes frame", () => {
  const r = recordsReader({ unpackBytes: 100 });
  feedLines(r, [READY, withBytes(0), DONE]);
  const result = r.result();
  assert.equal(result.kind === "records" ? result.records[0]?.bytes?.length : -1, 0);
});

test("bytes: the same stream arrives byte by byte just the same", () => {
  const r = recordsReader({ unpackBytes: 100 });
  const input = bytes([READY, withBytes(3), chunkFrame(7, 8, 9), DONE].map(line).join(""));
  assert.deepEqual(violationKinds(feedByByte(r, input)), []);
  const result = r.result();
  assert.deepEqual([...(result.kind === "records" ? (result.records[0]?.bytes ?? []) : [])], [7, 8, 9]);
});

const BAD_BYTES: ReadonlyArray<readonly [string, readonly object[], number | undefined, string, RegExp]> = [
  ["bytes announced when none were asked for", [READY, withBytes(1), chunkFrame(1)], undefined, "protocol", /bytes/],
  ["more than the budget in all", [READY, withBytes(60), chunkFrame(...Array(60).fill(1)), withBytes(60)], 100, "total_too_large", /100/],
  ["a bytes frame with nothing announced", [READY, { t: "record", record: RECORD }, chunkFrame(1)], 100, "protocol", /bytes/],
  ["a bytes frame past the announced length", [READY, withBytes(2), chunkFrame(1, 2, 3)], 100, "protocol", /bytes/],
  ["a record while bytes are still owed", [READY, withBytes(2), chunkFrame(1), { t: "record", record: RECORD }], 100, "protocol", /owed|bytes/],
  ["done while bytes are still owed", [READY, withBytes(2), chunkFrame(1), DONE], 100, "protocol", /owed|bytes/],
  ["a bytes frame before any record", [READY, chunkFrame(1)], 100, "protocol", /bytes/],
  ["an empty bytes frame", [READY, withBytes(1), { t: "bytes", chunk: "" }], 100, "protocol", /bytes/],
  ["a chunk that is not base64", [READY, withBytes(3), { t: "bytes", chunk: "not base64!" }], 100, "protocol", /base64/],
  ["a chunk with a bad tail", [READY, withBytes(3), { t: "bytes", chunk: "AQID=" }], 100, "protocol", /base64/],
  ["a chunk that is not a string", [READY, withBytes(1), { t: "bytes", chunk: 7 }], 100, "protocol", /chunk/],
  ["a negative length", [READY, withBytes(-1)], 100, "protocol", /byteLength/],
  ["a fractional length", [READY, withBytes(1.5)], 100, "protocol", /byteLength/],
  ["an extra field on a bytes frame", [READY, withBytes(1), { t: "bytes", chunk: b64(1), extra: 1 }], 100, "protocol", /unexpected/],
];

for (const [label, frameList, budget, kind, message] of BAD_BYTES) {
  test(`bytes: ${label} is a violation`, () => {
    const r = recordsReader({ ...(budget === undefined ? {} : { unpackBytes: budget }) });
    const events = feedLines(r, frameList);
    assert.deepEqual(violationKinds(events), [kind]);
    const violation = events.find((event) => event.type === "violation");
    assert.match(violation?.type === "violation" ? violation.message : "", message);
  });
}

test("bytes: a bytes frame on a text stream is a violation", () => {
  const events = feedLines(reader(), [READY, META, chunkFrame(1)]);
  assert.deepEqual(violationKinds(events), ["protocol"]);
});

test("bytes: a chunk of more than 256 KiB is refused whatever the budget", () => {
  const r = recordsReader({ unpackBytes: 10_000_000 });
  const big = Buffer.alloc(256 * 1024 + 3, 1).toString("base64");
  const events = feedLines(r, [READY, withBytes(256 * 1024 + 3), { t: "bytes", chunk: big }]);
  assert.deepEqual(violationKinds(events), ["protocol"]);
});

test("bytes: a violation drops what was folded, the bytes included", () => {
  const r = recordsReader({ unpackBytes: 100 });
  feedLines(r, [READY, withBytes(2), chunkFrame(1, 2), withBytes(500)]);
  assert.equal(r.retainedPieces, 0);
});

test("bytes: a bad unpackBytes option is refused", () => {
  for (const value of [-1, 1.5, Number.NaN]) assert.throws(() => recordsReader({ unpackBytes: value }), RangeError, String(value));
  assert.throws(() => reader({ unpackBytes: 5 }), TypeError);
});
