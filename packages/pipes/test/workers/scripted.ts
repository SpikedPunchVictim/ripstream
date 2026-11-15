import { readFileSync, writeFileSync } from "node:fs";
import { threadId } from "node:worker_threads";
import {
  AbortError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  RipstreamConfigError,
  RipstreamInputStream,
  type ParseOptions,
  type ParseRecord,
} from "@spikedpunch/ripstream-core";
import { serveParses } from "../../src/parse-worker-main.ts";

/*
 * A parse worker for the pool's tests: what it does with a document is named by the filename (`mode:argument`).
 *
 * SCRIPTED_CONTROL names a file read at start: "throw:N" fails the thread's start N more times (counting down in the
 * file), "init" makes building the ripstream fail with a RipstreamConfigError.
 */

const control = process.env["SCRIPTED_CONTROL"];
const order = control === undefined ? "" : readFileSync(control, "utf8").trim();
if (order.startsWith("throw:")) {
  const left = Number(order.slice("throw:".length));
  if (left > 0) {
    writeFileSync(control!, `throw:${left - 1}`);
    throw new Error(`scripted start failure (${left} left)`);
  }
}

const spin = (): never => {
  for (;;) {
    // A parse stuck in synchronous code: only terminate() stops it.
  }
};

function waitFor(millis: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = millis === Infinity ? undefined : setTimeout(resolve, millis);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new AbortError("scripted parse aborted"));
    });
  });
}

async function parse(input: Uint8Array | { readonly path: string }, options: ParseOptions) {
  const [mode = "", argument = ""] = (options.filename ?? "").split(":");
  const begun = Date.now();
  switch (mode) {
    case "wait":
      await waitFor(Number(argument), options.signal);
      break;
    case "hang":
      await waitFor(Infinity, options.signal);
      break;
    case "deaf":
      // Ignores its signal.
      await new Promise((resolve) => setTimeout(resolve, Number(argument)));
      break;
    case "spin":
      spin();
      break;
    case "spill": {
      const stream = await RipstreamInputStream.from(input as Uint8Array);
      await stream.getFile();
      spin();
      break;
    }
    case "hold": {
      // Opens the input (a {path}) and reads its first chunk, then waits with the file open, honouring its signal.
      const stream = await RipstreamInputStream.from(input, { signal: options.signal });
      await stream.read();
      await waitFor(Infinity, options.signal);
      break;
    }
    case "holdspin": {
      // The same, but stuck in synchronous code, so that only terminate() stops it.
      const stream = await RipstreamInputStream.from(input);
      await stream.read();
      spin();
      break;
    }
    case "malformed":
      throw new MalformedDocumentError(`scripted: ${argument}`);
    case "exit":
      process.exit(Number(argument));
      break;
    case "uncaught":
      setImmediate(() => {
        throw new Error("scripted uncaught error");
      });
      await waitFor(Infinity, undefined);
      break;
    case "stray":
      // Answers, then fails later with nothing to catch it.
      setTimeout(() => void Promise.reject(new Error("scripted stray rejection")), Number(argument));
      break;
    default:
      break;
  }
  const metadata = new Metadata();
  metadata.set("thread", String(threadId));
  metadata.set("begun", String(begun));
  metadata.set("ended", String(Date.now()));
  metadata.set("tmpdir", process.env["TMPDIR"] ?? "");
  metadata.set("bytes", input instanceof Uint8Array ? String(input.byteLength) : "path");
  return { metadata, text: mode === "echo" ? argument : "" };
}

async function parseRecursive(input: Uint8Array | { readonly path: string }, options: ParseOptions): Promise<readonly ParseRecord[]> {
  const result = await parse(input, options);
  const shared = new Uint8Array([1, 2, 3, 4, 5, 6]);
  // A field structured clone cannot copy, as a record field added later might be.
  const extra = options.filename === "uncloneable" ? { extra: () => undefined } : {};
  return [
    { metadata: result.metadata, content: result.text, embeddedResourcePath: "/", depth: 0, mediaType: MediaType.TEXT_PLAIN, exception: null, ...extra },
    {
      metadata: new Metadata(),
      content: "inner",
      embeddedResourcePath: "/a.bin",
      pathParts: [{ name: "a.bin" }] as never,
      depth: 1,
      mediaType: new MediaType("text", "plain", { charset: "x;y=\"z\"" }),
      exception: new MalformedDocumentError("scripted embedded failure"),
      bytes: shared.subarray(1, 3),
    },
  ];
}

await serveParses(() => {
  if (order === "init") throw new RipstreamConfigError(["scripted configuration failure"]);
  return { parse: parse as never, parseRecursive };
});
