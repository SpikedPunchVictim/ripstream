import {
  AbortError,
  EmptyDocumentError,
  EncryptedDocumentError,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  MissingDependencyError,
  ParseTimeoutError,
  ParserDeclinedError,
  RandomAccessUnavailableError,
  RequestTooLargeError,
  TranslationError,
  UnsupportedFormatError,
  UnsupportedRuntimeError,
  WriteLimitReachedError,
  type ParseRecord,
} from "@spikedpunch/ripstream-core";
import { runChildMain, type ChildRipstream } from "../../src/child-main.ts";

/**
 * Child entry for the process-level tests: the REAL runChildMain (init, ready, input, frames, exit) around a fake
 * pipeline whose behaviour argv[2] selects. Nothing here calls initChildProcess or sendFrame itself: that is the
 * point, a hostile parser gets exactly the protection a real child entry gets.
 */
const mode = process.argv[2] ?? "";
const arg = process.argv[3] ?? "";

const THROWN: Record<string, () => unknown> = {
  UnsupportedFormatError: () => new UnsupportedFormatError("no parser for application/x-fake"),
  EncryptedDocumentError: () => new EncryptedDocumentError("PDF is encrypted"),
  MalformedDocumentError: () => new MalformedDocumentError("bad xref table"),
  ParseTimeoutError: () => new ParseTimeoutError(),
  RequestTooLargeError: () => new RequestTooLargeError(),
  LimitExceededError: () => new LimitExceededError("Output exceeds 5 characters"),
  MissingDependencyError: () => new MissingDependencyError("pdfjs-dist", "PDF parsing"),
  RandomAccessUnavailableError: () => new RandomAccessUnavailableError("needs random access"),
  ParserDeclinedError: () => new ParserDeclinedError("not an iWork package"),
  EmptyDocumentError: () => new EmptyDocumentError(),
  AbortError: () => new AbortError(),
  UnsupportedRuntimeError: () => new UnsupportedRuntimeError("no digest provider"),
  TranslationError: () => new TranslationError("upstream down"),
  WriteLimitReachedError: () => new WriteLimitReachedError(5),
  IsolationError: () => new IsolationError("unavailable", "spoofed"),
  Error: () => new Error("plain failure with /secret/path"),
  TypeError: () => new TypeError("x is not a function"),
  string: () => "a thrown string",
  "invalid-string-length": () => new RangeError("Invalid string length"),
};

const metadata = (): Metadata => {
  const value = new Metadata();
  value.set("Content-Type", "text/plain");
  value.set("fixture", mode);
  return value;
};

const record = (depth: number, content: string): ParseRecord => ({
  metadata: metadata(),
  content,
  embeddedResourcePath: depth === 0 ? "/doc" : `/doc/part-${depth}`,
  depth,
  mediaType: MediaType.TEXT_PLAIN,
  exception: depth === 2 ? new MalformedDocumentError("embedded part is damaged") : null,
});

async function behave(source: unknown, options: unknown): Promise<string> {
  switch (mode) {
    case "ok":
      return "ok-text";
    case "options":
      return JSON.stringify({ options, source: source instanceof Uint8Array ? { bytes: source.length } : source });
    case "throw": {
      const make = THROWN[arg];
      if (make === undefined) throw new Error(`unknown thrown kind ${arg}`);
      throw make();
    }
    case "hang-async":
      // A promise nothing will ever settle and no handle keeps alive (a deadlocked parser): with core's parse timer
      // unref'd, nothing holds the event loop open either.
      return new Promise<string>(() => {});
    case "hang-sync":
      for (;;) {
        // never yields: only the parent's kill timer ends this
      }
    case "oom": {
      const hoard: number[][] = [];
      for (;;) hoard.push(new Array<number>(100_000).fill(Math.random()));
    }
    case "stderr-5mb": {
      const line = `${"e".repeat(1023)}\n`;
      for (let i = 0; i < 5 * 1024; i++) process.stderr.write(line);
      // let any EPIPE from a closed pipe surface before answering
      await new Promise((resolve) => setTimeout(resolve, 300));
      return "survived-stderr";
    }
    case "detached-reject":
      // What pdf.js inline can do: a promise nobody awaits rejects, while the parse waits on something else.
      void Promise.reject(new Error("pdf.js internal rejection"));
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return "unreachable";
    case "detached-throw":
      // The same from a timer callback: an uncaught exception on the main thread.
      setTimeout(() => {
        throw new TypeError("pdf.js internal timer failure");
      }, 10);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return "unreachable";
    case "huge-text":
      return "x".repeat(Number(arg === "" ? 20_000_000 : arg));
    case "slow":
      await new Promise((resolve) => setTimeout(resolve, Number(arg === "" ? 300 : arg)));
      return "slow-ok";
    default:
      throw new Error(`unknown fixture mode ${mode}`);
  }
}

const ripstream: ChildRipstream = {
  parse: async (source, options) => ({ metadata: metadata(), text: await behave(source, options) }),
  parseRecursive: async (source, options) => {
    const text = await behave(source, options);
    return [record(0, text), record(1, "inner one"), record(2, "")];
  },
};

await runChildMain({ ripstream });
