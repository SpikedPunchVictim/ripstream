import {
  DEFAULT_LIMITS,
  ParseTimeoutError,
  type IsolatedComponents,
  type IsolatedParseRecord,
  type Metadata,
  type ParseLimits,
  type ParseOptions,
  type ParseRecord,
  type Ripstream,
} from "@spikedpunch/ripstream-core";
import {
  initChildProcess,
  InputReader,
  readInput,
  sendFrame,
  SERVE_ENV,
  type ChildInput,
  type ChildProcessOptions,
  type InputHeader,
} from "./child-io.ts";
import { encodeChildError, encodeCrashError, oneLineText } from "./error-codec.ts";
import { MAX_BYTES_CHUNK, MAX_SEGMENTS_PER_FRAME, MAX_TEXT_CHUNK_CHARS } from "./frames.ts";

/**
 * The child side of the wire protocol: runs ONE whole parse in this process and answers over fd 3. The entry file
 * of a real child is a single line, `await runChildMain({ ripstream })`, with the pipeline injected so that this
 * package stays core-only (packages/bundle-standard/src/isolation-child.ts is the standard one).
 *
 * Order, which is part of the contract:
 *  1. initChildProcess() (stderr guard) - structural: a child entry cannot forget it, because it is HERE;
 *  2. the process-level fault handlers (uncaught exception, unhandled rejection), see below;
 *  3. the "ready" frame, so the parent starts writing the input;
 *  4. the input (header, then inline bytes or a `{ path }`);
 *  5. the parse, then the result frames (text: meta, text*, done; records: record*, done);
 *  6. exactly one terminal frame: "done", or one "error" frame for whatever was thrown, at any step after (1).
 *
 * Afterwards the process exits by itself with `process.exitCode = 0` once the event loop is empty. fd 3 is written
 * with synchronous writeSync loops (child-io.ts), so every frame is already in the pipe when sendFrame returns. If
 * a parser leaks a handle that keeps the loop alive, the parent's grace timer kills the group after the terminal
 * frame; the verdict is unaffected.
 *
 * Faults outside the request's own promise chain are the one case that calls process.exit(): a parser that runs
 * on this thread (the PDF parser, inline) can throw from a timer or reject a promise nobody awaits, and Node then
 * considers the process state undefined. If no terminal frame has been sent yet, the handler sends one "crash"
 * error frame (never a typed class: a fault the request did not catch is not its answer) and exits with code 1.
 * If one was sent already, the verdict stands and it only exits (0 when that frame was delivered). Nothing is lost
 * by exiting at once: the frame is already in the pipe, and stderr is best-effort diagnostics.
 *
 * A REUSED child (the parent set SERVE_ENV through the wrapper, see warm.ts) sends "ready" once, then answers request
 * after request on the same stdin: steps 4 to 6 repeat, each with its own terminal frame (and an "accepted" frame once
 * the request has been read whole, before any parsing: a process that dies before it is one the parent may run the
 * request on again), until the parent closes
 * stdin (exit code 0) or kills the group. Nothing of one request's header, options or frames is kept for the next;
 * the ripstream is built once per distinct `components` and reused. A fault outside a request's promise chain still
 * ends the process, as above. The parent retires the child after any error frame, so the loop never has to decide
 * whether it is still fit to serve.
 */

/** What the child needs of a Ripstream. A structural subset, so tests can inject a fake pipeline. */
export type ChildRipstream = Pick<Ripstream, "parse" | "parseRecursive">;

export type FatalOrigin = "uncaughtException" | "unhandledRejection";

const FATAL_LABEL: Readonly<Record<FatalOrigin, string>> = {
  uncaughtException: "uncaught exception",
  unhandledRejection: "unhandled rejection",
};

/** The process-level effects, replaceable in tests. */
export interface ChildMainIo {
  initChildProcess(options?: ChildProcessOptions): void;
  readInput(): Promise<ChildInput>;
  /** Whether this process serves several requests (SERVE_ENV is "1"). */
  serving(): boolean;
  /** A serving child's next request, or null once the parent closed stdin between two requests. */
  nextInput(): Promise<ChildInput | null>;
  sendFrame(frame: object): void;
  /** Calls `handler` for every uncaught exception and unhandled rejection from now on (for the life of the process). */
  onFatal(handler: (reason: unknown, origin: FatalOrigin) => void): void;
  exit(code: number): void;
}

let processReader: InputReader | undefined;

const PROCESS_IO: ChildMainIo = {
  initChildProcess,
  readInput,
  serving: () => process.env[SERVE_ENV] === "1",
  nextInput: () => (processReader ??= new InputReader(process.stdin)).next(),
  sendFrame,
  onFatal: (handler) => {
    process.on("uncaughtException", (error) => handler(error, "uncaughtException"));
    process.on("unhandledRejection", (reason) => handler(reason, "unhandledRejection"));
  },
  exit: (code) => process.exit(code),
};

export interface ChildMainOptions {
  /**
   * The ripstream that parses, or a function that builds it from the header's `components` (undefined when the
   * parent sent none). A one-shot child parses one document, so the function runs once; a serving child calls it
   * again only when `components` change. It runs after the input is read, inside the parse: a configuration it
   * cannot build is an error frame, not a crash before the parent is told.
   */
  readonly ripstream: ChildRipstream | ((components: IsolatedComponents | undefined) => ChildRipstream);
  /** Passed to initChildProcess: JS-level stderr bytes let through before the rest is dropped. */
  readonly stderrBudgetBytes?: number;
  /**
   * @internal Test seam: replaces the real stdin / fd 3 / stderr guard / process fault handlers / process.exit.
   * Whatever is left out is the real thing, so a test that does not name `onFatal` and `exit` would install
   * handlers on, and could exit, the test process: always give both.
   */
  readonly io?: Partial<ChildMainIo>;
}

export { MAX_TEXT_CHUNK_CHARS };

/** Longest exception name / message / code kept on a record (the parent still treats them as untrusted). */
const MAX_EXCEPTION_FIELD_CHARS = 500;

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * `segments` in lists of at most MAX_SEGMENTS_PER_FRAME, cut earlier once the labels and locations in a list come to
 * `maxChars` characters: a frame stays small however long the strings are, as a text frame does (tikajs-9ztw).
 * A single segment longer than that is a list of its own.
 */
export function* segmentChunks(
  segments: readonly { start: number; end: number; labels: readonly string[]; location: string }[],
  maxChars: number = MAX_TEXT_CHUNK_CHARS,
): Generator<{ start: number; end: number; labels: string[]; location: string }[]> {
  let list: { start: number; end: number; labels: string[]; location: string }[] = [];
  let chars = 0;
  for (const { start, end, labels, location } of segments) {
    let size = location.length;
    for (const label of labels) size += label.length;
    if (list.length > 0 && (list.length >= MAX_SEGMENTS_PER_FRAME || chars + size > maxChars)) {
      yield list;
      list = [];
      chars = 0;
    }
    list.push({ start, end, labels: [...labels], location });
    chars += size;
  }
  if (list.length > 0) yield list;
}

/** `text` in pieces of at most `maxChars` UTF-16 code units, never cutting a surrogate pair in two. */
export function* textChunks(text: string, maxChars: number = MAX_TEXT_CHUNK_CHARS): Generator<string> {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2) {
    throw new RangeError(`maxChars must be an integer >= 2 (a surrogate pair is two units), got ${String(maxChars)}`);
  }
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
    yield text.slice(start, end);
    start = end;
  }
}

/** `bytes` as base64 in pieces of at most MAX_BYTES_CHUNK raw bytes; nothing for no bytes. */
export function* byteChunks(bytes: Uint8Array, size: number = MAX_BYTES_CHUNK): Generator<string> {
  for (let start = 0; start < bytes.length; start += size) {
    yield Buffer.from(bytes.buffer, bytes.byteOffset + start, Math.min(size, bytes.length - start)).toString("base64");
  }
}

/** Own data properties only: a key such as "__proto__" stays an ordinary key (the parent drops it on receipt). */
function metadataToRecord(metadata: Metadata): Record<string, string[]> {
  return Object.fromEntries(metadata.names().map((name) => [name, [...metadata.getAll(name)]]));
}

function wireException(error: unknown): NonNullable<IsolatedParseRecord["exception"]> {
  const fields = error as { name?: unknown; message?: unknown; code?: unknown };
  const text = (value: unknown): string => oneLineText(typeof value === "string" ? value : String(value), MAX_EXCEPTION_FIELD_CHARS);
  const name = text(fields.name);
  const message = text(fields.message);
  return typeof fields.code === "string" ? { name, message, code: text(fields.code) } : { name, message };
}

/** `withoutContent`: the content travels in text frames after the record. */
function toWireRecord(record: ParseRecord, withoutContent = false): IsolatedParseRecord {
  return {
    metadata: metadataToRecord(record.metadata),
    content: withoutContent ? "" : record.content,
    embeddedResourcePath: record.embeddedResourcePath,
    ...(record.pathParts === undefined ? {} : { pathParts: record.pathParts }),
    depth: record.depth,
    mediaType: record.mediaType.toString(),
    exception: record.exception === null ? null : wireException(record.exception),
    ...(record.warnings === undefined || record.warnings.length === 0 ? {} : { warnings: record.warnings }),
  };
}

/**
 * Only what the header says goes into the limits; everything else stays core's default, exactly as in an
 * in-process parse. There is no AbortSignal: nothing in the child can abort a parse except the parse timer
 * (the parent kills the whole process group instead).
 */
function parseOptionsFor(header: InputHeader): ParseOptions {
  const limits: Partial<ParseLimits> = {
    ...header.limits,
    ...(header.maxOutputChars === undefined ? {} : { maxOutputChars: header.maxOutputChars }),
    ...(header.maxEmbeddedResources === undefined ? {} : { maxEmbeddedResources: header.maxEmbeddedResources }),
    ...(header.maxNodeDepth === undefined ? {} : { maxNodeDepth: header.maxNodeDepth }),
    ...(header.maxParseMillis === undefined ? {} : { maxParseMillis: header.maxParseMillis }),
  };
  return {
    ...(header.filename === undefined ? {} : { filename: header.filename }),
    limits,
    ...(header.recordFailures === true ? { onDocumentFailure: "record" as const } : {}),
    ...(header.truncateOutput === true ? { onOutputLimit: "truncate" as const } : {}),
    ...(header.truncateEmbedded === true ? { onEmbeddedLimit: "truncate" as const } : {}),
    ...(header.emailHeaders === undefined ? {} : { emailHeaders: header.emailHeaders }),
    ...(header.handlerType === undefined ? {} : { handlerType: header.handlerType }),
    ...(header.unpackBytes === undefined ? {} : { unpackBytes: header.unpackBytes }),
    ...(header.segments === true ? { segments: true } : {}),
  };
}

/**
 * A `{ path }` is read by core itself (createReadStream, bounded memory), never by this entry. The path is
 * parent-authored and trusted; see IsolatedParseRequest.
 */
function sourceFor(input: ChildInput): Uint8Array | { readonly path: string } {
  return input.header.path === undefined ? input.bytes : { path: input.header.path };
}

/** How long after core's own parse timer the watchdog answers for a parse that ignored it. */
const WATCHDOG_GRACE_MS = 250;
/** The longest delay setTimeout accepts. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Core's parse timer is unref'd, so a parse that is stuck on a promise nothing will settle (no handle, no signal
 * check) leaves the event loop empty and node exits with code 13 ("unsettled top-level await"): the parent would
 * report a crash for what is a timeout. This timer is deliberately ref'd, holds the loop open while the parse is
 * pending and rejects with the same ParseTimeoutError once core's own timer plus a grace has passed. A parse that
 * honours core's timer never meets it. With the timer disabled (0) it only keeps the loop alive: the parent's
 * deadline ends the run.
 */
function armParseWatchdog(maxParseMillis: number | undefined): {
  readonly expired: Promise<never>;
  fired(): boolean;
  disarm(): void;
} {
  const millis = maxParseMillis ?? DEFAULT_LIMITS.maxParseMillis;
  let timer: NodeJS.Timeout | undefined;
  let fired = false;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        fired = true;
        reject(new ParseTimeoutError());
      },
      millis > 0 ? Math.min(millis + WATCHDOG_GRACE_MS, MAX_TIMER_MS) : MAX_TIMER_MS,
    );
  });
  return { expired, fired: () => fired, disarm: () => clearTimeout(timer) };
}

/** One request's frame state: what the terminal-frame rule is checked against. */
interface RequestState {
  // True from the moment a terminal frame is ATTEMPTED: if its write fails halfway, another frame would corrupt the
  // line, and the parent is gone anyway. Nothing is sent after it, whoever tries (a fault handler may have sent the
  // terminal frame while the main flow is still running).
  terminalAttempted: boolean;
  terminalDelivered: boolean;
}

/** Runs one parse (or, serving, one parse per request) and answers over fd 3. Never rejects. */
export async function runChildMain(options: ChildMainOptions): Promise<void> {
  const io: ChildMainIo = { ...PROCESS_IO, ...options.io };
  let request: RequestState = { terminalAttempted: false, terminalDelivered: false };
  const requireOpen = (): void => {
    if (request.terminalAttempted) throw new Error("a frame was about to be sent after the terminal frame");
  };
  const send = (frame: object): void => {
    requireOpen();
    io.sendFrame(frame);
  };
  const sendTerminal = (frame: object): void => {
    requireOpen();
    request.terminalAttempted = true;
    io.sendFrame(frame);
    request.terminalDelivered = true;
  };
  /** The error frame for `error`, unless a terminal frame was already attempted. False when fd 3 is gone. */
  const answerError = (error: unknown): boolean => {
    if (request.terminalAttempted) return request.terminalDelivered;
    try {
      sendTerminal(encodeChildError(error));
      return true;
    } catch {
      // The parent closed fd 3 (it gave up, or it is gone): there is no one to tell.
      return false;
    }
  };
  let built: { readonly key: string; readonly ripstream: ChildRipstream } | undefined;
  const ripstreamFor = (components: IsolatedComponents | undefined): ChildRipstream => {
    if (typeof options.ripstream !== "function") return options.ripstream;
    const key = JSON.stringify(components ?? null);
    if (built?.key !== key) built = { key, ripstream: options.ripstream(components) };
    return built.ripstream;
  };

  /** Parses `input` and sends its frames, ending with "done". Throws whatever the parse threw. */
  const answer = async (input: ChildInput): Promise<void> => {
    const source = sourceFor(input);
    const parseOptions = parseOptionsFor(input.header);

    const watchdog = armParseWatchdog(input.header.maxParseMillis);
    try {
      const ripstream = ripstreamFor(input.header.components);
      if (input.header.output === "records") {
        const records = await Promise.race([ripstream.parseRecursive(source, parseOptions), watchdog.expired]);
        for (const record of records) {
          const { bytes } = record;
          // Long content goes in text frames, as in text mode: the parent then folds it a chunk at a time instead of
          // parsing it as one frame as large as the result (tikajs-2cvh).
          const chunked = record.content.length > MAX_TEXT_CHUNK_CHARS;
          send({
            t: "record",
            record: toWireRecord(record, chunked),
            ...(chunked ? { contentLength: record.content.length } : {}),
            ...(record.segments === undefined ? {} : { segmentCount: record.segments.length }),
            ...(bytes === undefined ? {} : { byteLength: bytes.length }),
          });
          if (chunked) for (const chunk of textChunks(record.content)) send({ t: "text", chunk });
          if (record.segments !== undefined) for (const list of segmentChunks(record.segments)) send({ t: "segments", segments: list });
          if (bytes !== undefined) for (const chunk of byteChunks(bytes)) send({ t: "bytes", chunk });
        }
      } else {
        const result = await Promise.race([ripstream.parse(source, parseOptions), watchdog.expired]);
        send({
          t: "meta",
          metadata: metadataToRecord(result.metadata),
          ...(result.exception === undefined ? {} : { exception: wireException(result.exception) }),
          ...(result.warnings === undefined || result.warnings.length === 0 ? {} : { warnings: result.warnings }),
        });
        for (const chunk of textChunks(result.text)) send({ t: "text", chunk });
      }
    } catch (error) {
      if (watchdog.fired() && !request.terminalAttempted) {
        // The parse ignored core's timer and is still pending; it may hold handles (an open file, a socket) that
        // would keep this process alive. Answer, then leave instead of waiting for the parent's grace kill.
        try {
          sendTerminal(encodeChildError(error));
        } finally {
          io.exit(0); // also when the write failed: the parent closed fd 3, and waiting here only delays its kill
        }
      }
      throw error;
    } finally {
      watchdog.disarm();
    }
    sendTerminal({ t: "done" });
  };

  let endedCleanly = false;
  try {
    io.initChildProcess(options.stderrBudgetBytes === undefined ? {} : { stderrBudgetBytes: options.stderrBudgetBytes });
    io.onFatal((reason, origin) => {
      const verdictSent = request.terminalDelivered;
      if (!request.terminalAttempted) {
        try {
          const crash = encodeCrashError(reason);
          sendTerminal({ ...crash, message: oneLineText(`${FATAL_LABEL[origin]}: ${crash.message}`) });
        } catch {
          // fd 3 is gone: there is no one to tell.
        }
      }
      io.exit(verdictSent ? 0 : 1);
    });
    send({ t: "ready", pid: process.pid });
    if (!io.serving()) {
      await answer(await io.readInput());
    } else {
      for (;;) {
        // A fresh state BEFORE reading: the parent writes a request only when it waits for an answer, so a message
        // that cannot be read is answered with an error frame, like any failure of the request it carried.
        request = { terminalAttempted: false, terminalDelivered: false };
        const input = await io.nextInput();
        if (input === null) {
          endedCleanly = true;
          break;
        }
        try {
          // The whole request is here and nothing was parsed: the parent may still run it elsewhere if this process
          // dies before this frame (warm.ts, tikajs-krih). From here on a death counts as the document's.
          send({ t: "accepted" });
          await answer(input);
        } catch (error) {
          if (!answerError(error)) break;
        }
        if (!request.terminalDelivered) break;
      }
    }
  } catch (error) {
    answerError(error);
  }
  if (endedCleanly) {
    process.exitCode = 0;
    return;
  }
  if (!request.terminalDelivered) {
    // Nothing reached the parent, so this line (bounded by the stderr guard) is the only trace.
    process.stderr.write("ripstream child: the terminal frame could not be written to fd 3\n");
  }
  process.exitCode = request.terminalDelivered ? 0 : 1;
}
