import {
  DEFAULT_LIMITS,
  IsolationError,
  type IsolatedException,
  type IsolatedParseRecord,
  type IsolatedParseResult,
  type IsolatedSegment,
  parseSegmentLocation,
  type PathPart,
  type PathPartKind,
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
 *   A child that serves several requests sends "accepted" right after "ready" (option `acceptance`).
 *   records: ready, (record text* segments* bytes*)*, done  (a record that announces `contentLength` is followed by
 *            text frames that add up to exactly that many characters; one that announces `segmentCount` then by
 *            segments frames that add up to exactly that many segments, and only when the request asked for
 *            segments; one that announces `byteLength` then by bytes frames that add up to exactly that, and only
 *            when the request asked for `unpackBytes`)
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
 * Most keys in one metadata object (a meta frame or one record). Core caps a document's metadata at
 * `maxMetadataTotalChars`, counting every name as its length plus one and every value likewise, so a document has at
 * most half that many keys (a name and one value cost at least 2). Sizing this to core's cap, not to a smaller guess,
 * keeps it from refusing a document that core accepted (tikajs-vaak); it still stops a hostile child.
 */
export const DEFAULT_MAX_METADATA_KEYS = DEFAULT_LIMITS.maxMetadataTotalChars / 2;
/** Most strings, over all keys, in one metadata object: core's total cap, as a value costs at least 1 of it. */
export const DEFAULT_MAX_METADATA_VALUES = DEFAULT_LIMITS.maxMetadataTotalChars;

/**
 * Text frames carry at most this many UTF-16 code units: ~384 KiB of JSON in the worst (all-escaped) case, far below
 * the 1 MiB frame cap. A record whose content is longer is sent as a record frame without content and then text frames
 * (`contentLength`); a shorter one carries its content inline.
 */
export const MAX_TEXT_CHUNK_CHARS = 64 * 1024;

/**
 * Most segments in one `segments` frame (tikajs-9ztw). The child also cuts a frame once the strings in it come to
 * MAX_TEXT_CHUNK_CHARS characters, so one frame is at most about 1024 x 100 bytes of structure plus 6 x that many
 * characters of strings on the wire, far below the frame cap; the parent parses one frame at a time and keeps only
 * the segments.
 */
export const MAX_SEGMENTS_PER_FRAME = 1024;

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
  /** Only for code LIMIT_EXCEEDED: which limit (a LimitReason; the parent ignores a name it does not know). */
  readonly limit?: string;
  /** Only for code LIMIT_EXCEEDED: how far the document got, when the child knew. A finite, non-negative number. */
  readonly observed?: number;
  /** Only for code LIMIT_EXCEEDED: the limit's value, in the unit of `observed`. A finite, non-negative number. */
  readonly max?: number;
}

export type Frame =
  | { readonly t: "ready"; readonly pid: number }
  /** Serving children only: the request was read whole and parsing begins (see FrameReaderOptions.acceptance). */
  | { readonly t: "accepted" }
  | { readonly t: "meta"; readonly metadata: Record<string, string[]>; readonly exception?: IsolatedException }
  | { readonly t: "text"; readonly chunk: string }
  /**
   * `contentLength`: the record's `content` (empty in `record`) follows in text frames of that many characters in
   * all; segments are checked against it. `segmentCount`: the record's segments (`record.segments` is never set by
   * the child) follow in segments frames, that many in all, after the text; 0 is a record with an empty list. Only
   * when segments were asked for. `byteLength`: the embedded document's bytes follow in bytes frames (0: it is
   * empty), after the segments. Only with `unpackBytes`.
   */
  | {
      readonly t: "record";
      readonly record: IsolatedParseRecord;
      readonly contentLength?: number;
      readonly segmentCount?: number;
      readonly byteLength?: number;
    }
  | { readonly t: "segments"; readonly segments: IsolatedSegment[] }
  | { readonly t: "bytes"; readonly data: Uint8Array }
  | { readonly t: "done" }
  | ErrorFrame;

/**
 * "frame_too_large", "total_too_large", "segment_cap" and "metadata_cap" are size limits (the parent reports a LimitExceededError);
 * "protocol" is a malformed or out-of-order stream (an IsolationError crash).
 */
export type FrameViolationKind = "frame_too_large" | "total_too_large" | "segment_cap" | "metadata_cap" | "protocol";

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
  /**
   * Records output only: the most bytes of `segments` frames (newlines included) accepted over the stream, which is
   * also what the parent reserves memory for (runner.ts). Omitted: the child may send no segments.
   */
  readonly maxSegmentBytes?: number;
  /**
   * A child that serves several requests (warm.ts) sends an "accepted" frame once it has read a request whole and is
   * about to parse it. With this set the reader requires exactly one, right after "ready" and before anything but an
   * error; without it the frame is refused. The parent uses it to tell a child that died before it started a request
   * (which can be run again) from one that died parsing it (tikajs-krih).
   */
  readonly acceptance?: boolean;
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
  #accepted = false;
  readonly #acceptance: boolean;
  #terminal: "done" | "error" | null = null;
  #trailingBytes = false;
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
  /** The record whose content is still arriving in text frames. */
  #owingText: { readonly index: number; readonly parts: string[]; remaining: number } | null = null;
  readonly #maxSegmentBytes: number;
  /** Bytes of segments frames so far, over all records. */
  #segmentBytes = 0;
  /** The record whose segments follow its content: they are owed once the content is complete. */
  #pendingSegments: { readonly index: number; readonly parts: IsolatedSegment[]; remaining: number; readonly contentLength: number } | null = null;
  /** The record whose segments are still arriving in segments frames. */
  #owingSegments: { readonly index: number; readonly parts: IsolatedSegment[]; remaining: number; readonly contentLength: number } | null = null;

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
    if (options.maxSegmentBytes !== undefined) {
      if (options.output !== "records") throw new TypeError('maxSegmentBytes needs output "records"');
      if (!Number.isSafeInteger(options.maxSegmentBytes) || options.maxSegmentBytes < 0) {
        throw new RangeError(`maxSegmentBytes must be a non-negative safe integer, got ${String(options.maxSegmentBytes)}`);
      }
    }
    this.#maxSegmentBytes = options.maxSegmentBytes ?? -1;
    this.#acceptance = options.acceptance ?? false;
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

  /** Whether the child sent "accepted": it read the request whole and was about to parse it. */
  get accepted(): boolean {
    return this.#accepted;
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
   * Whether any byte arrived after the terminal frame (the rest of its chunk, or a later push). They never change the
   * verdict; a one-shot child is killed after its grace anyway, but a child kept for another request must have
   * written nothing past its answer, or it is retired (warm.ts).
   */
  get trailingBytes(): boolean {
    return this.#trailingBytes;
  }

  /**
   * Feeds bytes. Once a violation OR a terminal frame ("done" | "error") has been accepted, all further input is
   * ignored: the terminal verdict is final. Nothing after it can fail the stream, so nothing after it can discard
   * the result already folded (the supervisor acts on the terminal frame at once and group-kills the child once
   * its grace period is over, so bytes that arrive later are only noise).
   */
  push(chunk: Uint8Array): FrameEvent[] {
    if (this.#terminal !== null && chunk.length > 0) this.#trailingBytes = true;
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
      if (this.#terminal !== null) {
        // The rest of this chunk, whatever it is, is ignored. A reused child must not write past its answer.
        if (newline + 1 < chunk.length) this.#trailingBytes = true;
        return events;
      }
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
    this.#owingText = null;
    this.#owingSegments = null;
    this.#pendingSegments = null;
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
      orderError = this.#checkOrder(parsed, line.length + 1);
    } catch (error) {
      if (error instanceof SegmentBudgetError) {
        this.#fail(events, "segment_cap", error.message);
        return false;
      }
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
  #checkOrder(frame: Frame, wireBytes: number): string | null {
    if (this.#terminal !== null) return `"${frame.t}" frame after "${this.#terminal}"`;
    if (frame.t === "ready") {
      if (this.#sawReady) return 'second "ready" frame';
      this.#sawReady = true;
      return null;
    }
    if (!this.#sawReady) return `"${frame.t}" frame before "ready"`;
    if (frame.t === "accepted") {
      if (!this.#acceptance) return '"accepted" frame from a child that serves one request';
      if (this.#accepted) return 'second "accepted" frame';
      this.#accepted = true;
      return null;
    }
    if (this.#acceptance && !this.#accepted && frame.t !== "error") return `"${frame.t}" frame before "accepted"`;

    switch (frame.t) {
      case "meta":
        if (this.#output !== "text") return '"meta" frame for records output';
        if (this.#metadata !== null) return 'second "meta" frame';
        this.#metadata = frame.metadata;
        this.#exception = frame.exception ?? null;
        return null;
      case "text":
        if (this.#output === "records") {
          if (this.#owingSegments !== null) return '"text" frame while the segments of the last record are still owed';
          return this.#acceptContent(frame.chunk);
        }
        if (this.#metadata === null) return '"text" frame before "meta"';
        // An empty chunk adds nothing; not keeping it also keeps a flood of them free.
        if (frame.chunk.length > 0) this.#chunks.push(frame.chunk);
        return null;
      case "record":
        if (this.#output !== "records") return '"record" frame for text output';
        if (this.#owingText !== null) return '"record" frame while the content of the last record is still owed';
        if (this.#owingSegments !== null) return '"record" frame while the segments of the last record are still owed';
        if (this.#owing !== null) return '"record" frame while the bytes of the last record are still owed';
        return this.#acceptRecord(frame.record, frame.contentLength, frame.segmentCount, frame.byteLength);
      case "segments":
        if (this.#output !== "records") return '"segments" frame for text output';
        if (this.#owingText !== null) return '"segments" frame while the content of the last record is still owed';
        return this.#acceptSegments(frame.segments, wireBytes);
      case "bytes":
        if (this.#output !== "records") return '"bytes" frame for text output';
        if (this.#owingText !== null) return '"bytes" frame while the content of the last record is still owed';
        if (this.#owingSegments !== null) return '"bytes" frame while the segments of the last record are still owed';
        return this.#acceptBytes(frame.data);
      case "done":
        if (this.#output === "text" && this.#metadata === null) return '"done" frame before "meta" for text output';
        if (this.#owingText !== null) return '"done" frame while the content of the last record is still owed';
        if (this.#owingSegments !== null) return '"done" frame while the segments of the last record are still owed';
        if (this.#owing !== null) return '"done" frame while the bytes of the last record are still owed';
        this.#terminal = "done";
        return null;
      case "error":
        this.#terminal = "error";
        this.#errorFrame = frame;
        return null;
    }
  }

  /** A record, the content and the bytes it announces. The announced byte length is checked against the budget before any byte is kept. */
  #acceptRecord(
    record: IsolatedParseRecord,
    contentLength: number | undefined,
    segmentCount: number | undefined,
    byteLength: number | undefined,
  ): string | null {
    if (segmentCount !== undefined && this.#maxSegmentBytes < 0) return "record announces segments, but none were asked for";
    this.#records.push(record);
    const index = this.#records.length - 1;
    if (contentLength !== undefined) {
      this.#owingText = { index, parts: [], remaining: contentLength };
    }
    if (segmentCount === 0) this.#records[index] = { ...record, segments: [] };
    else if (segmentCount !== undefined) {
      const owed = { index, parts: [], remaining: segmentCount, contentLength: contentLength ?? record.content.length };
      if (this.#owingText === null) this.#owingSegments = owed;
      else this.#pendingSegments = owed;
    }
    if (byteLength === undefined) return null;
    if (this.#unpackBytes === 0 && byteLength > 0) return "record announces bytes, but none were asked for";
    if (this.#unpackAnnounced + byteLength > this.#unpackBytes) {
      throw new UnpackBudgetError(`embedded bytes exceed the unpackBytes budget of ${this.#unpackBytes}`);
    }
    this.#unpackAnnounced += byteLength;
    if (byteLength === 0) this.#records[index] = { ...record, bytes: new Uint8Array(0) };
    else this.#owing = { index, parts: [], remaining: byteLength, length: byteLength };
    return null;
  }

  /** A text frame of a records stream: the next piece of the content the last record announced. */
  #acceptContent(chunk: string): string | null {
    const owing = this.#owingText;
    if (owing === null) return '"text" frame with no record waiting for content';
    if (chunk.length === 0) return '"text" frame of a record\'s content must not be empty';
    if (chunk.length > owing.remaining) return `"text" frame of ${chunk.length} characters, ${owing.remaining} were owed`;
    owing.parts.push(chunk);
    owing.remaining -= chunk.length;
    if (owing.remaining > 0) return null;
    this.#records[owing.index] = { ...this.#records[owing.index]!, content: owing.parts.join("") };
    this.#owingText = null;
    this.#owingSegments = this.#pendingSegments;
    this.#pendingSegments = null;
    return null;
  }

  /** A segments frame: the next segments of the last record, checked against its content and the segment budget. */
  #acceptSegments(segments: IsolatedSegment[], wireBytes: number): string | null {
    const owing = this.#owingSegments;
    if (owing === null) return '"segments" frame with no record waiting for segments';
    if (segments.length === 0) return '"segments" frame must not be empty';
    if (segments.length > owing.remaining) return `"segments" frame of ${segments.length} segments, ${owing.remaining} were owed`;
    this.#segmentBytes += wireBytes;
    if (this.#segmentBytes > this.#maxSegmentBytes) {
      throw new SegmentBudgetError(`segments exceed ${this.#maxSegmentBytes} bytes`);
    }
    for (const segment of segments) {
      if (segment.end > owing.contentLength) return "segment end is past the record's content";
      owing.parts.push(segment);
    }
    owing.remaining -= segments.length;
    if (owing.remaining > 0) return null;
    this.#records[owing.index] = { ...this.#records[owing.index]!, segments: owing.parts };
    this.#owingSegments = null;
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

/** Thrown by `#acceptSegments` when the segments frames add up to more than the request's segment budget: a size limit. */
class SegmentBudgetError extends Error {}

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

/** `contentLength`: the record frame announced its content in text frames, so `content` must be empty. */
function validateRecord(value: unknown, limits: MetadataLimits, contentLength?: number): IsolatedParseRecord | string {
  if (!isObject(value)) return "record must be an object";
  const extra = onlyKeys(value, [
    "metadata",
    "content",
    "embeddedResourcePath",
    "pathParts",
    "depth",
    "mediaType",
    "exception",
  ]);
  if (extra !== null) return `record: ${extra}`;
  const metadata = validateMetadata(value.metadata, limits);
  if (typeof metadata === "string") return `record: ${metadata}`;
  if (typeof value.content !== "string") return "record.content must be a string";
  if (contentLength !== undefined && value.content.length > 0) return "record.content must be empty when contentLength is announced";
  if (typeof value.embeddedResourcePath !== "string") return "record.embeddedResourcePath must be a string";
  const pathParts = value.pathParts === undefined ? undefined : validatePathParts(value.pathParts);
  if (typeof pathParts === "string") return pathParts;
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
    ...(pathParts === undefined ? {} : { pathParts }),
    depth: value.depth,
    mediaType: value.mediaType,
    exception,
  };
}

/**
 * `segments.segments`: a list of `{ start, end, labels, location }`, each a slice of the record's content with string
 * labels and a location in the closed grammar. The reader checks `end` against the record's content length, which a
 * frame does not know.
 */
function validateSegments(value: unknown): IsolatedSegment[] | string {
  if (!Array.isArray(value)) return "segments.segments must be an array";
  if (value.length > MAX_SEGMENTS_PER_FRAME) return `segments frame has more than ${MAX_SEGMENTS_PER_FRAME} segments`;
  const segments: IsolatedSegment[] = [];
  for (const segment of value as unknown[]) {
    if (!isObject(segment)) return "segments[] must be objects";
    const extra = onlyKeys(segment, ["start", "end", "labels", "location"]);
    if (extra !== null) return `segments[]: ${extra}`;
    const { start, end, labels, location } = segment;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)) {
      return "segments[] must have integer offsets with 0 <= start < end";
    }
    if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
      return "segments[].labels must be an array of strings";
    }
    if (typeof location !== "string") return "segments[].location must be a string";
    try {
      parseSegmentLocation(location);
    } catch {
      return "segments[].location is not a segment location";
    }
    segments.push({ start: start as number, end: end as number, labels: labels as string[], location });
  }
  return segments;
}

const PATH_PART_KINDS: readonly string[] = ["root", "entry", "embedded"] satisfies readonly PathPartKind[];

/** `record.pathParts`: a list of `{ kind, name }`, the kind one of the closed set, the name a string. */
function validatePathParts(value: unknown): PathPart[] | string {
  if (!Array.isArray(value)) return "record.pathParts must be an array";
  const parts: PathPart[] = [];
  for (const part of value as unknown[]) {
    if (!isObject(part)) return "record.pathParts[] must be objects";
    const extra = onlyKeys(part, ["kind", "name"]);
    if (extra !== null) return `record.pathParts[]: ${extra}`;
    if (typeof part.kind !== "string" || !PATH_PART_KINDS.includes(part.kind)) {
      return `record.pathParts[].kind must be one of ${PATH_PART_KINDS.join(", ")}`;
    }
    if (typeof part.name !== "string") return "record.pathParts[].name must be a string";
    parts.push({ kind: part.kind as PathPartKind, name: part.name });
  }
  return parts;
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
    case "accepted": {
      const extra = onlyKeys(value, ["t"]);
      return extra === null ? { t: "accepted" } : `accepted: ${extra}`;
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
      const extra = onlyKeys(value, ["t", "record", "contentLength", "segmentCount", "byteLength"]);
      if (extra !== null) return `record frame: ${extra}`;
      const { contentLength, segmentCount, byteLength } = value;
      if (segmentCount !== undefined && (typeof segmentCount !== "number" || !Number.isSafeInteger(segmentCount) || segmentCount < 0)) {
        return "record frame: segmentCount must be a non-negative integer";
      }
      if (contentLength !== undefined && (typeof contentLength !== "number" || !Number.isSafeInteger(contentLength) || contentLength < 1)) {
        return "record frame: contentLength must be a positive integer";
      }
      if (byteLength !== undefined && (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0)) {
        return "record frame: byteLength must be a non-negative integer";
      }
      const record = validateRecord(value.record, limits, contentLength as number | undefined);
      if (typeof record === "string") return record;
      return {
        t: "record",
        record,
        ...(contentLength === undefined ? {} : { contentLength: contentLength as number }),
        ...(segmentCount === undefined ? {} : { segmentCount: segmentCount as number }),
        ...(byteLength === undefined ? {} : { byteLength: byteLength as number }),
      };
    }
    case "segments": {
      const extra = onlyKeys(value, ["t", "segments"]);
      if (extra !== null) return `segments: ${extra}`;
      const segments = validateSegments(value.segments);
      return typeof segments === "string" ? segments : { t: "segments", segments };
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
      const extra = onlyKeys(value, ["t", "kind", "message", "code", "dependency", "capability", "limit", "observed", "max"]);
      if (extra !== null) return `error: ${extra}`;
      if (typeof value.kind !== "string" || !ERROR_KINDS.has(value.kind)) {
        return "error.kind is not a known kind";
      }
      if (typeof value.message !== "string") return "error.message must be a string";
      for (const name of ["code", "dependency", "capability", "limit"] as const) {
        if (value[name] !== undefined && typeof value[name] !== "string") return `error.${name} must be a string`;
      }
      for (const name of ["observed", "max"] as const) {
        const number = value[name];
        if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number) || number < 0)) {
          return `error.${name} must be a finite non-negative number`;
        }
      }
      const kind = value.kind as ChildErrorKind;
      return {
        t: "error",
        kind,
        message: value.message,
        ...(value.code === undefined ? {} : { code: value.code as string }),
        ...(value.dependency === undefined ? {} : { dependency: value.dependency as string }),
        ...(value.capability === undefined ? {} : { capability: value.capability as string }),
        ...(value.limit === undefined ? {} : { limit: value.limit as string }),
        ...(value.observed === undefined ? {} : { observed: value.observed as number }),
        ...(value.max === undefined ? {} : { max: value.max as number }),
      };
    }
    default:
      return "unknown frame type";
  }
}

function protocolFailure(message: string): IsolationError {
  return new IsolationError("crash", `Isolated parser protocol violation: ${message}`);
}
