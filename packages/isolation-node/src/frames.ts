import {
  IsolationError,
  type IsolatedException,
  type IsolatedParseRecord,
  type IsolatedParseResult,
} from "@spikedpunch/ripstream-core";

/**
 * Child -> parent NDJSON protocol on fd 3. Everything the child sends is
 * untrusted: frames are size-capped before parsing and fully schema-validated
 * after it. Violations are returned as values, never thrown.
 *
 * The reader also validates the ORDER of frames for the arm the caller asked
 * for, as they arrive, and folds the frames into the result itself instead of
 * handing every frame object to the caller to keep. A hostile child can
 * therefore not make the parent hold more than O(payload) memory, and a
 * sequence error is detected (and the child killed) at the offending frame
 * rather than after the whole stream was buffered:
 *
 *   text:    ready, meta, text*, done      (an error frame may end it anywhere after ready)
 *   records: ready, (record bytes*)*, done  (a record that announces `byteLength` is followed by bytes frames that
 *            add up to exactly that; only when the request asked for `unpackBytes`)
 */

export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
/**
 * Most frames of any kind accepted over the stream. A legitimate child chunks
 * text into pieces of KiBs (a 60 MB result is tens of thousands of frames);
 * the smallest possible frame is 24 bytes, so this is also a ~24 MB floor on
 * the byte cap a hostile 1-byte-chunk flood can reach. It bounds parent CPU
 * (one JSON.parse per frame), not memory: retained memory is O(payload).
 */
export const DEFAULT_MAX_FRAMES = 1_000_000;
/**
 * Most keys in one metadata object (a meta frame or one record). Real documents have tens to low thousands, but a
 * legitimate spreadsheet or mail archive can reach tens of thousands, so the bound is generous: it exists to stop a
 * hostile child, and exceeding it is a LimitExceededError like any other size cap.
 */
export const DEFAULT_MAX_METADATA_KEYS = 200_000;
/** Most strings, over all keys, in one metadata object. */
export const DEFAULT_MAX_METADATA_VALUES = 1_000_000;

/** Raw bytes in one bytes frame, at most: the child cuts a document's bytes at this size. */
export const MAX_BYTES_CHUNK = 192 * 1024;

/**
 * Most characters of base64 in one bytes frame, the base64 of MAX_BYTES_CHUNK. A longer chunk is a protocol violation,
 * so the parent never decodes more than this at once whatever the frame cap is.
 */
export const MAX_BYTES_CHUNK_CHARS = (MAX_BYTES_CHUNK / 3) * 4;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ChildErrorKind = "limit" | "timeout" | "malformed" | "abort" | "crash";

const ERROR_KINDS: ReadonlySet<string> = new Set(["limit", "timeout", "malformed", "abort", "crash"]);

/**
 * Terminal failure. `code` is the stable RipstreamErrorCode of the error the child caught; the parent rebuilds
 * the class from its own table (error-codec.ts) and treats anything it does not know as a crash. Without a
 * `code`, `kind` alone selects the class; with one, `kind` is only the fallback for a reader that does not know
 * the code. Every string here is untrusted text.
 */
export interface ErrorFrame {
  readonly t: "error";
  readonly kind: ChildErrorKind;
  /** Untrusted text. */
  readonly message: string;
  readonly code?: string;
  /** Only for code MISSING_DEPENDENCY (the arguments of MissingDependencyError). Untrusted text. */
  readonly dependency?: string;
  /** Only for code MISSING_DEPENDENCY. Untrusted text. */
  readonly capability?: string;
}

export type Frame =
  | { readonly t: "ready"; readonly pid: number }
  | { readonly t: "meta"; readonly metadata: Record<string, string[]>; readonly exception?: IsolatedException }
  | { readonly t: "text"; readonly chunk: string }
  /** `byteLength`: the embedded document's bytes follow in bytes frames (0: it is empty). Only with `unpackBytes`. */
  | { readonly t: "record"; readonly record: IsolatedParseRecord; readonly byteLength?: number }
  | { readonly t: "bytes"; readonly data: Uint8Array }
  | { readonly t: "done" }
  | ErrorFrame;

/**
 * "frame_too_large", "total_too_large" and "metadata_cap" are size limits (the parent reports a LimitExceededError);
 * "protocol" is a malformed or out-of-order stream (an IsolationError crash).
 */
export type FrameViolationKind = "frame_too_large" | "total_too_large" | "metadata_cap" | "protocol";

export type FrameEvent =
  | { readonly type: "frame"; readonly frame: Frame }
  | { readonly type: "violation"; readonly kind: FrameViolationKind; readonly message: string };

export interface FrameReaderOptions {
  /** Longest accepted line in bytes, excluding the newline. Default 1 MiB. */
  readonly maxFrameBytes?: number;
  /** Most bytes accepted over the whole stream, newlines included. */
  readonly maxTotalBytes: number;
  /** The arm the caller asked for; it decides which frame order is legal. */
  readonly output: "text" | "records";
  /** Most frames accepted over the stream. Default DEFAULT_MAX_FRAMES. */
  readonly maxFrames?: number;
  /** Most keys in one metadata object. Default DEFAULT_MAX_METADATA_KEYS. */
  readonly maxMetadataKeys?: number;
  /** Most strings in one metadata object. Default DEFAULT_MAX_METADATA_VALUES. */
  readonly maxMetadataValues?: number;
  /**
   * Records output only: the most bytes of embedded documents accepted over the stream (the request's
   * `unpackBytes`). Omitted: the child may send none.
   */
  readonly unpackBytes?: number;
}

interface MetadataLimits {
  readonly maxKeys: number;
  readonly maxValues: number;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function checkPositiveInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer, got ${String(value)}`);
  }
  return value;
}

/**
 * Stateful reader for the fd-3 byte stream. Feed chunks with `push`; call
 * `finish` when the stream ends. After the first violation, or after the
 * terminal frame, all further input is ignored.
 */
export class FrameReader {
  readonly #maxFrameBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxFrames: number;
  readonly #output: "text" | "records";
  readonly #limits: MetadataLimits;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  /** The partial line (bytes up to the first newline not seen yet): ONE buffer that grows by doubling. */
  #line = new Uint8Array(0);
  #lineLength = 0;
  #lineAllocations = 0;
  #totalBytes = 0;
  #frameCount = 0;
  #sawReady = false;
  #terminal: "done" | "error" | null = null;
  #errorFrame: ErrorFrame | null = null;
  #violation: Extract<FrameEvent, { type: "violation" }> | null = null;
  // The result, folded as the frames arrive. Frame objects themselves are not kept.
  #metadata: Record<string, string[]> | null = null;
  #exception: IsolatedException | null = null;
  #chunks: string[] = [];
  #records: IsolatedParseRecord[] = [];
  #result: IsolatedParseResult | null = null;
  readonly #unpackBytes: number;
  /** Bytes announced so far, over all records. */
  #unpackAnnounced = 0;
  /** The record whose bytes are still arriving. */
  #owing: { readonly index: number; readonly parts: Uint8Array[]; remaining: number; readonly length: number } | null = null;

  constructor(options: FrameReaderOptions) {
    this.#maxFrameBytes = checkPositiveInteger(
      "maxFrameBytes",
      options.maxFrameBytes === undefined ? DEFAULT_MAX_FRAME_BYTES : options.maxFrameBytes,
    );
    this.#maxTotalBytes = checkPositiveInteger("maxTotalBytes", options.maxTotalBytes);
    this.#maxFrames = checkPositiveInteger("maxFrames", options.maxFrames === undefined ? DEFAULT_MAX_FRAMES : options.maxFrames);
    this.#limits = {
      maxKeys: checkPositiveInteger(
        "maxMetadataKeys",
        options.maxMetadataKeys === undefined ? DEFAULT_MAX_METADATA_KEYS : options.maxMetadataKeys,
      ),
      maxValues: checkPositiveInteger(
        "maxMetadataValues",
        options.maxMetadataValues === undefined ? DEFAULT_MAX_METADATA_VALUES : options.maxMetadataValues,
      ),
    };
    if (options.output !== "text" && options.output !== "records") {
      throw new TypeError(`output must be "text" or "records", got ${String(options.output)}`);
    }
    this.#output = options.output;
    if (options.unpackBytes !== undefined) {
      if (options.output !== "records") throw new TypeError('unpackBytes needs output "records"');
      if (!Number.isSafeInteger(options.unpackBytes) || options.unpackBytes < 0) {
        throw new RangeError(`unpackBytes must be a non-negative safe integer, got ${String(options.unpackBytes)}`);
      }
    }
    this.#unpackBytes = options.unpackBytes ?? 0;
  }

  /** Frames accepted so far, of every kind. */
  get frameCount(): number {
    return this.#frameCount;
  }

  /** @internal Allocated size of the partial-line buffer; O(bytes of the partial line), never O(chunks). */
  get partialLineCapacity(): number {
    return this.#line.length;
  }

  /** @internal How many partial-line buffers were allocated: O(log bytes) because the buffer doubles. */
  get partialLineAllocations(): number {
    return this.#lineAllocations;
  }

  /** @internal Text chunks plus records held for the result; 0 after a violation (nothing is kept for a failed stream). */
  get retainedPieces(): number {
    return this.#chunks.length + this.#records.length;
  }

  /** "post-ready" once the ready frame was accepted. */
  get phase(): "pre-ready" | "post-ready" {
    return this.#sawReady ? "post-ready" : "pre-ready";
  }

  /** The terminal frame received, if any. Final: nothing after it changes it. */
  get terminal(): "done" | "error" | null {
    return this.#terminal;
  }

  get errorFrame(): ErrorFrame | null {
    return this.#errorFrame;
  }

  get violation(): Extract<FrameEvent, { type: "violation" }> | null {
    return this.#violation;
  }

  /**
   * Feeds bytes. Once a violation OR a terminal frame ("done" | "error") has been accepted, all further input is
   * ignored: the terminal verdict is final. Nothing after it can fail the stream, so nothing after it can discard
   * the result already folded (the supervisor acts on the terminal frame at once and group-kills the child once
   * its grace period is over, so bytes that arrive later are only noise).
   */
  push(chunk: Uint8Array): FrameEvent[] {
    if (this.#violation !== null || this.#terminal !== null) return [];
    const events: FrameEvent[] = [];

    const allowed = this.#maxTotalBytes - this.#totalBytes;
    const overTotal = chunk.length > allowed;
    const accepted = overTotal ? chunk.subarray(0, allowed) : chunk;
    this.#totalBytes += accepted.length;

    let offset = 0;
    while (offset < accepted.length) {
      const newline = accepted.indexOf(NEWLINE, offset);
      const end = newline === -1 ? accepted.length : newline;
      const segment = accepted.subarray(offset, end);

      if (this.#lineLength + segment.length > this.#maxFrameBytes) {
        this.#fail(events, "frame_too_large", `frame exceeds ${this.#maxFrameBytes} bytes`);
        return events;
      }

      if (newline === -1) {
        // Copy: the caller may reuse its buffer after push returns.
        this.#append(segment);
        break;
      }

      let line = segment;
      if (this.#lineLength > 0) {
        this.#append(segment);
        line = this.#line.subarray(0, this.#lineLength);
      }
      this.#lineLength = 0;
      if (!this.#acceptLine(line, events)) return events;
      if (this.#terminal !== null) return events; // the rest of this chunk, whatever it is, is ignored
      offset = newline + 1;
    }

    if (overTotal) {
      this.#fail(events, "total_too_large", `result exceeds ${this.#maxTotalBytes} bytes`);
    }
    return events;
  }

  /** Call when the stream ends. A partial last line is a protocol violation (unless the stream already ended with its terminal frame). */
  finish(): FrameEvent[] {
    if (this.#violation !== null || this.#terminal !== null || this.#lineLength === 0) return [];
    const events: FrameEvent[] = [];
    this.#fail(events, "protocol", "stream ended inside a frame (missing newline)");
    return events;
  }

  /**
   * Adds `segment` to the partial line. The caller has checked that the line stays within maxFrameBytes, so
   * the buffer never grows past it. Growth by doubling keeps the cost O(bytes) however small the chunks are.
   */
  #append(segment: Uint8Array): void {
    const needed = this.#lineLength + segment.length;
    if (needed > this.#line.length) {
      const grown = new Uint8Array(Math.min(Math.max(needed, this.#line.length * 2, 4096), this.#maxFrameBytes));
      grown.set(this.#line.subarray(0, this.#lineLength));
      this.#line = grown;
      this.#lineAllocations += 1;
    }
    this.#line.set(segment, this.#lineLength);
    this.#lineLength = needed;
  }

  #fail(events: FrameEvent[], kind: FrameViolationKind, message: string): void {
    const violation = { type: "violation", kind, message } as const;
    this.#violation = violation;
    this.#line = new Uint8Array(0);
    this.#lineLength = 0;
    this.#chunks = [];
    this.#records = [];
    this.#owing = null;
    events.push(violation);
  }

  /** Returns false after recording a violation. */
  #acceptLine(line: Uint8Array, events: FrameEvent[]): boolean {
    if (this.#frameCount >= this.#maxFrames) {
      this.#fail(events, "protocol", `more than ${this.#maxFrames} frames`);
      return false;
    }
    if (line.includes(CARRIAGE_RETURN)) {
      // JSON would accept CR as whitespace; the protocol is strict "\n" framing.
      this.#fail(events, "protocol", "frame contains a carriage return");
      return false;
    }
    let value: unknown;
    try {
      value = JSON.parse(this.#decoder.decode(line));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unparseable";
      this.#fail(events, "protocol", `frame is not valid UTF-8 JSON: ${reason}`);
      return false;
    }
    let parsed: Frame | string;
    try {
      parsed = validateFrame(value, this.#limits);
    } catch (error) {
      if (!(error instanceof MetadataCapError)) throw error;
      this.#fail(events, "metadata_cap", error.message);
      return false;
    }
    if (typeof parsed === "string") {
      this.#fail(events, "protocol", parsed);
      return false;
    }
    let orderError: string | null;
    try {
      orderError = this.#checkOrder(parsed);
    } catch (error) {
      if (!(error instanceof UnpackBudgetError)) throw error;
      this.#fail(events, "total_too_large", error.message);
      return false;
    }
    if (orderError !== null) {
      this.#fail(events, "protocol", orderError);
      return false;
    }
    this.#frameCount += 1;
    events.push({ type: "frame", frame: parsed });
    return true;
  }

  /** Checks `frame` against the sequence rules and folds it into the result. Returns what is wrong, or null. */
  #checkOrder(frame: Frame): string | null {
    if (this.#terminal !== null) return `"${frame.t}" frame after "${this.#terminal}"`;
    if (frame.t === "ready") {
      if (this.#sawReady) return 'second "ready" frame';
      this.#sawReady = true;
      return null;
    }
    if (!this.#sawReady) return `"${frame.t}" frame before "ready"`;

    switch (frame.t) {
      case "meta":
        if (this.#output !== "text") return '"meta" frame for records output';
        if (this.#metadata !== null) return 'second "meta" frame';
        this.#metadata = frame.metadata;
        this.#exception = frame.exception ?? null;
        return null;
      case "text":
        if (this.#output !== "text") return '"text" frame for records output';
        if (this.#metadata === null) return '"text" frame before "meta"';
        // An empty chunk adds nothing; not keeping it also keeps a flood of them free.
        if (frame.chunk.length > 0) this.#chunks.push(frame.chunk);
        return null;
      case "record":
        if (this.#output !== "records") return '"record" frame for text output';
        if (this.#owing !== null) return '"record" frame while the bytes of the last record are still owed';
        return this.#acceptRecord(frame.record, frame.byteLength);
      case "bytes":
        if (this.#output !== "records") return '"bytes" frame for text output';
        return this.#acceptBytes(frame.data);
      case "done":
        if (this.#output === "text" && this.#metadata === null) return '"done" frame before "meta" for text output';
        if (this.#owing !== null) return '"done" frame while the bytes of the last record are still owed';
        this.#terminal = "done";
        return null;
      case "error":
        this.#terminal = "error";
        this.#errorFrame = frame;
        return null;
    }
  }

  /** A record, and the bytes it announces. The announced length is checked against the budget before any byte is kept. */
  #acceptRecord(record: IsolatedParseRecord, byteLength: number | undefined): string | null {
    this.#records.push(record);
    if (byteLength === undefined) return null;
    if (this.#unpackBytes === 0 && byteLength > 0) return "record announces bytes, but none were asked for";
    if (this.#unpackAnnounced + byteLength > this.#unpackBytes) {
      throw new UnpackBudgetError(`embedded bytes exceed the unpackBytes budget of ${this.#unpackBytes}`);
    }
    this.#unpackAnnounced += byteLength;
    const index = this.#records.length - 1;
    if (byteLength === 0) this.#records[index] = { ...record, bytes: new Uint8Array(0) };
    else this.#owing = { index, parts: [], remaining: byteLength, length: byteLength };
    return null;
  }

  #acceptBytes(data: Uint8Array): string | null {
    const owing = this.#owing;
    if (owing === null) return '"bytes" frame with no record waiting for bytes';
    if (data.length > owing.remaining) return `"bytes" frame of ${data.length} bytes, ${owing.remaining} were owed`;
    owing.parts.push(data);
    owing.remaining -= data.length;
    if (owing.remaining > 0) return null;
    const whole = new Uint8Array(owing.length);
    let offset = 0;
    for (const part of owing.parts) {
      whole.set(part, offset);
      offset += part.length;
    }
    this.#records[owing.index] = { ...this.#records[owing.index]!, bytes: whole };
    this.#owing = null;
    return null;
  }

  /**
   * The folded result of a successful stream. Throws IsolationError("crash") unless a "done" frame was
   * accepted: the sequence rules were enforced frame by frame, so after "done" the result is well formed.
   */
  result(): IsolatedParseResult {
    if (this.#result !== null) return this.#result;
    if (this.#terminal !== "done") {
      throw protocolFailure('result requested but the stream did not end with "done"');
    }
    if (this.#output === "records") {
      this.#result = { kind: "records", records: this.#records };
      this.#records = [];
    } else {
      if (this.#metadata === null) throw protocolFailure('text output has no "meta" frame');
      this.#result = {
        kind: "text",
        metadata: this.#metadata,
        text: this.#chunks.join(""),
        ...(this.#exception === null ? {} : { exception: this.#exception }),
      };
      this.#chunks = [];
    }
    return this.#result;
  }
}

// ---- validation -------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Obj, allowed: readonly string[]): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return `unexpected field "${key}"`;
  }
  return null;
}

/**
 * Child metadata is untrusted: bounded in keys and values (the frame cap alone allows ~80,000 tiny keys per
 * frame, which would cost the parent ten times the wire size), and stripped of `__proto__`. That key would
 * otherwise be an OWN property here, and a later `Object.assign(target, metadata)` would run the setter and
 * swap `target`'s prototype. `constructor` and the rest are harmless own properties and stay.
 */
/**
 * Thrown by validateMetadata when a metadata object is over its key or value bound, so the cap reaches the reader
 * as a size limit and not as the string every other validation failure travels as (a protocol violation).
 * Caught only in FrameReader.#acceptLine.
 */
class MetadataCapError extends Error {}

/** Thrown by `#acceptRecord` when a record announces more bytes than the request's budget allows: a size limit, not a protocol fault. */
class UnpackBudgetError extends Error {}

function validateMetadata(value: unknown, limits: MetadataLimits): Record<string, string[]> | string {
  if (!isObject(value)) return "metadata must be an object";
  const keys = Object.keys(value);
  if (keys.length > limits.maxKeys) throw new MetadataCapError(`metadata has more than ${limits.maxKeys} keys`);
  let values = 0;
  const entries: [string, string[]][] = [];
  for (const key of keys) {
    const list = value[key];
    if (!Array.isArray(list)) return `metadata["${key}"] must be an array of strings`;
    values += list.length;
    if (values > limits.maxValues) throw new MetadataCapError(`metadata has more than ${limits.maxValues} values`);
    if (!list.every((item) => typeof item === "string")) return `metadata["${key}"] must be an array of strings`;
    if (key !== "__proto__") entries.push([key, list as string[]]);
  }
  return Object.fromEntries(entries);
}

function validateRecord(value: unknown, limits: MetadataLimits): IsolatedParseRecord | string {
  if (!isObject(value)) return "record must be an object";
  const extra = onlyKeys(value, [
    "metadata",
    "content",
    "embeddedResourcePath",
    "depth",
    "mediaType",
    "exception",
  ]);
  if (extra !== null) return `record: ${extra}`;
  const metadata = validateMetadata(value.metadata, limits);
  if (typeof metadata === "string") return `record: ${metadata}`;
  if (typeof value.content !== "string") return "record.content must be a string";
  if (typeof value.embeddedResourcePath !== "string") return "record.embeddedResourcePath must be a string";
  if (typeof value.mediaType !== "string") return "record.mediaType must be a string";
  if (typeof value.depth !== "number" || !Number.isSafeInteger(value.depth) || value.depth < 0) {
    return "record.depth must be a non-negative integer";
  }
  const exception = value.exception === null ? null : validateException(value.exception, "record.exception");
  if (typeof exception === "string") return exception;
  return {
    metadata,
    content: value.content,
    embeddedResourcePath: value.embeddedResourcePath,
    depth: value.depth,
    mediaType: value.mediaType,
    exception,
  };
}

/** A failure as the child describes it: three plain strings, nothing else. */
function validateException(value: unknown, where: string): IsolatedException | string {
  if (!isObject(value)) return `${where} must be an object`;
  if (onlyKeys(value, ["name", "message", "code"]) !== null) return `${where} has unexpected fields`;
  if (typeof value.name !== "string" || typeof value.message !== "string") {
    return `${where}.name and message must be strings`;
  }
  if (value.code !== undefined && typeof value.code !== "string") return `${where}.code must be a string`;
  return value.code === undefined
    ? { name: value.name, message: value.message }
    : { name: value.name, message: value.message, code: value.code };
}

/** Returns the typed frame, or a description of what is wrong with it. */
function validateFrame(value: unknown, limits: MetadataLimits): Frame | string {
  if (!isObject(value)) return "frame must be a JSON object";
  switch (value.t) {
    case "ready": {
      const extra = onlyKeys(value, ["t", "pid"]);
      if (extra !== null) return `ready: ${extra}`;
      if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1) {
        return "ready.pid must be a positive integer";
      }
      return { t: "ready", pid: value.pid };
    }
    case "meta": {
      const extra = onlyKeys(value, ["t", "metadata", "exception"]);
      if (extra !== null) return `meta: ${extra}`;
      const metadata = validateMetadata(value.metadata, limits);
      if (typeof metadata === "string") return `meta: ${metadata}`;
      if (value.exception === undefined) return { t: "meta", metadata };
      const exception = validateException(value.exception, "meta.exception");
      return typeof exception === "string" ? exception : { t: "meta", metadata, exception };
    }
    case "text": {
      const extra = onlyKeys(value, ["t", "chunk"]);
      if (extra !== null) return `text: ${extra}`;
      if (typeof value.chunk !== "string") return "text.chunk must be a string";
      return { t: "text", chunk: value.chunk };
    }
    case "record": {
      const extra = onlyKeys(value, ["t", "record", "byteLength"]);
      if (extra !== null) return `record frame: ${extra}`;
      const record = validateRecord(value.record, limits);
      if (typeof record === "string") return record;
      if (value.byteLength === undefined) return { t: "record", record };
      if (typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
        return "record frame: byteLength must be a non-negative integer";
      }
      return { t: "record", record, byteLength: value.byteLength };
    }
    case "bytes": {
      const extra = onlyKeys(value, ["t", "chunk"]);
      if (extra !== null) return `bytes: ${extra}`;
      if (typeof value.chunk !== "string") return "bytes.chunk must be a string";
      if (value.chunk.length === 0) return "bytes.chunk must not be empty";
      if (value.chunk.length > MAX_BYTES_CHUNK_CHARS) return `bytes.chunk is over ${MAX_BYTES_CHUNK_CHARS} characters`;
      if (!BASE64.test(value.chunk)) return "bytes.chunk is not base64";
      return { t: "bytes", data: new Uint8Array(Buffer.from(value.chunk, "base64")) };
    }
    case "done": {
      const extra = onlyKeys(value, ["t"]);
      return extra !== null ? `done: ${extra}` : { t: "done" };
    }
    case "error": {
      const extra = onlyKeys(value, ["t", "kind", "message", "code", "dependency", "capability"]);
      if (extra !== null) return `error: ${extra}`;
      if (typeof value.kind !== "string" || !ERROR_KINDS.has(value.kind)) {
        return "error.kind is not a known kind";
      }
      if (typeof value.message !== "string") return "error.message must be a string";
      for (const name of ["code", "dependency", "capability"] as const) {
        if (value[name] !== undefined && typeof value[name] !== "string") return `error.${name} must be a string`;
      }
      const kind = value.kind as ChildErrorKind;
      return {
        t: "error",
        kind,
        message: value.message,
        ...(value.code === undefined ? {} : { code: value.code as string }),
        ...(value.dependency === undefined ? {} : { dependency: value.dependency as string }),
        ...(value.capability === undefined ? {} : { capability: value.capability as string }),
      };
    }
    default:
      return "unknown frame type";
  }
}

function protocolFailure(message: string): IsolationError {
  return new IsolationError("crash", `Isolated parser protocol violation: ${message}`);
}
