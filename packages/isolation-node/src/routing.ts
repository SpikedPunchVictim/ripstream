import { open } from "node:fs/promises";
import type { Ripstream } from "@spikedpunch/ripstream-core";

/**
 * Decides, in the PARENT, whether a request may be parsed in-process or must go to a child. Anything the allowlist
 * does not name is isolated, and so is anything this module cannot establish: the default answer is "isolate".
 *
 * Detection runs in the parent, so it is cheap and bounded: it sees at most the first 64 KiB (read with one
 * bounded read for a `{ path }`), the filename, and a short timeout. It never touches the rest of the input.
 *
 * Polyglot risk. The verdict is about the PREFIX. For an allowlisted route the caller then parses the WHOLE input
 * with an in-process Ripstream that detects again, on the full stream. A file that looks like plain text for 64 KiB
 * and carries something else behind it is therefore parsed by whatever that Ripstream chooses for the full file.
 * The composition root must hand the isolator an in-process Ripstream restricted to the parsers behind the
 * allowlist (text, csv, html, markdown, xml), so that nothing from the hazard list (exifr, sql.js, pdfjs,
 * music-metadata, hyparquet) can be reached from the parent whatever the bytes are. Size is the other bound: an
 * input above `inProcessMaxBytes` is isolated whatever it is, because the html and xml parsers hold their events in
 * memory.
 */

/** The only bytes detection is given. */
export const DETECT_PREFIX_BYTES = 64 * 1024;

/** Detection of 64 KiB takes milliseconds; a detector that needs a second has a problem and is not trusted. */
export const DEFAULT_DETECT_TIMEOUT_MS = 1000;

/** Larger inputs are isolated even when their type is on the allowlist (html and xml hold events in memory). */
export const DEFAULT_IN_PROCESS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Media types that may be parsed in the parent. Each is handled only by a pure-JavaScript text parser that reaches
 * none of the hazard list (TextParser, CsvParser, HtmlDocumentParser, MarkdownParser, XmlParser in
 * packages/parsers): no container, no binary format, no embedded-document recursion. Exact base types only: there
 * are no wildcards, so `text/x-anything-else` is isolated. SVG and the vendor XML dialects are left out on purpose.
 */
export const DEFAULT_IN_PROCESS_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  "application/xhtml+xml",
  "text/markdown",
  "application/json",
  "application/ld+json",
  "application/manifest+json",
  "text/x-yaml",
  "text/xml",
  "application/xml",
]);

export type Route = "in-process" | "isolate";

export interface RouteOptions {
  /** Only `detect` is used. */
  readonly ripstream: Pick<Ripstream, "detect">;
  readonly input: Uint8Array | { readonly path: string };
  /** The input's size in bytes, measured by the caller (the byte length, or the file's stat size). */
  readonly size: number;
  readonly filename?: string;
  readonly inProcessTypes: ReadonlySet<string>;
  /** Default DEFAULT_IN_PROCESS_MAX_BYTES. */
  readonly inProcessMaxBytes?: number;
  /** Default DEFAULT_DETECT_TIMEOUT_MS. */
  readonly detectTimeoutMs?: number;
  /** An abort ends the wait at once with "no verdict" (isolate); the caller then raises the abort itself. */
  readonly signal?: AbortSignal;
}

async function readPrefix(input: RouteOptions["input"]): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input.subarray(0, DETECT_PREFIX_BYTES);
  const handle = await open(input.path, "r");
  try {
    const buffer = Buffer.alloc(DETECT_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The base media type of the prefix, `type/subtype` without parameters. Throws on anything that is not a MediaType
 * (the answer is checked by shape, so a second copy of core cannot make every text file look unknown).
 */
async function detectBaseType(options: RouteOptions, signal: AbortSignal): Promise<string> {
  const prefix = await readPrefix(options.input);
  const detected = await options.ripstream.detect(prefix, {
    ...(options.filename === undefined ? {} : { filename: options.filename }),
    signal,
  });
  const base = detected.getBaseType();
  return `${base.type}/${base.subtype}`;
}

export async function routeRequest(options: RouteOptions): Promise<Route> {
  if (options.size > (options.inProcessMaxBytes ?? DEFAULT_IN_PROCESS_MAX_BYTES)) return "isolate";

  const { signal } = options;
  if (signal?.aborted === true) return "isolate";
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, options.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS);
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    if (signal === undefined) return;
    onAbort = () => {
      controller.abort();
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Any failure (a throw, a bad answer, a missing file) is "no verdict", and no verdict means isolate.
    const detection = Promise.resolve()
      .then(() => detectBaseType(options, controller.signal))
      .catch(() => null);
    const type = await Promise.race([detection, timeout, aborted]);
    return type !== null && options.inProcessTypes.has(type) ? "in-process" : "isolate";
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}
