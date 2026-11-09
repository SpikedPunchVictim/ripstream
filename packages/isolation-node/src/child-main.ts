import {
  DEFAULT_LIMITS,
  ParseTimeoutError,
  type IsolatedParseRecord,
  type Metadata,
  type ParseLimits,
  type ParseOptions,
  type ParseRecord,
  type Ripstream,
} from "@spikedpunch/ripstream-core";
import {
  initChildProcess,
  readInput,
  sendFrame,
  type ChildInput,
  type ChildProcessOptions,
  type InputHeader,
} from "./child-io.ts";
import { encodeChildError, encodeCrashError, oneLineText } from "./error-codec.ts";

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
  sendFrame(frame: object): void;
  /** Calls `handler` for every uncaught exception and unhandled rejection from now on (for the life of the process). */
  onFatal(handler: (reason: unknown, origin: FatalOrigin) => void): void;
  exit(code: number): void;
}

const PROCESS_IO: ChildMainIo = {
  initChildProcess,
  readInput,
  sendFrame,
  onFatal: (handler) => {
    process.on("uncaughtException", (error) => handler(error, "uncaughtException"));
    process.on("unhandledRejection", (reason) => handler(reason, "unhandledRejection"));
  },
  exit: (code) => process.exit(code),
};

export interface ChildMainOptions {
  readonly ripstream: ChildRipstream;
  /** Passed to initChildProcess: JS-level stderr bytes let through before the rest is dropped. */
  readonly stderrBudgetBytes?: number;
  /**
   * @internal Test seam: replaces the real stdin / fd 3 / stderr guard / process fault handlers / process.exit.
   * Whatever is left out is the real thing, so a test that does not name `onFatal` and `exit` would install
   * handlers on, and could exit, the test process: always give both.
   */
  readonly io?: Partial<ChildMainIo>;
}

/** Text frames carry at most this many UTF-16 code units: ~384 KiB of JSON in the worst (all-escaped) case, far below the 1 MiB frame cap. */
export const MAX_TEXT_CHUNK_CHARS = 64 * 1024;

/** Longest exception name / message / code kept on a record (the parent still treats them as untrusted). */
const MAX_EXCEPTION_FIELD_CHARS = 500;

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
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

function toWireRecord(record: ParseRecord): IsolatedParseRecord {
  return {
    metadata: metadataToRecord(record.metadata),
    content: record.content,
    embeddedResourcePath: record.embeddedResourcePath,
    depth: record.depth,
    mediaType: record.mediaType.toString(),
    exception: record.exception === null ? null : wireException(record.exception),
  };
}

/**
 * Only what the header says goes into the limits; everything else stays core's default, exactly as in an
 * in-process parse. There is no AbortSignal: nothing in the child can abort a parse except the parse timer
 * (the parent kills the whole process group instead).
 */
function parseOptionsFor(header: InputHeader): ParseOptions {
  const limits: Partial<ParseLimits> = {
    ...(header.maxOutputChars === undefined ? {} : { maxOutputChars: header.maxOutputChars }),
    ...(header.maxEmbeddedResources === undefined ? {} : { maxEmbeddedResources: header.maxEmbeddedResources }),
    ...(header.maxParseMillis === undefined ? {} : { maxParseMillis: header.maxParseMillis }),
  };
  return { ...(header.filename === undefined ? {} : { filename: header.filename }), limits };
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

/** Runs one parse and answers over fd 3. Never rejects. */
export async function runChildMain(options: ChildMainOptions): Promise<void> {
  const io: ChildMainIo = { ...PROCESS_IO, ...options.io };
  // True from the moment a terminal frame is ATTEMPTED: if its write fails halfway, another frame would corrupt the
  // line, and the parent is gone anyway. Nothing is sent after it, whoever tries (a fault handler may have sent the
  // terminal frame while the main flow is still running).
  let terminalAttempted = false;
  let terminalDelivered = false;
  const requireOpen = (): void => {
    if (terminalAttempted) throw new Error("a frame was about to be sent after the terminal frame");
  };
  const send = (frame: object): void => {
    requireOpen();
    io.sendFrame(frame);
  };
  const sendTerminal = (frame: object): void => {
    requireOpen();
    terminalAttempted = true;
    io.sendFrame(frame);
    terminalDelivered = true;
  };

  try {
    io.initChildProcess(options.stderrBudgetBytes === undefined ? {} : { stderrBudgetBytes: options.stderrBudgetBytes });
    io.onFatal((reason, origin) => {
      const verdictSent = terminalDelivered;
      if (!terminalAttempted) {
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
    const input = await io.readInput();
    const source = sourceFor(input);
    const parseOptions = parseOptionsFor(input.header);

    const watchdog = armParseWatchdog(input.header.maxParseMillis);
    try {
      if (input.header.output === "records") {
        const records = await Promise.race([options.ripstream.parseRecursive(source, parseOptions), watchdog.expired]);
        for (const record of records) send({ t: "record", record: toWireRecord(record) });
      } else {
        const result = await Promise.race([options.ripstream.parse(source, parseOptions), watchdog.expired]);
        send({ t: "meta", metadata: metadataToRecord(result.metadata) });
        for (const chunk of textChunks(result.text)) send({ t: "text", chunk });
      }
    } catch (error) {
      if (watchdog.fired() && !terminalAttempted) {
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
  } catch (error) {
    if (!terminalAttempted) {
      try {
        sendTerminal(encodeChildError(error));
      } catch {
        // The parent closed fd 3 (it gave up, or it is gone): there is no one to tell.
      }
    }
  }
  if (!terminalDelivered) {
    // Nothing reached the parent, so this line (bounded by the stderr guard) is the only trace.
    process.stderr.write("ripstream child: the terminal frame could not be written to fd 3\n");
  }
  process.exitCode = terminalDelivered ? 0 : 1;
}
