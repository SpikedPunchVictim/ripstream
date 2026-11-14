import type { ContentHandler } from "./content-handler.ts";
import { assertValidDigestSettings, type DigestSettings } from "./digest.ts";
import { Metadata } from "./metadata.ts";
import {
  DEFAULT_LIMITS,
  ParseContext,
  CONTEXT_KEYS,
  assertValidLimits,
  type ParseLimits,
} from "./parse-context.ts";
import type { Detector, Parser } from "./parser.ts";
import { MediaType } from "./media-type.ts";
import { StaticPasswordProvider, type PasswordProvider } from "./passwords.ts";
import { BodyContentHandler, WriteOutContentHandler } from "./handlers/text.ts";
import { createOutputHandler, type HandlerType } from "./handler-type.ts";
import { OutputLimitContentHandler } from "./handlers/limits.ts";
import { ParseTimeoutError } from "./errors.ts";
import { classifyFailure, isWriteLimitReached } from "./failure.ts";
import { noteEmptyParser, recordFailure, RecursiveParserWrapper, type ParseRecord } from "./recursive.ts";
import { TIKA_KEYS } from "./tika-keys.ts";
import type { EventSink } from "./events.ts";
import { RipstreamInputStream } from "./ripstream-input-stream.ts";
import type { InputSource } from "./content-handler.ts";

export interface RipstreamOptions {
  readonly detector: Detector;
  readonly parser: Parser;
  readonly eventSink?: EventSink;
  /**
   * Limits every parse starts from. A limit a call names in `ParseOptions.limits` wins; the rest keep the library
   * defaults. `createRipstream` fills it from the `parse-context` section of a loaded configuration.
   */
  readonly limits?: Partial<ParseLimits>;
  /**
   * The digests every parse makes (Tika's digester factory): each document, the container and what is embedded in it,
   * gets `tk:digest:*` keys, by the `AutoDetectParser` that parses it. `createRipstream` fills it from the
   * `parse-context` section of a loaded configuration.
   */
  readonly digest?: DigestSettings;
}

export interface ParseOptions {
  readonly filename?: string;
  /**
   * An incoming Content-Type hint. Only the charset parameter of a `text/*` type is used: text parsers decode with it
   * instead of detecting one. It never selects a parser, so an untrusted hint cannot route bytes to a parser the
   * detector would not have chosen. The isolated path refuses it (the child detects the type and encoding itself).
   */
  readonly contentType?: string;
  /**
   * A password, or a provider, for encrypted documents. Tika's PasswordProvider in the ParseContext; the office parser
   * falls back to the default Office password when it is absent or wrong.
   */
  readonly password?: string | PasswordProvider;
  readonly limits?: Partial<ParseLimits>;
  readonly signal?: AbortSignal;
  /**
   * What `parse` and `parseRecursive` do with a document that cannot be read (malformed, encrypted, empty). "throw"
   * (default): the call rejects. "record": as Tika does, the failure is noted on the document's metadata
   * (`tk:exception:container-exception`) and the call resolves with what was extracted before it, the failure
   * itself on `ParseResult.exception` / `ParseRecord.exception`. A format no parser takes is not a failure there
   * either: Tika's EmptyParser answers an empty document. A timeout, a limit, an abort or a parser fault still
   * rejects in both modes. The other parse methods always throw.
   */
  readonly onDocumentFailure?: "throw" | "record";
  /**
   * What `parse` and `parseRecursive` do when the output reaches `limits.maxOutputChars`. "throw" (default): the
   * call rejects with a LimitExceededError. "truncate": as Tika's server does with its write limit, the text up to
   * the limit is the answer and `tk:exception:write-limit-reached` = "true" is set on the metadata of the document
   * (`parseRecursive`: of the container, and of the embedded document whose text was cut). The limit is one budget
   * for the container and everything embedded in it. Every other limit still rejects. The other parse methods
   * always throw.
   */
  readonly onOutputLimit?: "throw" | "truncate";
  /**
   * The shape the content of `parse` (`ParseResult.text`) and of each `parseRecursive` record is written in; see
   * HandlerType. Default "text". `maxOutputChars` counts the characters a handler is given, as Tika's write limit does
   * for its handler of the same type: for "text" and "body" the characters of the body, for "html", "xml" and
   * "markdown" every character the parsers write (markup excluded), for "ignore" nothing (no output, no limit).
   */
  readonly handlerType?: HandlerType;
  /**
   * `parseRecursive` only: keep the bytes of the embedded documents, on `ParseRecord.bytes`, up to this many in all
   * (a whole number, 0 for none but the empty ones). A document that would take the total past it keeps none and is
   * parsed all the same. Default: no bytes kept. This is what `/unpack` answers from.
   */
  readonly unpackBytes?: number;
}

export interface ParseResult {
  readonly metadata: Metadata;
  readonly text: string;
  /** The failure of a document that could not be read; only under `onDocumentFailure: "record"`. */
  readonly exception?: Error;
}

/** Facade over detector + parser, mirroring org.apache.tika.Tika. */
export class Ripstream {
  private readonly detector: Detector;
  private readonly parser: Parser;
  private readonly eventSink: EventSink | undefined;
  private readonly limits: Partial<ParseLimits> | undefined;
  private readonly digest: DigestSettings | undefined;

  constructor(options: RipstreamOptions) {
    assertValidLimits(options.limits);
    if (options.digest !== undefined) assertValidDigestSettings(options.digest);
    this.digest = options.digest;
    this.detector = options.detector;
    this.parser = options.parser;
    this.eventSink = options.eventSink;
    this.limits = options.limits === undefined ? undefined : { ...options.limits };
  }

  /** The limits of one call: this instance's defaults, under whatever the call names (a value of undefined names none). */
  private limitsFor(call: Partial<ParseLimits> | undefined): Partial<ParseLimits> | undefined {
    if (this.limits === undefined) return call;
    const merged: Record<string, number | undefined> = { ...this.limits };
    for (const [name, value] of Object.entries(call ?? {})) if (value !== undefined) merged[name] = value as number;
    return merged as Partial<ParseLimits>;
  }

  async detect(
    source: InputSource | null,
    options: { filename?: string; signal?: AbortSignal } = {},
  ): Promise<MediaTypeResult> {
    if (source === null) {
      return this.detector.detect(null, metadataFor(options.filename), new ParseContext());
    }
    return this.withStream(source, options, async (stream, metadata, ctx) =>
      this.detector.detect(stream, metadata, ctx),
    );
  }

  async parse(source: InputSource, options: ParseOptions = {}): Promise<ParseResult> {
    const type = options.handlerType ?? "text";
    // `parse` filters to the body before the handler (see parseNoting), so a text handler gives a body handler's output
    // and a body handler would never see the body begin.
    const handler = createOutputHandler(type === "body" ? "text" : type);
    const counting = type === "ignore" ? "none" : type === "text" || type === "body" ? "body" : "all";
    const { metadata, exception } = await this.parseNoting(source, handler, options, counting);
    return { metadata, text: handler.toString(), ...(exception === null ? {} : { exception }) };
  }

  async parseToString(source: InputSource, options: ParseOptions = {}): Promise<string> {
    return (await this.parse(source, { ...options, onDocumentFailure: "throw", onOutputLimit: "throw" })).text;
  }

  /**
   * Streams text output as it is produced. Backpressure is carried through the
   * transform so a slow consumer does not grow memory.
   */
  parseToStream(
    source: InputSource,
    options: ParseOptions = {},
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const abort = new AbortController();
    const signal =
      options.signal === undefined
        ? abort.signal
        : AbortSignal.any([options.signal, abort.signal]);
    // The consumer-wait below must observe the parse timeout too, so the
    // timeout is armed here on the same controller instead of only in withStream.
    assertValidLimits(options.limits);
    const timeout = this.limitsFor(options.limits)?.maxParseMillis ?? DEFAULT_LIMITS.maxParseMillis;
    const timer =
      timeout > 0 ? setTimeout(() => abort.abort(new ParseTimeoutError()), timeout) : null;
    timer?.unref?.();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let resume: (() => void) | null = null;
    let cancelled = false;

    const handler = new BodyContentHandler(async (text) => {
      if (cancelled) return;
      controller?.enqueue(encoder.encode(text));
      if ((controller?.desiredSize ?? 1) <= 0) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            resume = null;
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("Aborted", "AbortError"),
            );
          };
          if (signal.aborted) return onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
          resume = () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          };
        });
      }
    });

    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull() {
        resume?.();
        resume = null;
      },
      cancel(reason) {
        cancelled = true;
        const error =
          reason instanceof Error
            ? reason
            : new DOMException("Stream cancelled", "AbortError");
        abort.abort(error);
        resume?.();
        resume = null;
      },
    });

    void this.parseToHandler(source, handler, { ...options, signal })
      .finally(() => {
        if (timer !== null) clearTimeout(timer);
      })
      .then(() => {
        if (!cancelled) {
          try {
            controller?.close();
          } catch {
            // Stream already closed by the consumer.
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          try {
            controller?.error(error);
          } catch {
            // Stream already errored by the consumer.
          }
        }
      });

    return stream;
  }

  async parseToHandler(
    source: InputSource,
    handler: ContentHandler,
    options: ParseOptions = {},
  ): Promise<Metadata> {
    return (await this.parseNoting(source, handler, { ...options, onDocumentFailure: "throw", onOutputLimit: "throw" })).metadata;
  }

  /**
   * `parseToHandler`; under `onDocumentFailure: "record"` also the failure of a document that could not be read, and
   * under `onOutputLimit: "truncate"` a parse that ends where the output limit was reached.
   */
  private async parseNoting(
    source: InputSource,
    handler: ContentHandler,
    options: ParseOptions,
    counting: "all" | "body" | "none" = "all",
  ): Promise<{ readonly metadata: Metadata; readonly exception: Error | null }> {
    const recording = options.onDocumentFailure === "record";
    return this.withStream(source, options, async (stream, metadata, ctx) => {
      ctx.set(CONTEXT_KEYS.PARSER, this.parser);
      ctx.set(CONTEXT_KEYS.DETECTOR, this.detector);
      const started = performance.now();
      this.eventSink?.emit({
        type: "start",
        ...(options.filename === undefined ? {} : { resourceName: options.filename }),
      });
      // Only a limit this call's own handler reached is a truncation: a WriteOutContentHandler of the caller's that
      // throws its own WriteLimitReachedError is the caller's to deal with.
      const truncator =
        options.onOutputLimit === "truncate" && counting !== "none"
          ? new WriteOutContentHandler(handler, { writeLimit: ctx.limits.maxOutputChars })
          : null;
      const counted = truncator ?? new OutputLimitContentHandler(handler, ctx.limits.maxOutputChars);
      // `counting`: "body" counts the text of the body, as Tika's limit does for its body handler (BodyContentHandler in
      // front of the WriteOutContentHandler), not the markup whitespace and the title around it; "none" is the ignore
      // handler, which has no limit.
      const limited =
        counting === "none"
          ? handler
          : counting === "body"
            ? new BodyContentHandler((text) => counted.characters?.(text, 0, text.length))
            : counted;
      try {
        await this.parser.parse(stream, limited, metadata, ctx);
      } catch (error) {
        const cut = truncator?.isWriteLimitReached === true && isWriteLimitReached(error);
        const failure = recording && !ctx.signal.aborted ? classifyFailure(error) : "fatal";
        if (cut) {
          // The output ended the parse early, by design: what was written is the answer.
        } else if (failure === "unsupported") {
          noteEmptyParser(metadata);
        } else {
          this.eventSink?.emit({
            type: "error",
            ...(options.filename === undefined ? {} : { resourceName: options.filename }),
            error: error instanceof Error ? error.message : String(error),
          });
          if (failure !== "document") throw error;
          const exception = error instanceof Error ? error : new Error(String(error));
          recordFailure(metadata, TIKA_KEYS.CONTAINER_EXCEPTION, exception);
          return { metadata, exception };
        }
      }
      if (truncator?.isWriteLimitReached === true) metadata.set(TIKA_KEYS.WRITE_LIMIT_REACHED, "true");
      this.eventSink?.emit({
        type: "end",
        ...(options.filename === undefined ? {} : { resourceName: options.filename }),
        ...(metadata.get("Content-Type") === null
          ? {}
          : { mediaType: metadata.get("Content-Type")! }),
        durationMs: performance.now() - started,
      });
      return { metadata, exception: null };
    });
  }

  async parseRecursive(
    source: InputSource,
    options: ParseOptions = {},
  ): Promise<readonly ParseRecord[]> {
    if (options.unpackBytes !== undefined && !(Number.isSafeInteger(options.unpackBytes) && options.unpackBytes >= 0)) {
      throw new RangeError(`unpackBytes must be a non-negative whole number, got ${String(options.unpackBytes)}`);
    }
    return this.withStream(source, options, async (stream, metadata, ctx) => {
      ctx.set(CONTEXT_KEYS.PARSER, this.parser);
      ctx.set(CONTEXT_KEYS.DETECTOR, this.detector);
      const recording = options.onDocumentFailure === "record";
      const wrapper = new RecursiveParserWrapper(this.parser, {
        recordFailures: recording,
        truncateOutput: options.onOutputLimit === "truncate",
        handlerType: options.handlerType ?? "text",
        ...(options.unpackBytes === undefined ? {} : { unpackBytes: options.unpackBytes }),
      });
      try {
        await wrapper.parse(stream, createOutputHandler("ignore"), metadata, ctx);
      } catch (error) {
        // The wrapper has noted the failure on the container's record; what is kept is the answer.
        if (!recording || ctx.signal.aborted || classifyFailure(error) !== "document") throw error;
      }
      return wrapper.getRecords();
    });
  }

  private async withStream<T>(
    source: InputSource,
    options: {
      filename?: string;
      contentType?: string;
      password?: string | PasswordProvider;
      signal?: AbortSignal;
      limits?: Partial<ParseLimits>;
    },
    action: (
      stream: RipstreamInputStream,
      metadata: Metadata,
      ctx: ParseContext,
    ) => Promise<T>,
  ): Promise<T> {
    assertValidLimits(options.limits);
    const limits = this.limitsFor(options.limits);
    const timeout = limits?.maxParseMillis ?? DEFAULT_LIMITS.maxParseMillis;
    const timeoutController = new AbortController();
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timeoutController.abort(new ParseTimeoutError());
          }, timeout)
        : null;
    if (timer !== null) timer.unref?.();
    const signal =
      options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([options.signal, timeoutController.signal]);
    const ctx = new ParseContext({
      signal,
      ...(limits === undefined ? {} : { limits }),
    });
    const metadata = metadataFor(options.filename);
    ctx.set(CONTEXT_KEYS.ROOT_METADATA, metadata);
    metadata.setMaxValueChars(ctx.limits.maxMetadataValueChars);
    metadata.setMaxTotalChars(ctx.limits.maxMetadataTotalChars);
    if (this.digest !== undefined) ctx.set(CONTEXT_KEYS.DIGESTS, this.digest);
    const charset = charsetHint(options.contentType);
    if (charset !== undefined) ctx.set(CONTEXT_KEYS.CHARSET_HINT, charset);
    if (options.password !== undefined) {
      ctx.set(
        CONTEXT_KEYS.PASSWORD_PROVIDER,
        typeof options.password === "string" ? new StaticPasswordProvider(options.password) : options.password,
      );
    }
    const stream = await RipstreamInputStream.from(source, {
      context: ctx,
      signal,
    });
    try {
      const result = await action(stream, metadata, ctx);
      ctx.throwIfAborted(); // a parser that swallowed/rewrapped the abort must not report success
      return result;
    } catch (error) {
      if (signal.aborted) ctx.throwIfAborted();
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
      await stream.close();
      await ctx.resources.closeAll();
    }
  }
}

export type MediaTypeResult = Awaited<ReturnType<Detector["detect"]>>;

/**
 * The charset of a `text/*` incoming Content-Type, which text parsers decode with instead of detecting one. A hint is
 * never used to choose a parser (the detector and the in-process allowlist still decide that), and any other type is
 * ignored.
 */
function charsetHint(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  const type = MediaType.parse(contentType);
  if (type === null || !type.getBaseType().toString().startsWith("text/")) return undefined;
  return type.getParameter("charset") ?? undefined;
}

function metadataFor(filename: string | undefined): Metadata {
  const metadata = new Metadata();
  if (filename !== undefined) metadata.set("tk:resource-name", filename);
  return metadata;
}
