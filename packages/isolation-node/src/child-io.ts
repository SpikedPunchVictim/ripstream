import { writeSync } from "node:fs";
import type { Writable } from "node:stream";
import { HANDLER_TYPES, type HandlerType, type IsolatedComponents } from "@spikedpunch/ripstream-core";

/**
 * Child-side I/O shared by the real child entry (P3), the probe child and the
 * test children, plus the parent-side encoder for the same wire format.
 *
 * stdin (parent -> child), written only after the child's "ready" frame:
 *
 *   [4 bytes: big-endian uint32 H][H bytes: UTF-8 JSON InputHeader][header.byteLength raw input bytes]
 *
 * then the parent closes stdin. For `{ path }` input `byteLength` is 0 and
 * `path` names a TRUSTED local file the child reads itself. The header is
 * parent-authored, so it is validated for shape but not treated as hostile;
 * the input bytes are hostile and are never interpreted here.
 *
 * fd 3 (child -> parent): one JSON frame per line ("\n" framing, see
 * frames.ts), written synchronously so back-pressure blocks the child.
 *
 * stderr (child -> parent): diagnostics only. The parent keeps the last 8 KiB
 * and, as a backstop against a hostile child, closes the pipe after
 * `stderrBudgetBytes` (default 1 MiB), after which the child's writes fail with
 * EPIPE. A well-behaved child must never get there, and must not die of it if
 * it does: every child entry calls `initChildProcess()` first.
 */

export interface InputHeader {
  readonly v: 1;
  readonly output: "text" | "records";
  /** Number of raw input bytes after the header; 0 when `path` is set. */
  readonly byteLength: number;
  /** Trusted local file to parse instead of inline bytes. */
  readonly path?: string;
  readonly filename?: string;
  readonly maxOutputChars?: number;
  readonly maxEmbeddedResources?: number;
  /** Deepest embedded document the child parses (ParseLimits.maxNodeDepth). Omitted: core's default. */
  readonly maxNodeDepth?: number;
  /**
   * The `parsers` and `detectors` sections the child builds its ripstream from. Parent-authored and the same for
   * every request of an isolator. Omitted: the default parsers and detectors.
   */
  readonly components?: IsolatedComponents;
  /**
   * The child's own parse timer, in ms (0 = none). The parent sets it a little below its kill deadline, so a parse
   * that is merely slow ends with a typed ParseTimeoutError frame instead of a SIGKILL. Omitted: core's default.
   * A parser stuck in a synchronous loop never sees it; the parent's timer is the real bound.
   */
  readonly maxParseMillis?: number;
  /** ParseOptions.onDocumentFailure "record": a document that cannot be read is answered, not thrown. Omitted: false. */
  readonly recordFailures?: boolean;
  /** ParseOptions.onOutputLimit "truncate": the output limit ends the parse with the text so far, flagged. Omitted: false. */
  readonly truncateOutput?: boolean;
  /** ParseOptions.handlerType: the shape the content is written in. Omitted: "text". */
  readonly handlerType?: HandlerType;
  /** ParseOptions.unpackBytes: keep the bytes of the embedded documents, up to this many in all. Records output only. */
  readonly unpackBytes?: number;
}

export interface ChildInput {
  readonly header: InputHeader;
  /** The inline input; empty when `header.path` is set. */
  readonly bytes: Uint8Array;
}

export const MAX_HEADER_BYTES = 64 * 1024;

/** Parent side: the length prefix plus the JSON header. The raw bytes follow it. */
export function encodeInputPrefix(header: InputHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  if (json.length > MAX_HEADER_BYTES) {
    throw new RangeError(`input header is ${json.length} bytes, the maximum is ${MAX_HEADER_BYTES}`);
  }
  const prefix = Buffer.alloc(4 + json.length);
  prefix.writeUInt32BE(json.length, 0);
  json.copy(prefix, 4);
  return prefix;
}

function optionalNonNegativeInteger(header: Record<string, unknown>, name: string): void {
  const value = header[name];
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`input header: ${name} must be a non-negative integer`);
  }
}

function requireStringArray(value: unknown, where: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`input header: ${where} must be an array of strings`);
  }
}

function requireBooleanRecord(value: unknown, where: string): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== "boolean")
  ) {
    throw new TypeError(`input header: ${where} must be an object of booleans`);
  }
}

/** The shape of `ComponentEntry`. The names themselves were checked by the parent, which authored them. */
function checkComponents(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("input header: components must be an object");
  }
  for (const [section, entries] of Object.entries(value)) {
    if (section === "customMimeTypes") {
      if (typeof entries !== "string") throw new TypeError("input header: components.customMimeTypes must be a string");
      continue;
    }
    if (section !== "parsers" && section !== "detectors") {
      throw new TypeError(`input header: components has an unknown section ${JSON.stringify(section)}`);
    }
    if (!Array.isArray(entries)) throw new TypeError(`input header: components.${section} must be an array`);
    for (const entry of entries as unknown[]) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new TypeError(`input header: a components.${section} entry must be an object`);
      }
      const fields = entry as Record<string, unknown>;
      if (typeof fields.name !== "string" || fields.name.length === 0) {
        throw new TypeError(`input header: a components.${section} entry needs a name`);
      }
      if (typeof fields.marker !== "boolean") throw new TypeError(`input header: components.${section} marker must be a boolean`);
      requireStringArray(fields.exclude, `components.${section} exclude`);
      requireStringArray(fields.mimeInclude, `components.${section} mimeInclude`);
      requireStringArray(fields.mimeExclude, `components.${section} mimeExclude`);
      if (fields.settings !== undefined) requireBooleanRecord(fields.settings, `components.${section} settings`);
    }
  }
}

function parseHeader(json: string): InputHeader {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new TypeError(`input header is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("input header must be a JSON object");
  }
  const header = value as Record<string, unknown>;
  if (header.v !== 1) throw new TypeError(`input header: unsupported version ${String(header.v)}`);
  if (header.output !== "text" && header.output !== "records") {
    throw new TypeError('input header: output must be "text" or "records"');
  }
  if (typeof header.byteLength !== "number" || !Number.isSafeInteger(header.byteLength) || header.byteLength < 0) {
    throw new TypeError("input header: byteLength must be a non-negative integer");
  }
  if (header.path !== undefined && (typeof header.path !== "string" || header.path.length === 0)) {
    throw new TypeError("input header: path must be a non-empty string");
  }
  if (header.path !== undefined && header.byteLength !== 0) {
    throw new TypeError("input header: path input carries no inline bytes");
  }
  if (header.filename !== undefined && typeof header.filename !== "string") {
    throw new TypeError("input header: filename must be a string");
  }
  optionalNonNegativeInteger(header, "maxOutputChars");
  optionalNonNegativeInteger(header, "maxEmbeddedResources");
  optionalNonNegativeInteger(header, "maxParseMillis");
  optionalNonNegativeInteger(header, "maxNodeDepth");
  optionalNonNegativeInteger(header, "unpackBytes");
  if (header.unpackBytes !== undefined && header.output !== "records") {
    throw new TypeError('input header: unpackBytes needs output "records"');
  }
  if (header.recordFailures !== undefined && typeof header.recordFailures !== "boolean") {
    throw new TypeError("input header: recordFailures must be a boolean");
  }
  if (header.truncateOutput !== undefined && typeof header.truncateOutput !== "boolean") {
    throw new TypeError("input header: truncateOutput must be a boolean");
  }
  if (header.handlerType !== undefined && !HANDLER_TYPES.includes(header.handlerType as HandlerType)) {
    throw new TypeError(`input header: handlerType must be one of ${HANDLER_TYPES.join(", ")}`);
  }
  if (header.components !== undefined) checkComponents(header.components);
  return header as unknown as InputHeader;
}

/** Pulls exact byte counts out of a chunk stream. */
class ByteSource {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #pending: Uint8Array = new Uint8Array(0);

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async take(count: number, what: string): Promise<Uint8Array> {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      if (this.#pending.length === 0) {
        const next = await this.#iterator.next();
        if (next.done === true) {
          throw new Error(`input truncated: stream ended after ${filled} of ${count} ${what} bytes`);
        }
        this.#pending = next.value;
      }
      const n = Math.min(count - filled, this.#pending.length);
      out.set(this.#pending.subarray(0, n), filled);
      this.#pending = this.#pending.subarray(n);
      filled += n;
    }
    return out;
  }

  /** Whether more bytes follow what was taken (used to reject trailing garbage). */
  async hasMore(): Promise<boolean> {
    if (this.#pending.length > 0) return true;
    for (;;) {
      const next = await this.#iterator.next();
      if (next.done === true) return false;
      if (next.value.length > 0) {
        this.#pending = next.value;
        return true;
      }
    }
  }

  async close(): Promise<void> {
    await this.#iterator.return?.();
  }
}

/**
 * Reads one input message from `stdin` (default process.stdin). Resolves once
 * the stream ends after exactly the announced bytes; rejects on truncation,
 * trailing bytes or a malformed header.
 */
export async function readInput(stdin: AsyncIterable<Uint8Array> = process.stdin): Promise<ChildInput> {
  const source = new ByteSource(stdin);
  try {
    const lengthBytes = await source.take(4, "header length");
    const headerLength = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0, false);
    if (headerLength > MAX_HEADER_BYTES) {
      throw new RangeError(`input header is ${headerLength} bytes, the maximum is ${MAX_HEADER_BYTES}`);
    }
    const header = parseHeader(new TextDecoder("utf-8", { fatal: true }).decode(await source.take(headerLength, "header")));
    const bytes = await source.take(header.byteLength, "input");
    if (await source.hasMore()) throw new Error("input has trailing bytes after the announced length");
    return { header, bytes };
  } finally {
    await source.close();
  }
}

const FRAME_FD = 3;

/** Writes one frame to fd 3, blocking until the parent has read it all. */
export function sendFrame(frame: object): void {
  const buffer = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(FRAME_FD, buffer, offset);
    } catch (error) {
      // A non-blocking pipe is momentarily full: wait a tick and retry.
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

/** What a legitimate child lets through process.stderr: far below the parent's 1 MiB close-the-pipe backstop. */
export const DEFAULT_CHILD_STDERR_BUDGET_BYTES = 256 * 1024;

export interface ChildProcessOptions {
  /**
   * Bytes of JS-level stderr output (process.stderr.write, console.error, ...) the child lets through before it
   * silently drops the rest. Default 256 KiB. Keep it below the parent's `stderrBudgetBytes`, so the parent never
   * has to close the pipe on a legitimate child.
   */
  readonly stderrBudgetBytes?: number;
}

/** What `installStderrGuard` reports; for tests. */
export interface StderrGuard {
  /** Bytes let through so far. */
  writtenBytes(): number;
  /** True once the budget is spent or the pipe is gone: from then on writes are dropped. */
  exhausted(): boolean;
}

const guards = new WeakMap<Writable, StderrGuard>();
const PIPE_GONE: ReadonlySet<string> = new Set(["EPIPE", "ENOTCONN", "ERR_STREAM_DESTROYED"]);

/**
 * Makes `stream` (process.stderr, in a child) safe to write to without limit:
 *  - writes beyond `budgetBytes` are dropped (reported as written, callback called). A write that would cross the
 *    budget is dropped whole, and so is everything after it;
 *  - an 'error' of EPIPE, ENOTCONN or ERR_STREAM_DESTROYED (the parent closed its end) is ignored and ends the
 *    writing. Any other error is rethrown, as it would be with no listener at all.
 * Calling it again on the same stream returns the existing guard (the first call's budget stands).
 * Native writers (V8's fatal "heap out of memory" message, node's uncaught-exception report) write to fd 2
 * directly and are not affected, which is why the budget must stay below the parent's.
 */
export function installStderrGuard(stream: Writable, budgetBytes: number): StderrGuard {
  const existing = guards.get(stream);
  if (existing !== undefined) return existing;
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) {
    throw new RangeError(`stderr budget must be a non-negative safe integer, got ${String(budgetBytes)}`);
  }
  let written = 0;
  let exhausted = false;
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;

  stream.write = ((chunk: unknown, encodingOrCallback?: unknown, maybeCallback?: unknown): boolean => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
    // Bytes, not elements: any ArrayBufferView counts byteLength (Uint16Array, DataView). Anything else is passed
    // through uncounted so the stream reports its own TypeError.
    const size = typeof chunk === "string"
      ? Buffer.byteLength(chunk, encoding as BufferEncoding | undefined)
      : ArrayBuffer.isView(chunk) ? chunk.byteLength : 0;
    if (!exhausted && written + size > budgetBytes) exhausted = true;
    if (exhausted) {
      if (typeof callback === "function") process.nextTick(callback as () => void);
      return true;
    }
    written += size;
    return original(chunk, encodingOrCallback, maybeCallback);
  }) as Writable["write"];

  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== undefined && PIPE_GONE.has(error.code)) {
      exhausted = true;
      return;
    }
    throw error;
  });

  const guard: StderrGuard = { writtenBytes: () => written, exhausted: () => exhausted };
  guards.set(stream, guard);
  return guard;
}

/**
 * The first thing every child entry calls. Today it guards process.stderr (see `installStderrGuard`): a child
 * that logs a lot, or whose parent has closed the stderr pipe, neither floods the parent nor dies of an unhandled
 * EPIPE. Without it, a child that writes more than the parent's stderr budget (1 MiB by default) is killed by its
 * own uncaught EPIPE and reported as a crash, hiding the real outcome (a result, or an out-of-memory).
 */
export function initChildProcess(options: ChildProcessOptions = {}): void {
  installStderrGuard(process.stderr, options.stderrBudgetBytes ?? DEFAULT_CHILD_STDERR_BUDGET_BYTES);
}
