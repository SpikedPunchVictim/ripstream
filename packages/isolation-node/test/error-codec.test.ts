import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortError,
  EmptyDocumentError,
  EncryptedDocumentError,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  MissingDependencyError,
  ParseTimeoutError,
  ParserDeclinedError,
  RandomAccessUnavailableError,
  RequestTooLargeError,
  RipstreamError,
  TranslationError,
  UnsupportedFormatError,
  UnsupportedRuntimeError,
  WriteLimitReachedError,
  httpStatusForError,
  type RipstreamErrorCode,
} from "@spikedpunch/ripstream-core";
import { classifyExit } from "../src/classify.ts";
import { MAX_ERROR_MESSAGE_CHARS, decodableCodes, encodeChildError, encodeCrashError, sanitizeText } from "../src/error-codec.ts";
import { FrameReader, type ErrorFrame } from "../src/frames.ts";

/**
 * The parent must rethrow an error of the SAME class as an in-process parse would have thrown, so that the HTTP
 * status (httpStatusForError, core) and the CLI exit code are the same. These tests push each error through the
 * real path: child encoder -> NDJSON bytes -> FrameReader -> classifyExit.
 */

// packages/cli/src/main.ts exitCodeFor, replicated: the CLI is not a dependency of this package. Keep in step with it.
function cliExitCodeFor(error: unknown): number {
  if (
    error instanceof MalformedDocumentError ||
    error instanceof UnsupportedFormatError ||
    error instanceof EncryptedDocumentError ||
    error instanceof LimitExceededError
  ) {
    return 3;
  }
  if (error instanceof MissingDependencyError) return 4;
  if (error instanceof IsolationError) return error.reason === "crash" ? 1 : 4;
  if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return 4;
  return 1;
}

function bytesOf(frame: object): Uint8Array {
  return Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
}

/** What the parent throws for `frame` arriving after a normal "ready", via the real reader and classifier. */
function parentErrorFor(frame: object): RipstreamError {
  const reader = new FrameReader({ output: "text", maxTotalBytes: 16 * 1024 * 1024 });
  const events = [...reader.push(bytesOf({ t: "ready", pid: 1 })), ...reader.push(bytesOf(frame))];
  const violation = events.find((event) => event.type === "violation");
  assert.equal(violation, undefined, `frame was rejected by the reader: ${JSON.stringify(violation)}`);
  assert.equal(reader.terminal, "error");
  const errorFrame = reader.errorFrame;
  assert.notEqual(errorFrame, null);
  const error = classifyExit({
    phase: reader.phase,
    terminal: reader.terminal,
    ...(errorFrame === null ? {} : { errorFrame }),
    killReason: null,
    code: 0,
    signal: null,
    stderrTail: "",
  });
  assert.ok(error instanceof RipstreamError, "classifyExit must return a RipstreamError for an error frame");
  return error;
}

/** Child throws `thrown`; the parent rethrows what this returns. */
function crossBoundary(thrown: unknown): RipstreamError {
  return parentErrorFor(encodeChildError(thrown));
}

// ---- parity: every class in errors.ts -------------------------------------------------------------------------

interface Row {
  readonly label: string;
  readonly code: RipstreamErrorCode;
  readonly make: () => RipstreamError;
  /** The class the parent must produce. */
  readonly expected: abstract new (...args: never[]) => RipstreamError;
  /** What the parent produces for it. "same" = identical to the in-process error. */
  readonly crosses: "same" | "crash";
}

const ROWS: readonly Row[] = [
  { label: "UnsupportedFormatError", code: "UNSUPPORTED_FORMAT", make: () => new UnsupportedFormatError("no parser for x/y"), expected: UnsupportedFormatError, crosses: "same" },
  { label: "EncryptedDocumentError", code: "ENCRYPTED_DOCUMENT", make: () => new EncryptedDocumentError("PDF is encrypted"), expected: EncryptedDocumentError, crosses: "same" },
  { label: "MalformedDocumentError", code: "MALFORMED_DOCUMENT", make: () => new MalformedDocumentError("bad xref"), expected: MalformedDocumentError, crosses: "same" },
  { label: "ParseTimeoutError", code: "PARSE_TIMEOUT", make: () => new ParseTimeoutError(), expected: ParseTimeoutError, crosses: "same" },
  { label: "LimitExceededError", code: "LIMIT_EXCEEDED", make: () => new LimitExceededError("Output exceeds 10 characters"), expected: LimitExceededError, crosses: "same" },
  {
    label: "MissingDependencyError",
    code: "MISSING_DEPENDENCY",
    make: () => new MissingDependencyError("pdfjs-dist", "PDF parsing"),
    expected: MissingDependencyError,
    crosses: "same",
  },
  { label: "ParserDeclinedError", code: "PARSER_DECLINED", make: () => new ParserDeclinedError("not mine"), expected: ParserDeclinedError, crosses: "same" },
  { label: "AbortError", code: "ABORTED", make: () => new AbortError(), expected: AbortError, crosses: "same" },
  { label: "UnsupportedRuntimeError", code: "UNSUPPORTED_RUNTIME", make: () => new UnsupportedRuntimeError("no digest provider"), expected: UnsupportedRuntimeError, crosses: "same" },
  // Arrive as an unexplained crash (500 / exit 1). First, errors no parser in the child's pipeline throws, so a
  // child that sends one is not running our parsers and must not be able to mint a 413 / 502 / "empty but fine":
  { label: "RequestTooLargeError", code: "REQUEST_TOO_LARGE", make: () => new RequestTooLargeError(), expected: IsolationError, crosses: "crash" },
  { label: "RandomAccessUnavailableError", code: "RANDOM_ACCESS_UNAVAILABLE", make: () => new RandomAccessUnavailableError("needs a file"), expected: IsolationError, crosses: "crash" },
  { label: "EmptyDocumentError", code: "EMPTY_DOCUMENT", make: () => new EmptyDocumentError(), expected: IsolationError, crosses: "crash" },
  { label: "TranslationError", code: "TRANSLATION_FAILED", make: () => new TranslationError("upstream down"), expected: IsolationError, crosses: "crash" },
  // Then those that are not representable on the wire:
  //  - WriteLimitReachedError needs a numeric limit, and only WriteOutContentHandler throws it; the isolated pipeline
  //    never installs one. In-process it maps to HTTP 200 ("it produced content"); a crash is the honest answer when
  //    it shows up in a child anyway.
  //  - IsolationError is infrastructure. A child must never be able to mint queue_full/unavailable (callers treat
  //    those specially), and a nested isolation failure inside a child cannot happen.
  { label: "WriteLimitReachedError", code: "WRITE_LIMIT_REACHED", make: () => new WriteLimitReachedError(5), expected: IsolationError, crosses: "crash" },
  { label: "IsolationError(queue_full)", code: "ISOLATION_FAILED", make: () => new IsolationError("queue_full", "full"), expected: IsolationError, crosses: "crash" },
  { label: "IsolationError(unavailable)", code: "ISOLATION_FAILED", make: () => new IsolationError("unavailable", "gone"), expected: IsolationError, crosses: "crash" },
  { label: "IsolationError(crash)", code: "ISOLATION_FAILED", make: () => new IsolationError("crash", "boom"), expected: IsolationError, crosses: "crash" },
];

test("the parity table covers every RipstreamErrorCode", () => {
  const covered = new Set(ROWS.map((row) => row.code));
  const all: Record<RipstreamErrorCode, true> = {
    UNSUPPORTED_FORMAT: true,
    ENCRYPTED_DOCUMENT: true,
    MALFORMED_DOCUMENT: true,
    WRITE_LIMIT_REACHED: true,
    PARSE_TIMEOUT: true,
    REQUEST_TOO_LARGE: true,
    LIMIT_EXCEEDED: true,
    MISSING_DEPENDENCY: true,
    RANDOM_ACCESS_UNAVAILABLE: true,
    PARSER_DECLINED: true,
    EMPTY_DOCUMENT: true,
    ABORTED: true,
    UNSUPPORTED_RUNTIME: true,
    TRANSLATION_FAILED: true,
    ISOLATION_FAILED: true,
  };
  for (const code of Object.keys(all)) assert.ok(covered.has(code as RipstreamErrorCode), `no parity row for ${code}`);
});

test("decodableCodes is exactly the rows that cross faithfully", () => {
  const faithful = ROWS.filter((row) => row.crosses === "same").map((row) => row.code).sort();
  assert.deepEqual([...decodableCodes()].sort(), faithful);
});

for (const row of ROWS) {
  test(`parity: ${row.label} crosses as ${row.crosses === "same" ? "the same class" : "a crash"}`, () => {
    const inProcess = row.make();
    const parent = crossBoundary(inProcess);
    assert.ok(parent instanceof row.expected, `expected ${row.expected.name}, got ${parent.constructor.name}`);
    if (row.crosses === "same") {
      assert.equal(parent.constructor, inProcess.constructor);
      assert.equal(parent.code, inProcess.code);
      assert.equal(parent.name, inProcess.name);
      assert.equal(parent.message, inProcess.message);
      assert.equal(parent.recoverable, inProcess.recoverable);
      assert.equal(httpStatusForError(parent), httpStatusForError(inProcess));
      assert.equal(cliExitCodeFor(parent), cliExitCodeFor(inProcess));
    } else {
      assert.ok(parent instanceof IsolationError && parent.reason === "crash");
      assert.equal(httpStatusForError(parent), 500);
      assert.equal(cliExitCodeFor(parent), 1);
    }
  });
}

test("MissingDependencyError keeps its dependency and capability", () => {
  const parent = crossBoundary(new MissingDependencyError("tesseract", "Tesseract OCR"));
  assert.ok(parent instanceof MissingDependencyError);
  assert.equal(parent.dependency, "tesseract");
  assert.equal(parent.capability, "Tesseract OCR");
});

test("a crash row says what the child threw, and that it could not be represented", () => {
  const parent = crossBoundary(new WriteLimitReachedError(5));
  assert.match(parent.message, /WriteLimitReachedError/);
  assert.match(parent.message, /Write limit of 5 characters reached/);
});

// ---- errors that are not RipstreamErrors ----------------------------------------------------------------------

for (const [label, thrown] of [
  ["a plain Error", new Error("kaboom")],
  ["a TypeError", new TypeError("x is not a function")],
  ["a RangeError of another kind", new RangeError("Invalid array length")],
  ["a DOMException", new DOMException("nope", "NotFoundError")],
  ["a string", "just a string"],
  ["a number", 42],
  ["undefined", undefined],
  ["null", null],
  ["an object", { code: "LIMIT_EXCEEDED", name: "LimitExceededError", message: "lies" }],
  ["an Error carrying a RipstreamError-looking code", Object.assign(new Error("spoof"), { code: "LIMIT_EXCEEDED" })],
  ["an Error named LimitExceededError", Object.assign(new Error("spoof"), { name: "LimitExceededError" })],
] as const) {
  test(`non-RipstreamError (${label}) is an IsolationError crash with no code on the wire`, () => {
    const frame = encodeChildError(thrown);
    assert.equal(frame.kind, "crash");
    assert.equal(frame.code, undefined);
    const parent = parentErrorFor(frame);
    assert.ok(parent instanceof IsolationError && parent.reason === "crash");
    assert.equal(httpStatusForError(parent), 500);
    assert.equal(cliExitCodeFor(parent), 1);
  });
}

test("a thrown value whose toString throws still encodes", () => {
  const hostile = {
    toString(): string {
      throw new Error("no");
    },
  };
  const frame = encodeChildError(hostile);
  assert.equal(frame.kind, "crash");
  assert.equal(typeof frame.message, "string");
});

test("an error with a throwing message getter still encodes", () => {
  const hostile = new Error("x");
  Object.defineProperty(hostile, "message", {
    get(): string {
      throw new Error("no");
    },
  });
  assert.equal(encodeChildError(hostile).kind, "crash");
});

for (const message of ["Invalid string length", "Array buffer allocation failed", "Invalid typed array length: 9007199254740992"]) {
  test(`RangeError "${message}" is a limit (the child caught what the exit classifier would have matched on stderr)`, () => {
    const parent = crossBoundary(new RangeError(message));
    assert.ok(parent instanceof LimitExceededError);
    assert.equal(httpStatusForError(parent), 422);
    assert.equal(cliExitCodeFor(parent), 3);
  });
}

// core's CompositeParser wraps whatever a parser leaks in a MalformedDocumentError whose cause is the original, so an
// allocator RangeError from a parser reaches the child's encoder one level down.
for (const message of ["Array buffer allocation failed", "Invalid typed array length: 4294967296", "Invalid string length"]) {
  test(`a MalformedDocumentError caused by the RangeError "${message}" is a limit`, () => {
    const wrapped = new MalformedDocumentError(`Parser P failed: ${message}`, { cause: new RangeError(message) });
    const parent = crossBoundary(wrapped);
    assert.ok(parent instanceof LimitExceededError, String(parent));
    assert.equal(httpStatusForError(parent), 422);
  });
}

test("a RangeError caused two levels down is found, but only within a few levels", () => {
  const root = new RangeError("Array buffer allocation failed");
  const twice = new MalformedDocumentError("outer", { cause: new MalformedDocumentError("inner", { cause: root }) });
  assert.ok(crossBoundary(twice) instanceof LimitExceededError);
  let deep: unknown = root;
  for (let i = 0; i < 10; i++) deep = new MalformedDocumentError(`level ${i}`, { cause: deep });
  assert.ok(crossBoundary(deep) instanceof MalformedDocumentError);
});

test("a MalformedDocumentError is still malformed when its cause is not an allocator RangeError", () => {
  const causes: unknown[] = [
    new RangeError("Offset is outside the bounds of the DataView"),
    new TypeError("Array buffer allocation failed"),
    new Error("Invalid typed array length: 4"),
    "Array buffer allocation failed",
    undefined,
  ];
  for (const cause of causes) {
    const wrapped = new MalformedDocumentError("Parser P failed: x", cause === undefined ? undefined : { cause });
    assert.ok(crossBoundary(wrapped) instanceof MalformedDocumentError, String(cause));
  }
});

test("an allocator RangeError up to four causes down is a limit and five is not", () => {
  const wrapped = (causes: number): unknown => {
    let error: unknown = new RangeError("Invalid string length");
    for (let i = 0; i < causes; i++) error = new MalformedDocumentError(`level ${i}`, { cause: error });
    return error;
  };
  assert.ok(crossBoundary(wrapped(1)) instanceof LimitExceededError);
  assert.ok(crossBoundary(wrapped(4)) instanceof LimitExceededError);
  assert.ok(crossBoundary(wrapped(5)) instanceof MalformedDocumentError);
});

test("the chain is followed through any Error, not only through MalformedDocumentErrors", () => {
  const root = new RangeError("Array buffer allocation failed");
  const wrapped = new MalformedDocumentError("outer", { cause: new Error("middle", { cause: root }) });
  assert.ok(crossBoundary(wrapped) instanceof LimitExceededError);
});

test("the chain is not followed through a cause that is not an Error", () => {
  const cause = { cause: new RangeError("Invalid string length") };
  assert.ok(crossBoundary(new MalformedDocumentError("outer", { cause })) instanceof MalformedDocumentError);
});

test("only a MalformedDocumentError is looked through: other errors keep their own answer", () => {
  const exhaustion = new RangeError("Invalid string length");
  const withCause = { cause: exhaustion };
  const declined = new ParserDeclinedError("declined");
  Object.defineProperty(declined, "cause", { value: exhaustion });
  assert.ok(crossBoundary(new UnsupportedFormatError("x/y", withCause)) instanceof UnsupportedFormatError);
  assert.ok(crossBoundary(new LimitExceededError("a limit", withCause)) instanceof LimitExceededError);
  assert.ok(crossBoundary(declined) instanceof ParserDeclinedError);
  assert.ok(crossBoundary(new Error("plain", withCause)) instanceof IsolationError);
});

test("a MalformedDocumentError that is a limit carries no code and keeps its own message", () => {
  const frame = encodeChildError(new MalformedDocumentError("Parser P failed: big", { cause: new RangeError("Invalid string length") }));
  assert.equal(frame.kind, "limit");
  assert.equal(frame.code, undefined);
  assert.equal(frame.message, "Parser P failed: big");
});

test("a cyclic or hostile cause chain does not hang or throw", () => {
  const a = new MalformedDocumentError("a");
  const b = new MalformedDocumentError("b", { cause: a });
  Object.defineProperty(a, "cause", { value: b });
  assert.ok(crossBoundary(a) instanceof MalformedDocumentError);
  const hostile = new MalformedDocumentError("h");
  Object.defineProperty(hostile, "cause", {
    get(): never {
      throw new Error("no");
    },
  });
  assert.ok(crossBoundary(hostile) instanceof RipstreamError);
});

test("a TypeError with the same text is not a limit", () => {
  assert.ok(crossBoundary(new TypeError("Invalid string length")) instanceof IsolationError);
});

// ---- hostile frames ---------------------------------------------------------------------------------------------

const frameWith = (extra: object): ErrorFrame => ({ t: "error", kind: "limit", message: "m", ...extra }) as ErrorFrame;

for (const code of [
  "NOT_A_CODE",
  "",
  "limit_exceeded",
  " LIMIT_EXCEEDED",
  "LIMIT_EXCEEDED ",
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "ISOLATION_FAILED",
  "WRITE_LIMIT_REACHED",
  "ENOENT",
]) {
  test(`hostile code ${JSON.stringify(code)} is an IsolationError crash, whatever the kind`, () => {
    for (const kind of ["limit", "timeout", "malformed", "abort", "crash"]) {
      const parent = parentErrorFor({ t: "error", kind, message: "m", code });
      assert.ok(parent instanceof IsolationError && parent.reason === "crash", `kind ${kind}: got ${parent.constructor.name}`);
      assert.equal(httpStatusForError(parent), 500);
    }
  });
}

test("a child cannot choose an IsolationError reason: the frame has no such field", () => {
  const reader = new FrameReader({ output: "text", maxTotalBytes: 1 << 20 });
  reader.push(bytesOf({ t: "ready", pid: 1 }));
  const events = reader.push(bytesOf({ t: "error", kind: "crash", message: "m", code: "ISOLATION_FAILED", reason: "queue_full" }));
  assert.equal(events[0]?.type, "violation");
});

test("a code in the closed set selects the class, even against the kind", () => {
  const parent = parentErrorFor(frameWith({ code: "ENCRYPTED_DOCUMENT" }));
  assert.ok(parent instanceof EncryptedDocumentError);
});

test("without a code the kind still selects the class (unchanged behaviour)", () => {
  assert.ok(parentErrorFor(frameWith({ kind: "malformed" })) instanceof MalformedDocumentError);
  assert.ok(parentErrorFor(frameWith({ kind: "timeout" })) instanceof ParseTimeoutError);
  assert.ok(parentErrorFor(frameWith({ kind: "abort" })) instanceof AbortError);
});

test("MISSING_DEPENDENCY without its fields is a crash, not a half-built error", () => {
  const parent = parentErrorFor({ t: "error", kind: "crash", message: "m", code: "MISSING_DEPENDENCY" });
  assert.ok(parent instanceof IsolationError);
  const onlyOne = parentErrorFor({ t: "error", kind: "crash", message: "m", code: "MISSING_DEPENDENCY", dependency: "x" });
  assert.ok(onlyOne instanceof IsolationError);
});

test("dependency and capability are display text: bounded and sanitised", () => {
  const parent = parentErrorFor({
    t: "error",
    kind: "crash",
    message: "m",
    code: "MISSING_DEPENDENCY",
    dependency: `evil\u001b[2J${"d".repeat(100_000)}`,
    capability: "c\u0000\nx",
  });
  assert.ok(parent instanceof MissingDependencyError);
  assert.ok(parent.message.length < 600, `message is ${parent.message.length} chars`);
  assert.equal(/[\u0000-\u001f]/.test(parent.message), false);
});

test("dependency and capability fields on another code are ignored", () => {
  const parent = parentErrorFor({ t: "error", kind: "limit", message: "m", code: "LIMIT_EXCEEDED", dependency: "x", capability: "y" });
  assert.ok(parent instanceof LimitExceededError);
});

test("dependency and capability must be strings", () => {
  const reader = new FrameReader({ output: "text", maxTotalBytes: 1 << 20 });
  reader.push(bytesOf({ t: "ready", pid: 1 }));
  const events = reader.push(bytesOf({ t: "error", kind: "crash", message: "m", code: "MISSING_DEPENDENCY", dependency: 5, capability: "y" }));
  assert.equal(events[0]?.type, "violation");
});

test("a huge message is bounded", () => {
  const parent = parentErrorFor({ t: "error", kind: "limit", message: "y".repeat(900_000), code: "LIMIT_EXCEEDED" });
  assert.ok(parent.message.length <= MAX_ERROR_MESSAGE_CHARS + 3, `message is ${parent.message.length} chars`);
});

test("the child bounds its own message too", () => {
  const frame = encodeChildError(new LimitExceededError("z".repeat(900_000)));
  assert.ok(frame.message.length <= MAX_ERROR_MESSAGE_CHARS + 3);
});

test("control characters and line breaks never reach the message", () => {
  const parent = parentErrorFor({
    t: "error",
    kind: "limit",
    message: "a\u0000b\u001b[31mc\u0085d\u2028e\r\nf\tg\u007fh",
    code: "LIMIT_EXCEEDED",
  });
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(parent.message), false, JSON.stringify(parent.message));
  assert.match(parent.message, /^a\?b\?\[31mc\?d\?e\? f g\?h$/);
});

test("a message cannot smuggle a class: the text is only text", () => {
  const parent = parentErrorFor({ t: "error", kind: "limit", message: "IsolationError queue_full", code: "LIMIT_EXCEEDED" });
  assert.ok(parent instanceof LimitExceededError);
  assert.equal(parent instanceof IsolationError, false);
});

test("__proto__ as a key of the error frame is a protocol violation, not a prototype swap", () => {
  const reader = new FrameReader({ output: "text", maxTotalBytes: 1 << 20 });
  reader.push(bytesOf({ t: "ready", pid: 1 }));
  const line = '{"t":"error","kind":"limit","message":"m","__proto__":{"code":"ENCRYPTED_DOCUMENT"}}\n';
  const events = reader.push(Buffer.from(line));
  assert.equal(events[0]?.type, "violation");
  assert.equal(reader.terminal, null);
});

test("the stderr tail is attached as the cause of limit, timeout and crash, like the kind path always did", () => {
  const frame: ErrorFrame = { t: "error", kind: "limit", message: "m", code: "LIMIT_EXCEEDED" };
  const error = classifyExit({
    phase: "post-ready",
    terminal: "error",
    errorFrame: frame,
    killReason: null,
    code: 0,
    signal: null,
    stderrTail: "child said something",
  });
  assert.match(String((error?.cause as Error | undefined)?.message), /child said something/);
});

// ---- encodeCrashError: faults that are not the request's answer ------------------------------------------------------

test("encodeCrashError: a typed error becomes a plain crash frame, with no code", () => {
  assert.deepEqual(encodeCrashError(new LimitExceededError("Output exceeds 10 characters")), {
    t: "error",
    kind: "crash",
    message: "LimitExceededError: Output exceeds 10 characters",
  });
});

test("encodeCrashError: exhaustion RangeErrors are crashes here (encodeChildError reports them as limits)", () => {
  const error = new RangeError("Invalid string length");
  assert.equal(encodeChildError(error).kind, "limit");
  assert.equal(encodeCrashError(error).kind, "crash");
});

test("encodeCrashError: anything, including values that fight back, yields a bounded one-line crash frame", () => {
  const bomb = new Error("x");
  Object.defineProperty(bomb, "name", {
    get() {
      throw new Error("getter bomb");
    },
  });
  for (const thrown of [bomb, "text", undefined, null, 7, { message: "not an Error" }, new Error(`a\nb ${"z".repeat(10_000)}`)]) {
    const frame = encodeCrashError(thrown);
    assert.equal(frame.kind, "crash");
    assert.equal(frame.code, undefined);
    assert.ok(frame.message.length <= MAX_ERROR_MESSAGE_CHARS + 3, `${frame.message.length} chars`);
    assert.doesNotMatch(frame.message, /\n/);
  }
});

// ---- totality and bounded work -------------------------------------------------------------

test("encodeChildError never throws: a throwing code getter, a throwing message and a throwing Proxy are crashes", () => {
  const hostile: unknown[] = [
    Object.defineProperty(new MalformedDocumentError("x"), "code", {
      get() {
        throw new Error("boom");
      },
    }),
    Object.defineProperty(new Error("x"), "message", {
      get() {
        throw new Error("boom");
      },
    }),
    new Proxy(new MalformedDocumentError("x"), {
      get() {
        throw new Error("trap");
      },
      getPrototypeOf() {
        throw new Error("trap");
      },
    }),
  ];
  for (const thrown of hostile) {
    const frame = encodeChildError(thrown);
    assert.equal(frame.t, "error");
    assert.equal(frame.kind, "crash");
    assert.equal(frame.code, undefined);
  }
});

test("sanitizeText cuts before it scans and never leaves half of a surrogate pair", () => {
  assert.equal(sanitizeText("abc", 10), "abc");
  assert.equal(sanitizeText("a\u0001b", 10), "a?b");
  assert.equal(sanitizeText("abcdef", 3), "abc...");
  // The cut falls between the two halves of U+1F600: the lone high surrogate is dropped, not kept.
  const cut = sanitizeText("aaa\u{1F600}bbb", 4);
  assert.equal(cut, "aaa...");
  assert.doesNotMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])/);
  // Control characters beyond the cut are never looked at, and the result is bounded.
  assert.equal(sanitizeText("x".repeat(10) + "\u0001".repeat(5_000_000), 10), "xxxxxxxxxx...");
});
