import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParseTimeoutError,
  Ripstream,
  XHTMLContentHandler,
  type ContentHandler,
  type Detector,
  type ParseContext,
  type Parser,
  type ParseRecord,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import type { ChildInput, InputHeader } from "../src/child-io.ts";
import {
  MAX_TEXT_CHUNK_CHARS,
  runChildMain,
  textChunks,
  type ChildMainIo,
  type ChildMainOptions,
  type ChildRipstream,
  type FatalOrigin,
} from "../src/child-main.ts";

// runChildMain is driven here with its I/O injected (frames collected, input given), so the protocol logic is tested
// without a process. The real fd 3 / stdin / process behaviour is covered by child-main-process.test.ts.

type Frame = Record<string, unknown> & { t: string };

const header = (overrides: Partial<InputHeader> = {}): InputHeader => ({ v: 1, output: "text", byteLength: 0, ...overrides });
const input = (h: InputHeader, bytes: Uint8Array = new Uint8Array(0)): ChildInput => ({ header: h, bytes });

interface Run {
  readonly frames: Frame[];
  readonly calls: string[];
  /** Exit codes passed to io.exit (the fake does not exit, so the main flow carries on). */
  readonly exits: number[];
  /** What the process would do on an uncaught exception / unhandled rejection. */
  fatal(reason: unknown, origin?: FatalOrigin): void;
  /** Resolves/rejects as runChildMain did. */
  readonly outcome: Promise<void>;
}

/** Runs runChildMain with the given input and ripstream; `sendFailsAfter` makes sendFrame throw from that frame on. */
function run(
  ripstream: ChildMainOptions["ripstream"],
  given: ChildInput | Error,
  options: { sendFailsAfter?: number; initThrows?: boolean } = {},
): Run {
  const frames: Frame[] = [];
  const calls: string[] = [];
  const exits: number[] = [];
  let fatalHandler: Parameters<ChildMainIo["onFatal"]>[0] | undefined;
  const io: ChildMainIo = {
    initChildProcess: () => {
      calls.push("init");
      if (options.initThrows === true) throw new Error("init failed");
    },
    onFatal: (handler) => {
      calls.push("onFatal");
      fatalHandler = handler;
    },
    exit: (code) => {
      calls.push(`exit:${code}`);
      exits.push(code);
    },
    readInput: async () => {
      calls.push("read");
      if (given instanceof Error) throw given;
      return given;
    },
    sendFrame: (frame) => {
      if (options.sendFailsAfter !== undefined && frames.length >= options.sendFailsAfter) {
        calls.push(`send-failed:${(frame as Frame).t}`);
        throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
      }
      calls.push(`send:${(frame as Frame).t}`);
      frames.push(frame as Frame);
    },
  };
  const outcome = withExitCode(() => runChildMain({ ripstream, io }));
  return {
    frames,
    calls,
    exits,
    fatal: (reason, origin = "uncaughtException") => {
      if (fatalHandler === undefined) throw new Error("runChildMain has not installed its fault handler");
      fatalHandler(reason, origin);
    },
    outcome,
  };
}

/** runChildMain sets process.exitCode; the test process must not inherit a failure code from a failure test. */
async function withExitCode(action: () => Promise<void>): Promise<void> {
  const before = process.exitCode;
  try {
    await action();
  } finally {
    lastExitCode = process.exitCode;
    process.exitCode = before;
  }
}
let lastExitCode: typeof process.exitCode;

/** A Ripstream over a scripted parser, so the real parse / parseRecursive paths of core run. */
function ripstreamOf(script: (handler: XHTMLContentHandler, metadata: Metadata, ctx: ParseContext) => Promise<void>): Ripstream {
  const detector: Detector = { detect: async () => MediaType.TEXT_PLAIN };
  const parser: Parser = {
    name: "ScriptedParser",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(_stream: RipstreamInputStream, handler: ContentHandler, metadata: Metadata, ctx: ParseContext): Promise<void> {
      metadata.set("Content-Type", "text/plain");
      const xhtml = new XHTMLContentHandler(handler, metadata);
      await xhtml.startDocument();
      await script(xhtml, metadata, ctx);
      await xhtml.endDocument();
    },
  };
  return new Ripstream({ detector, parser });
}

const writes = (text: string) => async (handler: XHTMLContentHandler): Promise<void> => {
  await handler.startElement("p");
  await handler.characters(text);
  await handler.endElement("p");
};

const types = (frames: readonly Frame[]): string[] => frames.map((frame) => frame.t);

// ---- structure: init first, ready, input ----------------------------------------------------------------------

test("initChildProcess is called first, then the fault handlers, all before the ready frame and the input", async () => {
  const r = run(ripstreamOf(writes("x")), input(header()));
  await r.outcome;
  assert.deepEqual(r.calls.slice(0, 4), ["init", "onFatal", "send:ready", "read"]);
});

test("initChildProcess runs even when the input cannot be read", async () => {
  const r = run(ripstreamOf(writes("x")), new Error("input truncated"));
  await r.outcome;
  assert.equal(r.calls[0], "init");
});

test("ready carries this process's pid", async () => {
  const r = run(ripstreamOf(writes("x")), input(header()));
  await r.outcome;
  assert.deepEqual(r.frames[0], { t: "ready", pid: process.pid });
});

test("the options' stderr budget reaches initChildProcess", async () => {
  let seen: unknown;
  const io: ChildMainIo = {
    initChildProcess: (options) => {
      seen = options;
    },
    readInput: async () => input(header()),
    sendFrame: () => {},
    onFatal: () => {},
    exit: () => {},
  };
  await withExitCode(() => runChildMain({ ripstream: ripstreamOf(writes("x")), stderrBudgetBytes: 1234, io }));
  assert.deepEqual(seen, { stderrBudgetBytes: 1234 });
});

// ---- text output ------------------------------------------------------------------------------------------------

test("text: ready, meta, text, done; metadata through the Metadata API", async () => {
  const ripstream = ripstreamOf(async (handler, metadata) => {
    metadata.add("author", "Ada");
    metadata.add("author", "Grace");
    metadata.set("pages", 3);
    await writes("hello")(handler);
  });
  const r = run(ripstream, input(header(), new Uint8Array([1])));
  await r.outcome;
  assert.deepEqual(types(r.frames), ["ready", "meta", "text", "done"]);
  const meta = r.frames[1]?.metadata as Record<string, string[]>;
  assert.deepEqual(meta.author, ["Ada", "Grace"]);
  assert.deepEqual(meta.pages, ["3"]);
  assert.deepEqual(meta["Content-Type"], ["text/plain"]);
  assert.match(String(r.frames[2]?.chunk), /hello/);
});

test("text: a metadata key named __proto__ stays an ordinary key and does not touch the prototype", async () => {
  const r = run(
    ripstreamOf(async (handler, metadata) => {
      metadata.set("__proto__", "polluted");
      await writes("x")(handler);
    }),
    input(header()),
  );
  await r.outcome;
  const meta = r.frames[1]?.metadata as Record<string, string[]>;
  assert.equal(Object.getPrototypeOf(meta), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(meta, "__proto__")?.value, ["polluted"]);
});

test("text: no output at all is ready, meta, done", async () => {
  const r = run(ripstreamOf(async () => {}), input(header()));
  await r.outcome;
  assert.deepEqual(types(r.frames), ["ready", "meta", "done"]);
});

test("text: long output is cut into chunks of at most 64 KiB that reassemble exactly", async () => {
  const text = "abc".repeat(100_000); // 300,000 chars
  const r = run(ripstreamOf(writes(text)), input(header({ maxOutputChars: 1_000_000 })));
  await r.outcome;
  const chunks = r.frames.filter((f) => f.t === "text").map((f) => String(f.chunk));
  assert.ok(chunks.length >= 5);
  for (const chunk of chunks) assert.ok(chunk.length <= MAX_TEXT_CHUNK_CHARS);
  const joined = chunks.join("");
  assert.ok(joined.includes(text));
});

test("text chunks: sizes, exact reassembly, and the empty string", () => {
  assert.deepEqual([...textChunks("")], []);
  assert.deepEqual([...textChunks("abcdef", 4)], ["abcd", "ef"]);
  assert.deepEqual([...textChunks("abcd", 4)], ["abcd"]);
  const text = "x".repeat(MAX_TEXT_CHUNK_CHARS * 2 + 1);
  const chunks = [...textChunks(text)];
  assert.deepEqual(chunks.map((c) => c.length), [MAX_TEXT_CHUNK_CHARS, MAX_TEXT_CHUNK_CHARS, 1]);
});

test("text chunks never split a surrogate pair, wherever the boundary falls", () => {
  const emoji = "\u{1F600}"; // two UTF-16 units
  for (let offset = 0; offset < 5; offset++) {
    const text = "a".repeat(offset) + emoji.repeat(9) + "z";
    for (const max of [2, 3, 4, 5, 6, 7]) {
      const chunks = [...textChunks(text, max)];
      assert.equal(chunks.join(""), text);
      for (const chunk of chunks) {
        assert.ok(chunk.length <= max, `chunk of ${chunk.length} > ${max}`);
        assert.equal(chunk.isWellFormed(), true, `ill-formed chunk ${JSON.stringify(chunk)} (offset ${offset}, max ${max})`);
      }
    }
  }
});

test("text chunks keep a lone surrogate as it is (it is not a pair)", () => {
  const text = `${"a".repeat(3)}\ud83d${"b".repeat(3)}\ude00`;
  const chunks = [...textChunks(text, 4)];
  assert.equal(chunks.join(""), text);
});

test("text chunks at the real 64 KiB size do not split an emoji that straddles the boundary", () => {
  const text = "a".repeat(MAX_TEXT_CHUNK_CHARS - 1) + "\u{1F600}" + "tail";
  const chunks = [...textChunks(text)];
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.length, MAX_TEXT_CHUNK_CHARS - 1);
  assert.equal(chunks.join(""), text);
});

test("textChunks refuses a size that cannot hold a surrogate pair", () => {
  assert.throws(() => [...textChunks("abc", 1)], RangeError);
});

test("text: an emoji straddling the first 64 KiB boundary of the real frames survives the wire shape", async () => {
  const text = "a".repeat(MAX_TEXT_CHUNK_CHARS - 1) + "\u{1F600}" + "tail";
  const r = run(ripstreamOf(writes(text)), input(header()));
  await r.outcome;
  for (const frame of r.frames) {
    if (frame.t === "text") assert.equal(String(frame.chunk).isWellFormed(), true);
  }
});

// ---- ParseOptions and the input source -------------------------------------------------------------------------

/** A ripstream that records what it was given and answers with fixed output. */
function recording(): { ripstream: ChildRipstream; seen: { source?: unknown; options?: Record<string, unknown> } } {
  const seen: { source?: unknown; options?: Record<string, unknown> } = {};
  const ripstream: ChildRipstream = {
    parse: async (source, options) => {
      seen.source = source;
      seen.options = options as Record<string, unknown>;
      return { metadata: new Metadata(), text: "" };
    },
    parseRecursive: async (source, options) => {
      seen.source = source;
      seen.options = options as Record<string, unknown>;
      return [];
    },
  };
  return { ripstream, seen };
}

test("inline bytes are parsed as bytes", async () => {
  const { ripstream, seen } = recording();
  await run(ripstream, input(header({ byteLength: 3 }), new Uint8Array([7, 8, 9]))).outcome;
  assert.ok(seen.source instanceof Uint8Array);
  assert.deepEqual([...(seen.source as Uint8Array)], [7, 8, 9]);
});

test("a path header is handed to core as { path } and is not read by the child entry", async () => {
  const { ripstream, seen } = recording();
  await run(ripstream, input(header({ path: "/definitely/not/there/doc.bin" }))).outcome;
  assert.deepEqual(seen.source, { path: "/definitely/not/there/doc.bin" });
});

test("limits and filename come from the header; unset limits are not passed at all", async () => {
  const { ripstream, seen } = recording();
  await run(
    ripstream,
    input(header({ filename: "a.docx", maxOutputChars: 11, maxEmbeddedResources: 5, maxParseMillis: 750 })),
  ).outcome;
  assert.deepEqual(seen.options, { filename: "a.docx", limits: { maxOutputChars: 11, maxEmbeddedResources: 5, maxParseMillis: 750 } });

  const bare = recording();
  await run(bare.ripstream, input(header())).outcome;
  assert.deepEqual(bare.seen.options, { limits: {} });
});

test("maxNodeDepth comes from the header", async () => {
  const { ripstream, seen } = recording();
  await run(ripstream, input(header({ maxNodeDepth: 3 }))).outcome;
  assert.deepEqual(seen.options, { limits: { maxNodeDepth: 3 } });
});

test("a ripstream factory is called with the header's components, and its ripstream parses", async () => {
  const { ripstream, seen } = recording();
  const given: unknown[] = [];
  const components = { parsers: [{ name: "zip-parser", marker: false, exclude: [], mimeInclude: [], mimeExclude: [] }] };
  const done = run((received) => (given.push(received), ripstream), input(header({ components })));
  await done.outcome;
  assert.deepEqual(given, [components]);
  assert.ok(seen.options !== undefined, "the built ripstream parsed");
  const bare: unknown[] = [];
  await run((received) => (bare.push(received), ripstream), input(header())).outcome;
  assert.deepEqual(bare, [undefined]);
});

test("a factory that throws is answered as an error frame, never silently", async () => {
  const r = run(() => {
    throw new Error("cannot build the parsers");
  }, input(header()));
  await r.outcome;
  assert.deepEqual(types(r.frames), ["ready", "error"]);
  assert.match(String(r.frames[1]?.message), /cannot build the parsers/);
});

test("a maxParseMillis of 0 is passed on (0 means no timer in core)", async () => {
  const { ripstream, seen } = recording();
  await run(ripstream, input(header({ maxParseMillis: 0 }))).outcome;
  assert.deepEqual((seen.options?.limits as Record<string, unknown>).maxParseMillis, 0);
});

test("output records calls parseRecursive, output text calls parse", async () => {
  const calls: string[] = [];
  const ripstream: ChildRipstream = {
    parse: async () => {
      calls.push("parse");
      return { metadata: new Metadata(), text: "" };
    },
    parseRecursive: async () => {
      calls.push("parseRecursive");
      return [];
    },
  };
  await run(ripstream, input(header({ output: "text" }))).outcome;
  await run(ripstream, input(header({ output: "records" }))).outcome;
  assert.deepEqual(calls, ["parse", "parseRecursive"]);
});

// ---- the in-child parse timer ----------------------------------------------------------------------------------

test("maxParseMillis: a parse that is merely slow ends with a typed PARSE_TIMEOUT frame, not a kill", async () => {
  const slow = ripstreamOf(async (_handler, _metadata, ctx) => {
    await new Promise<void>((resolve, reject) => {
      ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
      setTimeout(resolve, 5_000).unref();
    });
  });
  const started = performance.now();
  const r = run(slow, input(header({ maxParseMillis: 40 })));
  await r.outcome;
  assert.ok(performance.now() - started < 3_000);
  assert.deepEqual(types(r.frames), ["ready", "error"]);
  assert.equal(r.frames[1]?.code, "PARSE_TIMEOUT");
  assert.equal(r.frames[1]?.kind, "timeout");
});

// ---- records output ---------------------------------------------------------------------------------------------

function fakeRecords(): ParseRecord[] {
  const root = new Metadata();
  root.add("title", "Outer");
  root.add("title", "Alt");
  const child = new Metadata();
  child.set("resourceName", "inner.bin");
  const broken = new Metadata();
  const named = Object.assign(new MalformedDocumentError("bad inner"), { extra: "ignored" });
  return [
    { metadata: root, content: "outer text", embeddedResourcePath: "/outer", depth: 0, mediaType: MediaType.parse("application/zip")!, exception: null },
    { metadata: child, content: "inner text", embeddedResourcePath: "/outer/inner.bin", depth: 1, mediaType: MediaType.TEXT_PLAIN, exception: null },
    { metadata: broken, content: "", embeddedResourcePath: "/outer/broken", depth: 1, mediaType: MediaType.OCTET_STREAM, exception: named },
    { metadata: new Metadata(), content: "", embeddedResourcePath: "/outer/plain", depth: 1, mediaType: MediaType.OCTET_STREAM, exception: new TypeError("oops") },
  ];
}

test("records: one record frame per record, in order, then done", async () => {
  const ripstream: ChildRipstream = { parse: async () => assert.fail("parse"), parseRecursive: async () => fakeRecords() };
  const r = run(ripstream, input(header({ output: "records" })));
  await r.outcome;
  assert.deepEqual(types(r.frames), ["ready", "record", "record", "record", "record", "done"]);
  const records = r.frames.filter((f) => f.t === "record").map((f) => f.record as Record<string, unknown>);
  assert.deepEqual(records[0], {
    metadata: { title: ["Outer", "Alt"] },
    content: "outer text",
    embeddedResourcePath: "/outer",
    depth: 0,
    mediaType: "application/zip",
    exception: null,
  });
  assert.equal(records[1]?.mediaType, "text/plain");
  assert.deepEqual(records[1]?.metadata, { resourceName: ["inner.bin"] });
});

test("records: exceptions cross as { name, message, code? } data and are not rethrown", async () => {
  const ripstream: ChildRipstream = { parse: async () => assert.fail("parse"), parseRecursive: async () => fakeRecords() };
  const r = run(ripstream, input(header({ output: "records" })));
  await r.outcome;
  const records = r.frames.filter((f) => f.t === "record").map((f) => f.record as Record<string, unknown>);
  assert.deepEqual(records[2]?.exception, { name: "MalformedDocumentError", message: "bad inner", code: "MALFORMED_DOCUMENT" });
  assert.deepEqual(records[3]?.exception, { name: "TypeError", message: "oops" });
  assert.equal(r.frames.at(-1)?.t, "done");
});

test("records: no records is ready, done", async () => {
  const ripstream: ChildRipstream = { parse: async () => assert.fail("parse"), parseRecursive: async () => [] };
  const r = run(ripstream, input(header({ output: "records" })));
  await r.outcome;
  assert.deepEqual(types(r.frames), ["ready", "done"]);
});

test("records: a request-fatal failure is one error frame, not a record", async () => {
  const ripstream: ChildRipstream = {
    parse: async () => assert.fail("parse"),
    parseRecursive: async () => {
      throw new LimitExceededError("Recursive output exceeds 5 characters");
    },
  };
  const r = run(ripstream, input(header({ output: "records" })));
  await r.outcome;
  assert.deepEqual(types(r.frames), ["ready", "error"]);
  assert.equal(r.frames[1]?.code, "LIMIT_EXCEEDED");
});

// ---- errors: exactly one terminal frame, whatever happens --------------------------------------------------------

const throwing = (error: unknown): ChildRipstream => ({
  parse: async () => {
    throw error;
  },
  parseRecursive: async () => {
    throw error;
  },
});

test("a typed error from the parser is one error frame carrying its code", async () => {
  const r = run(throwing(new LimitExceededError("Output exceeds 10 characters")), input(header()));
  await r.outcome;
  assert.deepEqual(r.frames.slice(1), [{ t: "error", kind: "limit", code: "LIMIT_EXCEEDED", message: "Output exceeds 10 characters" }]);
});

test("a plain Error is one crash frame with no code", async () => {
  const r = run(throwing(new TypeError("x is not a function")), input(header()));
  await r.outcome;
  assert.deepEqual(r.frames.slice(1), [{ t: "error", kind: "crash", message: "TypeError: x is not a function" }]);
});

test("a thrown non-Error (string, undefined) is one crash frame", async () => {
  for (const thrown of ["a string", undefined, null, 7]) {
    const r = run(throwing(thrown), input(header()));
    await r.outcome;
    assert.deepEqual(types(r.frames), ["ready", "error"]);
    assert.equal(r.frames[1]?.kind, "crash");
  }
});

test("a rejected readInput (truncated or malformed input) is one crash frame after ready", async () => {
  const r = run(throwing(new Error("never used")), new Error("input truncated: stream ended after 0 of 4 header length bytes"));
  await r.outcome;
  assert.deepEqual(types(r.frames), ["ready", "error"]);
  assert.match(String(r.frames[1]?.message), /input truncated/);
});

test("an error after text frames were sent is still exactly one terminal frame", async () => {
  // The parse succeeds, but the output of a failing sendFrame (EPIPE on the third frame) aborts the stream midway.
  const text = "q".repeat(MAX_TEXT_CHUNK_CHARS * 3);
  const r = run(ripstreamOf(writes(text)), input(header({ maxOutputChars: 1_000_000 })), { sendFailsAfter: 3 });
  await r.outcome;
  // ready, meta, text accepted; the next text frame failed, and so did the error frame that tried to report it.
  assert.deepEqual(types(r.frames), ["ready", "meta", "text"]);
  assert.ok(r.calls.includes("send-failed:text"));
  assert.ok(r.calls.includes("send-failed:error"));
});

test("when the done frame cannot be written no second terminal frame is attempted", async () => {
  const r = run(ripstreamOf(writes("x")), input(header()), { sendFailsAfter: 3 }); // ready, meta, text sent; done fails
  await r.outcome;
  assert.deepEqual(types(r.frames), ["ready", "meta", "text"]);
  assert.deepEqual(r.calls.filter((call) => call.startsWith("send-failed")), ["send-failed:done"]);
});

test("runChildMain never rejects: even initChildProcess throwing is contained", async () => {
  const r = run(ripstreamOf(writes("x")), input(header()), { initThrows: true });
  await r.outcome;
  assert.equal(r.calls[0], "init");
});

test("exit code: 0 once a terminal frame was delivered, success or error", async () => {
  await run(ripstreamOf(writes("x")), input(header())).outcome;
  assert.equal(lastExitCode === undefined || lastExitCode === 0, true, `exitCode ${String(lastExitCode)} after a successful run`);
  await run(throwing(new Error("boom")), input(header())).outcome;
  assert.equal(lastExitCode === undefined || lastExitCode === 0, true, `exitCode ${String(lastExitCode)} after an error frame`);
});

test("exit code: 1 when no terminal frame could be delivered", async () => {
  await run(ripstreamOf(writes("x")), input(header()), { sendFailsAfter: 1 }).outcome;
  assert.equal(lastExitCode, 1);
});

// ---- faults outside the request's promise chain (inline parsers: pdf.js on this thread) --------------------------

/** A pipeline whose parse starts, then waits until released: a window in which a fault can strike mid-parse. */
function gated(): { ripstream: ChildRipstream; started: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const ripstream: ChildRipstream = {
    parse: async () => {
      signalStarted();
      await gate;
      return { metadata: new Metadata(), text: "late text" };
    },
    parseRecursive: async () => {
      signalStarted();
      await gate;
      return [];
    },
  };
  return { ripstream, started, release };
}

const ORIGINS: readonly [FatalOrigin, string][] = [
  ["uncaughtException", "uncaught exception"],
  ["unhandledRejection", "unhandled rejection"],
];

for (const [origin, label] of ORIGINS) {
  test(`${origin} during the parse: one labelled crash frame, exit code 1, nothing sent afterwards`, async () => {
    const g = gated();
    const r = run(g.ripstream, input(header()));
    await g.started;
    r.fatal(new TypeError("pdf.js internal failure"), origin);
    assert.deepEqual(r.frames, [
      { t: "ready", pid: process.pid },
      { t: "error", kind: "crash", message: `${label}: TypeError: pdf.js internal failure` },
    ]);
    assert.deepEqual(r.exits, [1]);
    // The real process is gone by now; this fake carries on, and must still not add a frame.
    g.release();
    await r.outcome;
    assert.deepEqual(types(r.frames), ["ready", "error"]);
  });
}

test("a fault during a records parse is the same single crash frame", async () => {
  const g = gated();
  const r = run(g.ripstream, input(header({ output: "records" })));
  await g.started;
  r.fatal(new Error("boom"));
  g.release();
  await r.outcome;
  assert.deepEqual(types(r.frames), ["ready", "error"]);
  assert.deepEqual(r.exits, [1]);
});

test("a typed error that escapes as a fault is a crash with no code: it was not the request's answer", async () => {
  const g = gated();
  const r = run(g.ripstream, input(header()));
  await g.started;
  r.fatal(new LimitExceededError("Output exceeds 10 characters"), "unhandledRejection");
  assert.deepEqual(r.frames[1], {
    t: "error",
    kind: "crash",
    message: "unhandled rejection: LimitExceededError: Output exceeds 10 characters",
  });
});

test("a fault that is not an Error (a rejection with a string or undefined) still produces a crash frame", async () => {
  for (const reason of ["just a string", undefined, null, 42]) {
    const g = gated();
    const r = run(g.ripstream, input(header()));
    await g.started;
    r.fatal(reason, "unhandledRejection");
    assert.equal(r.frames[1]?.kind, "crash", String(reason));
    assert.equal(r.frames[1]?.code, undefined);
    assert.deepEqual(r.exits, [1]);
    g.release();
    await r.outcome;
  }
});

test("a fault whose message is huge or hostile is bounded and sanitised, and cannot make the handler throw", async () => {
  const hostile = new Error("x");
  Object.defineProperty(hostile, "message", {
    get() {
      throw new Error("getter bomb");
    },
  });
  for (const reason of [new Error(`line one\u0000\nline two ${"y".repeat(100_000)}`), hostile]) {
    const g = gated();
    const r = run(g.ripstream, input(header()));
    await g.started;
    r.fatal(reason);
    const message = String(r.frames[1]?.message);
    assert.equal(r.frames[1]?.kind, "crash");
    assert.ok(message.length <= 600, `${message.length} chars`);
    assert.doesNotMatch(message, /[\u0000-\u0008\u000b-\u001f]/);
    assert.deepEqual(r.exits, [1]);
    g.release();
    await r.outcome;
  }
});

test("a fault after the done frame was sent changes nothing: no frame, exit code 0", async () => {
  const r = run(ripstreamOf(writes("x")), input(header()));
  await r.outcome;
  const before = [...r.frames];
  r.fatal(new Error("late timer in a leaked handle"), "uncaughtException");
  assert.deepEqual(r.frames, before);
  assert.deepEqual(r.exits, [0]);
});

test("a fault after an error frame was sent changes nothing either", async () => {
  const r = run(throwing(new Error("first")), input(header()));
  await r.outcome;
  const before = [...r.frames];
  r.fatal(new Error("second"), "unhandledRejection");
  assert.deepEqual(r.frames, before);
  assert.deepEqual(r.exits, [0]);
});

test("a fault when fd 3 is already unwritable still exits, with code 1, and does not throw", async () => {
  const g = gated();
  const r = run(g.ripstream, input(header()), { sendFailsAfter: 1 }); // ready goes out, everything after fails
  await g.started;
  assert.doesNotThrow(() => r.fatal(new Error("boom")));
  assert.deepEqual(types(r.frames), ["ready"]);
  assert.deepEqual(r.exits, [1]);
  g.release();
  await r.outcome;
});

test("a fault while the done frame is half written: no second terminal frame, exit code 1", async () => {
  // The terminal write itself fails (sendFailsAfter: ready, meta, text accepted); then a fault strikes.
  const r = run(ripstreamOf(writes("x")), input(header()), { sendFailsAfter: 3 });
  await r.outcome;
  r.fatal(new Error("boom"));
  assert.deepEqual(r.calls.filter((call) => call.startsWith("send-failed")), ["send-failed:done"]);
  assert.deepEqual(r.exits, [1]);
});

// ---- a parse that never settles ------------------------------------------------------------------

test("a parse that ignores core's timer and never settles is answered by the watchdog: one PARSE_TIMEOUT frame, then exit(0)", async () => {
  const stuck: ChildRipstream = { parse: () => new Promise(() => {}), parseRecursive: () => new Promise(() => {}) };
  for (const output of ["text", "records"] as const) {
    const r = run(stuck, input(header({ output, maxParseMillis: 20 })));
    await r.outcome;
    const terminals = r.frames.filter((f) => f.t === "done" || f.t === "error");
    assert.equal(terminals.length, 1, output);
    assert.equal(terminals[0]?.t, "error", output);
    assert.equal(terminals[0]?.kind, "timeout", output);
    assert.equal(terminals[0]?.code, "PARSE_TIMEOUT", output);
    assert.deepEqual(r.exits, [0], `${output}: leaves at once instead of waiting for the grace kill`);
  }
});

test("the watchdog still exits when its terminal frame cannot be written (the parent closed fd 3)", async () => {
  const stuck: ChildRipstream = { parse: () => new Promise(() => {}), parseRecursive: () => new Promise(() => {}) };
  const r = run(stuck, input(header({ maxParseMillis: 20 })), { sendFailsAfter: 1 }); // "ready" goes out, the terminal does not
  await r.outcome;
  assert.deepEqual(r.calls.filter((call) => call.startsWith("send-failed")), ["send-failed:error"]);
  assert.deepEqual(r.exits, [0], "exit is not skipped by the failed write");
  assert.equal(lastExitCode, 1, "nothing was delivered, so the exit code says so");
});

test("a parse that finishes in time never calls exit", async () => {
  const r = run(ripstreamOf(writes("fine")), input(header({ maxParseMillis: 60_000 })));
  await r.outcome;
  assert.equal(r.frames.at(-1)?.t, "done");
  assert.deepEqual(r.exits, []);
});
