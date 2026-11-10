import type { ContentHandler } from "./content-handler.ts";
import { Metadata } from "./metadata.ts";
import {
  DEFAULT_LIMITS,
  ParseContext,
  CONTEXT_KEYS,
  assertValidLimits,
  type ParseLimits,
} from "./parse-context.ts";
import type { Detector, Parser } from "./parser.ts";
import { TextContentHandler, BodyContentHandler } from "./handlers/text.ts";
import { OutputLimitContentHandler } from "./handlers/limits.ts";
import { ParseTimeoutError } from "./errors.ts";
import { RecursiveParserWrapper, type ParseRecord } from "./recursive.ts";
import type { EventSink } from "./events.ts";
import { RipstreamInputStream } from "./ripstream-input-stream.ts";
import type { InputSource } from "./content-handler.ts";

export interface RipstreamOptions {
  readonly detector: Detector;
  readonly parser: Parser;
  readonly eventSink?: EventSink;
}

export interface ParseOptions {
  readonly filename?: string;
  readonly contentType?: string;
  readonly limits?: Partial<ParseLimits>;
  readonly signal?: AbortSignal;
}

export interface ParseResult {
  readonly metadata: Metadata;
  readonly text: string;
}

/** Facade over detector + parser, mirroring org.apache.tika.Tika. */
export class Ripstream {
  private readonly detector: Detector;
  private readonly parser: Parser;
  private readonly eventSink: EventSink | undefined;

  constructor(options: RipstreamOptions) {
    this.detector = options.detector;
    this.parser = options.parser;
    this.eventSink = options.eventSink;
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
    const handler = new BodyContentHandler();
    const metadata = await this.parseToHandler(source, handler, options);
    return { metadata, text: handler.toString() };
  }

  async parseToString(source: InputSource, options: ParseOptions = {}): Promise<string> {
    return (await this.parse(source, options)).text;
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
    const timeout = options.limits?.maxParseMillis ?? DEFAULT_LIMITS.maxParseMillis;
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
    return this.withStream(source, options, async (stream, metadata, ctx) => {
      ctx.set(CONTEXT_KEYS.PARSER, this.parser);
      ctx.set(CONTEXT_KEYS.DETECTOR, this.detector);
      const started = performance.now();
      this.eventSink?.emit({
        type: "start",
        ...(options.filename === undefined ? {} : { resourceName: options.filename }),
      });
      const limited = new OutputLimitContentHandler(
        handler,
        ctx.limits.maxOutputChars,
      );
      try {
        await this.parser.parse(stream, limited, metadata, ctx);
      } catch (error) {
        this.eventSink?.emit({
          type: "error",
          ...(options.filename === undefined ? {} : { resourceName: options.filename }),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      this.eventSink?.emit({
        type: "end",
        ...(options.filename === undefined ? {} : { resourceName: options.filename }),
        ...(metadata.get("Content-Type") === null
          ? {}
          : { mediaType: metadata.get("Content-Type")! }),
        durationMs: performance.now() - started,
      });
      return metadata;
    });
  }

  async parseRecursive(
    source: InputSource,
    options: ParseOptions = {},
  ): Promise<readonly ParseRecord[]> {
    return this.withStream(source, options, async (stream, metadata, ctx) => {
      ctx.set(CONTEXT_KEYS.PARSER, this.parser);
      ctx.set(CONTEXT_KEYS.DETECTOR, this.detector);
      const wrapper = new RecursiveParserWrapper(this.parser);
      await wrapper.parse(stream, new TextContentHandler(), metadata, ctx);
      return wrapper.getRecords();
    });
  }

  private async withStream<T>(
    source: InputSource,
    options: { filename?: string; signal?: AbortSignal; limits?: Partial<ParseLimits> },
    action: (
      stream: RipstreamInputStream,
      metadata: Metadata,
      ctx: ParseContext,
    ) => Promise<T>,
  ): Promise<T> {
    assertValidLimits(options.limits);
    const timeout = options.limits?.maxParseMillis ?? DEFAULT_LIMITS.maxParseMillis;
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
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
    const metadata = metadataFor(options.filename);
    metadata.setMaxValueChars(ctx.limits.maxMetadataValueChars);
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

function metadataFor(filename: string | undefined): Metadata {
  const metadata = new Metadata();
  if (filename !== undefined) metadata.set("resourceName", filename);
  return metadata;
}
