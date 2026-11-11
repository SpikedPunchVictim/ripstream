import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CONTENT_LENGTH,
  digestBytes,
  emitMetadataFilter,
  filterDocument,
  metadataFiltersOf,
  metadataJson,
  type DigestSettings,
  type EmitMetadataFilters,
  type FilteredDocument,
  type MetadataFilterServices,
  type RmetaValue,
  rmetaObjects,
  TEXT_HANDLER_TYPE,
  TIKA_KEYS,
  type ParseLimits,
  type ParseRecord,
  type PipesEmitterSettings,
  type PipesFetcherSettings,
  type PipesIteratorSettings,
  type PipesReporterSettings,
  type PipesSettings,
  type Ripstream,
  RipstreamConfigError,
  type UnpackSettings,
} from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { PIPE_MODES, assertValidEngineOptions, assertValidPipesConfig } from "./config.ts";
import { FileSystemFetcher, FileSystemPipesIterator, HttpFetcher, PipesPathError, UrlListPipesIterator } from "./components.ts";
import { AzBlobEmitter, AzBlobFetcher, AzBlobPipesIterator, type AzBlobTransport } from "./azblob/components.ts";
import { GcsEmitter, GcsFetcher, GcsPipesIterator, type GcsTransport } from "./gcs/components.ts";
import { S3Emitter, S3Fetcher, S3PipesIterator, type S3Transport } from "./s3/components.ts";
import { BulkSearchEmitter, type SearchTransport } from "./search/bulk-emitter.ts";
import { SearchPipesReporter } from "./search/reporter.ts";
import { SolrEmitter, SolrPipesIterator, type SolrTransport } from "./solr/components.ts";
import { CompositeReporter, JsonlReporter } from "./adapters.ts";
import { FileSystemEmitter, FlatFileEmitter } from "./file-system-emitter.ts";
import { type Checkpoint, type RetryOptions, isTransientError, withRetry } from "./resilience.ts";
import { type ExtensionOf, resolveUnpack, unpackDocuments } from "./unpack.ts";
import { type FetchEmitTuple, type Fetcher, type PipesIterator } from "./tuple.ts";
import {
  type PipesResult,
  type PipesResultStatus,
  describeError,
  isFailure,
  pipesResult,
  statusForParseError,
} from "./result.ts";

export { PIPE_MODES, assertValidPipesConfig, validatePipesConfig } from "./config.ts";
export {
  FileSystemFetcher,
  FileSystemPipesIterator,
  HttpFetcher,
  HttpStatusError,
  PipesPathError,
  UrlListPipesIterator,
  type FileSystemFetcherOptions,
  type FileSystemPipesIteratorOptions,
} from "./components.ts";
export {
  FileSystemEmitter,
  FlatFileEmitter,
  jacksonPretty,
  type Compression,
  type FileSystemEmitterOptions,
  type OnExists,
} from "./file-system-emitter.ts";
export { componentIdIssue, parseFetchEmitTuple, type FetchContext, type FetchEmitTuple, type Fetcher, type PipesIterator } from "./tuple.ts";
export {
  PIPES_RESULT_STATUSES,
  httpResponseFor,
  isFailure,
  pipesResult,
  statusForParseError,
  type PipesHttpResponse,
  type PipesResult,
  type PipesResultCategory,
  type PipesResultStatus,
} from "./result.ts";

export interface PipeDocument {
  readonly id: string;
  readonly data: Uint8Array;
  readonly metadata?: Readonly<Record<string, RmetaValue>>;
}

/**
 * An input the fetcher could not read. The run records it as FETCH_EXCEPTION and goes on with the next input, as
 * Tika does for one tuple. A fetcher whose iteration itself throws (it cannot list its inputs) ends the run.
 */
export interface PipeFetchFailure {
  readonly id: string;
  readonly error: unknown;
}

/**
 * Documents that arrive with their bytes, as a queue consumer or a CSV of rows gives them. Everything that names its
 * bytes (a path, a URL) is a `Fetcher` read by key from an iterator's tuples instead: that reads concurrently, and
 * this reads one input at a time inside the iteration.
 */
export interface DocumentSource {
  fetch(): AsyncIterable<PipeDocument | PipeFetchFailure>;
}

export const isFetchFailure = (input: PipeDocument | PipeFetchFailure): input is PipeFetchFailure => "error" in input;

/**
 * What the engine hands an emitter. `mode` is the parse mode that made it, as Tika's emitters read it from the parse
 * context, and says what the rest is:
 * - RMETA: `records`, the document and everything embedded in it; `text` is the same as the JSON /rmeta answers.
 * - CONCATENATE: `metadata` of the document and in `text` its content, the embedded documents' text included.
 * - CONTENT_ONLY: the same, for an emitter that writes only `text`.
 * - NO_PARSE: `metadata` only, what detection found out; no content.
 * - UNPACK: the RMETA document, and one `bytes` document for each embedded document whose bytes were kept, with the
 *   key `<emitKey>-embed/<embedded id>`.
 */
export interface EmittedDocument {
  readonly id: string;
  readonly mode?: PipeMode;
  readonly text?: string;
  readonly bytes?: Uint8Array;
  readonly metadata?: Readonly<Record<string, RmetaValue>>;
  readonly records?: readonly ParseRecord[];
  /**
   * RMETA and UNPACK: the metadata list as it is written, one object for each of `records` that the run's metadata filters
   * left in the list, with the filters applied. An emitter that writes the list writes this: `records` are the parse, before
   * the filters, and carry the embedded documents' bytes.
   */
  readonly objects?: readonly Record<string, RmetaValue>[];
}

export interface Emitter {
  emit(document: EmittedDocument): Promise<void> | void;
  close?(): Promise<void> | void;
}

/** What the engine calls to parse. A core Ripstream satisfies it, and so does an isolated one. */
export type PipesRipstream = Pick<Ripstream, "parse" | "parseRecursive" | "detect">;

export type PipeMode = (typeof PIPE_MODES)[number];

/**
 * Hears the result of every input, one at a time, in the order they settle (with `ordered`, in fetch order). A
 * reporter that throws ends the run with that error: the operator's audit trail is not allowed to go missing quietly.
 */
export interface Reporter {
  /** `tuple` is the input's: every result is an input's. It is optional for a reporter that is called by hand. */
  report(result: PipesResult, tuple?: FetchEmitTuple): Promise<void> | void;
}

/** Tika's FetchEmitTuple.ON_PARSE_EXCEPTION: what is done with a document whose parse recorded a failure. */
export type OnParseException = "EMIT" | "SKIP";

export interface PipesEngineOptions {
  /** What to run: tuples, resolved through `fetchers` and `emitters`. Give this or `source`. */
  readonly iterator?: PipesIterator;
  /** What to run: documents that arrive with their bytes, emitted by `emitter`. Give this or `iterator`. */
  readonly source?: DocumentSource;
  /** Fetchers by id, for the tuples' `fetcher`. A tuple naming one that is not here is FETCHER_NOT_FOUND. */
  readonly fetchers?: Readonly<Record<string, Fetcher>>;
  /** Emitters by id, for the tuples' `emitter`. A tuple naming one that is not here is EMITTER_NOT_FOUND. */
  readonly emitters?: Readonly<Record<string, Emitter>>;
  /**
   * The emitter for a tuple that names none: this one, or when it is not given the only one in `emitters`.
   */
  readonly emitter?: Emitter;
  readonly mode?: PipeMode;
  readonly concurrency?: number;
  readonly maxQueue?: number;
  readonly ordered?: boolean;
  /**
   * Ordered mode only: maximum inputs in flight ahead of delivery (parsing or
   * parsed-but-undelivered). Defaults to `concurrency * 4`.
   */
  readonly maxBuffered?: number;
  readonly limits?: Partial<ParseLimits>;
  /**
   * Parses every document. Default: the standard in-process pipeline. A service that isolates parsing must pass
   * its isolated ripstream here, or the pipe bypasses the isolation boundary.
   */
  readonly ripstream?: PipesRipstream;
  /** Receives the result of every input. Default: none. */
  readonly reporter?: Reporter;
  /**
   * A document that could not be read (malformed, encrypted, empty) is "EMIT" (default, as Tika's): what was
   * extracted is emitted with the failure in its metadata, EMIT_SUCCESS_PARSE_EXCEPTION; "SKIP": nothing is emitted,
   * PARSE_EXCEPTION_NO_EMIT.
   */
  readonly onParseException?: OnParseException;
  /**
   * UNPACK only: the most bytes of embedded documents kept from one input (default 100 MiB). A document that would take
   * the total past it keeps none: it is in the metadata, and its bytes are not emitted.
   */
  readonly unpackBytes?: number;
  /**
   * UNPACK only: what is emitted for an input (Tika's UnpackConfig, `parse-context` `unpack-config` in a configuration).
   * By default one zip, `<emitKey>-frictionless.zip`, of `datapackage.json`, `rmeta.json` and `unpacked/<file>`: the package
   * `/unpack` answers, which replaces the `<emitKey>` metadata document. `outputFormat: "REGULAR"` emits that document and
   * each embedded document's bytes at `<emitKey>-embed/<id>` instead. The zip is built in memory, beside the bytes it holds.
   */
  readonly unpack?: UnpackSettings;
  /**
   * The digests an input gets (Tika's `parse-context` digester factory; `pipes` settings carry it from a configuration).
   * NO_PARSE digests and detects without a parse, so the parser's own digesting never runs: it uses these. The other
   * modes digest in the parser, so the ripstream made here is given them; a `ripstream` passed in digests as it was
   * built, and these do not reach it. Default: none.
   */
  readonly digest?: DigestSettings;
  /**
   * The metadata filters of the run (Tika's `metadata-filters`; `pipes` settings carry them from a configuration). Every
   * mode runs them on what it emits, after the parse and before the emitter, as Tika's `EmitHandler` does: the parse-context
   * chain if there is one, else for CONTENT_ONLY the content and the container exception only, else the configured chain.
   * Default: none, nothing is filtered.
   */
  readonly metadataFilters?: EmitMetadataFilters;
  /**
   * UNPACK with `suffixStrategy: "DETECTED"`: the extension, dot included, of a media type (a server's registry of types
   * knows them). Default: none known, `.bin` for every type.
   */
  readonly extensionOf?: ExtensionOf;
  /**
   * Tries a fetch or an emit again when it failed in a way that may not happen again (a connection reset, a timeout, a
   * 429 or 503: `isTransientError`, or `retryIf`), with a growing wait between tries. Each emit of a document is tried
   * on its own, so one that was emitted is not emitted again because the next was not. Default: none, a failure is the
   * input's result at once. A document that arrives with its bytes from `source` has no fetch to try again.
   */
  readonly retry?: RetryOptions;
  /**
   * Makes the run one that can be started again after it stopped, however it stopped (an error, a signal, a kill). An
   * input whose id is in it is left out: not fetched, parsed or emitted, and counted in `stats.resumed`. An input is
   * added once it succeeded (a result whose category is SUCCESS: an emitted document, a parse exception that was
   * emitted or skipped on purpose) and its result was reported; one that failed is not, so a second run does it again.
   *
   * A run that stops between emitting a document and recording it emits that input again, so the emitter must take a
   * second write of the same key: a file-system emitter whose `onExists` is REPLACE or SKIP (EXCEPTION, Tika's default,
   * fails that one input, visibly). Reporters hear an input again too, which is a repeat and never a gap.
   */
  readonly checkpoint?: Checkpoint;
}

/** Bounded-concurrency pipe runner over a fetcher/emitter pair. */
export interface PipesStats {
  /** Inputs the fetcher gave that this run went on with, readable or not. Not those `resumed`. */
  readonly fetched: number;
  /** Inputs left out because the checkpoint said an earlier run finished them. */
  readonly resumed: number;
  /** Inputs that were emitted (an UNPACK input counts once). */
  readonly emitted: number;
  /** Results whose category is not SUCCESS: a parse exception that was emitted or skipped is not one. */
  readonly failed: number;
  readonly durationMs: number;
  /** How many results had each status. */
  readonly byStatus: Readonly<Partial<Record<PipesResultStatus, number>>>;
}

export class PipesEngine {
  readonly #options: PipesEngineOptions;
  #stats: PipesStats = { fetched: 0, resumed: 0, emitted: 0, failed: 0, durationMs: 0, byStatus: {} };

  constructor(options: PipesEngineOptions) {
    assertValidEngineOptions(options);
    this.#options = options;
  }

  get stats(): PipesStats {
    return this.#stats;
  }

  /**
   * Runs every input the fetcher gives and resolves with how many were emitted. An input that fails (it cannot be
   * fetched, parsed or emitted) is a result with a status, reported and counted, and the run goes on with the next:
   * what each input came to is in the results `reporter` hears and in `stats.byStatus`. Only a run that cannot go
   * on rejects: a fetcher that cannot list its inputs, a reporter that throws, or an emitter that cannot close.
   */
  async run(): Promise<number> {
    const started = performance.now();
    let fetched = 0;
    let resumed = 0;
    let failed = 0;
    const mode = this.#options.mode ?? "CONTENT_ONLY";
    const concurrency = Math.max(1, this.#options.concurrency ?? 4);
    const maxQueue = Math.max(1, this.#options.maxQueue ?? 64);
    const ordered = this.#options.ordered ?? false;
    const useSlots = ordered;
    const windowSize = Math.max(1, this.#options.maxBuffered ?? concurrency * 4);
    const options = this.#options;
    const reporter = options.reporter;
    const onParseException = this.#options.onParseException ?? "EMIT";
    const unpackBytes = this.#options.unpackBytes ?? this.#options.unpack?.maxUnpackBytes ?? DEFAULT_UNPACK_BYTES;
    const unpack = resolveUnpack(this.#options.unpack);
    const extensionOf = this.#options.extensionOf ?? (() => ".bin");
    const digest = this.#options.digest;
    const metadataFilters = this.#options.metadataFilters;
    // The document as the run's filters leave it: the content is the `tk:content` of its metadata for them.
    const filtered = (metadata: Record<string, RmetaValue>, text: string, contentOnly: boolean): FilteredDocument => {
      const filter = emitMetadataFilter(metadataFilters, contentOnly);
      return filter === null ? { metadata, text } : filterDocument(filter, { metadata, text });
    };
    // A ripstream the caller passes digests as it was built; the one made here digests as the run's settings say, in every mode.
    const ripstream = this.#options.ripstream ?? createRipstream(digest === undefined ? {} : { digest });
    const limits = this.#options.limits;
    const checkpoint = options.checkpoint;
    const retry = options.retry;
    // A try again of a fetch or an emit, when the run asked for them; only failures that may not repeat are tried again.
    const attempt = <T>(task: () => Promise<T>): Promise<T> =>
      retry === undefined ? task() : withRetry(task, { ...retry, retryIf: retry.retryIf ?? isTransientError, signal });
    // Documents that arrive with their bytes are held here, by the key their tuple carries, until a worker takes them.
    const inline = new Map<string, PipeDocument | PipeFetchFailure>();
    const fetchers: Readonly<Record<string, Fetcher>> =
      options.source === undefined ? (options.fetchers ?? {}) : { ...options.fetchers, [INLINE_FETCHER]: inlineFetcher(inline) };
    const emitters = options.emitters ?? {};
    const emitterIds = Object.keys(emitters);
    const defaultEmitter: Emitter | undefined = options.emitter ?? (emitterIds.length === 1 ? emitters[emitterIds[0]!] : undefined);
    const iterator = (options.source === undefined ? options.iterator! : inlineTuples(options.source, inline))[Symbol.asyncIterator]();
    const queue: Array<{ tuple: FetchEmitTuple; index: number }> = [];
    let fetchedDone = false;
    let filling: Promise<void> | null = null;
    let emitted = 0;
    const byStatus: Partial<Record<PipesResultStatus, number>> = {};

    const controller = new AbortController();
    const signal = controller.signal;

    // One result at a time to the reporter, so a reporter needs no locking of its own.
    let reportTail: Promise<void> = Promise.resolve();
    const settle = (result: PipesResult, tuple?: FetchEmitTuple): Promise<void> => {
      byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
      if (isFailure(result)) failed++;
      if (reporter === undefined) return Promise.resolve();
      const reported = reportTail.then(() => reporter.report(result, tuple));
      reportTail = reported.catch(() => undefined);
      return reported;
    };

    // Ordered delivery: one slot per input, pushed in fetch order at dequeue time.
    // Workers fill their slot (parse in parallel); a single drainer emits the head
    // slot's documents, then pops it, so emit is serialized and strictly ordered.
    const slots: Slot[] = [];
    const wake = createNotifier(); // slot filled/pushed, producers done, or abort
    const windowGate = createNotifier(); // a slot was popped, or abort
    const arrived = createNotifier(); // a tuple was queued, or abort: a worker that is waiting for work need not wait for more
    let producersDone = false;

    // The first failure that ends the run: abort so siblings stop pulling new work and in-flight parses cancel.
    let failure: { readonly error: unknown } | null = null;
    const fail = (error: unknown): void => {
      // Keep the chronologically first error; later ones are usually abort echoes.
      failure ??= { error };
      controller.abort(error);
      wake.notify();
      windowGate.notify();
      arrived.notify();
    };

    const fill = async (): Promise<void> => {
      while (!fetchedDone && queue.length < maxQueue) {
        const item = await iterator.next();
        if (item.done === true) {
          fetchedDone = true;
          break;
        }
        if (checkpoint?.has(item.value.id) === true) {
          resumed++;
          // Nobody will fetch it: the bytes a source gave with it are not kept for a worker.
          if (item.value.fetcher === INLINE_FETCHER) inline.delete(item.value.fetchKey);
          continue;
        }
        queue.push({ tuple: item.value, index: fetched++ });
        arrived.notify();
      }
    };

    const next = async (): Promise<WorkItem | null> => {
      // No await between the final window/queue checks and the shift+push below,
      // so the slot window cannot be overshot by racing workers.
      for (;;) {
        if (signal.aborted) return null;
        if (useSlots && slots.length >= windowSize) {
          await windowGate.wait();
          continue;
        }
        if (queue.length > 0) break;
        if (fetchedDone) return null;
        // Filling goes on until the queue is full, but a worker takes the first tuple as soon as it is there: an iterator
        // that gives tuples as they arrive (a live queue) would otherwise hold every idle worker until the queue filled.
        // A failure of the iterator is recorded and ends the run, not left with whichever worker happened to be waiting.
        await Promise.race([
          (filling ??= fill()
            .catch(fail)
            .finally(() => {
              filling = null;
            })),
          arrived.wait(),
        ]);
      }
      const entry = queue.shift()!;
      if (!useSlots) return { ...entry, slot: null };
      const slot: Slot = { index: entry.index, produced: null };
      slots.push(slot);
      wake.notify();
      return { ...entry, slot };
    };

    // Turns one input into the documents to emit (zero for an empty UNPACK), or into the result that says why not.
    const produce = async (item: WorkItem): Promise<Produced> => {
      const begun = performance.now();
      const { tuple, index } = item;
      const emitKey = tuple.emitKey ?? tuple.id;
      const settled = (status: PipesResultStatus, message?: string): Produced => ({
        index,
        tuple,
        docs: [],
        emitter: null,
        result: pipesResult(tuple.id, status, performance.now() - begun, message),
        parseException: undefined,
        id: tuple.id,
        begun,
      });
      // Both ids are looked up before any bytes are read: a tuple that names nothing there is no work.
      const fetcher = Object.hasOwn(fetchers, tuple.fetcher) ? fetchers[tuple.fetcher] : undefined;
      if (fetcher === undefined) return settled("FETCHER_NOT_FOUND", `no fetcher has the id ${JSON.stringify(tuple.fetcher)}`);
      const target =
        tuple.emitter === undefined ? defaultEmitter : Object.hasOwn(emitters, tuple.emitter) ? emitters[tuple.emitter] : undefined;
      if (target === undefined) {
        return settled(
          "EMITTER_NOT_FOUND",
          tuple.emitter === undefined ? "the tuple names no emitter and the run has no default one" : `no emitter has the id ${JSON.stringify(tuple.emitter)}`,
        );
      }
      const emitting = (docs: EmittedDocument[], exception?: Error | null): Produced => ({
        index,
        tuple,
        docs,
        emitter: target,
        result: null,
        parseException: exception === null || exception === undefined ? undefined : describeError(exception),
        id: tuple.id,
        begun,
      });
      let bytes: Uint8Array;
      try {
        // The documents of a `source` are held for one fetch: a second would find them gone.
        bytes = await (tuple.fetcher === INLINE_FETCHER ? fetcher.fetch(tuple.fetchKey, { signal }) : attempt(() => fetcher.fetch(tuple.fetchKey, { signal })));
      } catch (error) {
        // The run is already ending: that failure is what is thrown.
        if (signal.aborted) throw error;
        return settled("FETCH_EXCEPTION", describeError(error));
      }
      const skipFailed = (tuple.onParseException ?? onParseException) === "SKIP";
      try {
        if (mode === "NO_PARSE") {
          // Tika's detectOnly (ParseHandler._preParse): what the fetcher stage knows (the name and the length), the digests,
          // then the type, with no parse. With skipContainerDocumentDigest the container is not digested here, and no
          // parser runs to digest it.
          const metadata: Record<string, string> = {
            [TIKA_KEYS.RESOURCE_NAME]: tuple.id,
            [CONTENT_LENGTH]: String(bytes.length),
          };
          if (digest !== undefined && !digest.skipContainerDocumentDigest && digest.digests.length > 0) {
            for (const [key, value] of await digestBytes(bytes, digest.digests, signal)) metadata[key] = value;
          }
          const detected = String(await ripstream.detect(bytes, { filename: tuple.id, signal }));
          metadata["Content-Type"] = detected;
          metadata[TIKA_KEYS.CONTENT_TYPE_PARSER_OVERRIDE] = detected;
          return emitting([{ id: emitKey, mode, metadata: filtered(metadata, "", false).metadata }]);
        }
        const parseOptions = {
          filename: tuple.id,
          signal,
          // A document that cannot be read is a result of the input, not the end of the run.
          onDocumentFailure: "record" as const,
          ...(limits === undefined ? {} : { limits }),
        };
        if (mode === "RMETA" || mode === "UNPACK") {
          const records = await ripstream.parseRecursive(bytes, mode === "UNPACK" ? { ...parseOptions, unpackBytes } : parseOptions);
          const exception = records[0]?.exception ?? null;
          if (exception !== null && skipFailed) {
            return settled("PARSE_EXCEPTION_NO_EMIT", describeError(exception));
          }
          if (mode === "UNPACK" && records.length === 0) return emitting([], exception);
          // What the embedded documents' bytes are paired with is the records, as the parse made them: a filter may take an
          // `tk:embedded-id` out of the list, or a document, and the bytes still go with the document they came from.
          const filter = emitMetadataFilter(metadataFilters, false);
          const objects = rmetaObjects(records, filter === null ? {} : { metadataFilter: filter });
          const rmeta = JSON.stringify(objects);
          if (mode === "RMETA") return emitting([{ id: emitKey, mode, text: rmeta, records, objects }], exception);
          return emitting(
            await unpackDocuments({ emitKey, fetchKey: tuple.fetchKey, bytes, records, objects, rmeta, unpack, extensionOf, now: new Date() }),
            exception,
          );
        }
        const result = await ripstream.parse(bytes, parseOptions);
        if (result.exception !== undefined && skipFailed) {
          return settled("PARSE_EXCEPTION_NO_EMIT", describeError(result.exception));
        }
        const metadata: Record<string, RmetaValue> = { ...metadataJson(result.metadata), [TIKA_KEYS.CONTENT_HANDLER_TYPE]: TEXT_HANDLER_TYPE };
        if (result.exception !== undefined) {
          metadata[TIKA_KEYS.CONTAINER_EXCEPTION] ??= `${result.exception.name}: ${result.exception.message}`;
        }
        const document = filtered(metadata, result.text, mode === "CONTENT_ONLY");
        return emitting([{ id: emitKey, mode, text: document.text, metadata: document.metadata }], result.exception);
      } catch (error) {
        // The run is already ending (its first failure aborted this parse): that failure is what is thrown.
        if (signal.aborted) throw error;
        return settled(statusForParseError(error), describeError(error));
      }
    };

    // Emits what produce made, then says what the input came to.
    const deliver = async (produced: Produced): Promise<void> => {
      if (signal.aborted) return;
      let result = produced.result;
      if (result === null) {
        try {
          const target = produced.emitter;
          if (target === null) throw new Error("a result with documents has no emitter");
          for (const doc of produced.docs) await attempt(async () => target.emit(doc));
          emitted++;
          const status: PipesResultStatus =
            produced.docs.length === 0
              ? "EMPTY_OUTPUT"
              : produced.parseException === undefined
                ? "EMIT_SUCCESS"
                : "EMIT_SUCCESS_PARSE_EXCEPTION";
          result = pipesResult(produced.id, status, performance.now() - produced.begun, produced.parseException);
        } catch (error) {
          if (signal.aborted) throw error;
          result = pipesResult(produced.id, "EMIT_EXCEPTION", performance.now() - produced.begun, describeError(error));
        }
      }
      await settle(result, produced.tuple);
      // Last, so that a run that stops before this has the input done again, and its result reported again, never missed.
      if (checkpoint !== undefined && !isFailure(result)) await checkpoint.mark(produced.id);
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return;
        const item = await next();
        if (item === null) return;
        const produced = await produce(item);
        if (item.slot !== null) {
          item.slot.produced = produced;
          wake.notify();
        } else {
          await deliver(produced);
        }
      }
    };

    const drain = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return;
        const head = slots[0];
        if (head?.produced == null) {
          // Nothing to emit yet: wait for a fill/push, unless no producer is left.
          if (producersDone) return;
          await wake.wait();
          continue;
        }
        await deliver(head.produced);
        if (signal.aborted) return;
        if (slots.shift() !== head) throw new Error("ordered buffer corrupted");
        windowGate.notify();
      }
    };

    // On the first failure that ends the run (`fail`), wait for every worker and the drainer to settle,
    // then close the emitters and fetchers (always) and rethrow the original error.
    const guarded = async (task: () => Promise<void>): Promise<void> => {
      try {
        await task();
      } catch (error) {
        fail(error);
      }
    };

    try {
      const workers = Promise.all(
        Array.from({ length: concurrency }, () => guarded(worker)),
      ).finally(() => {
        producersDone = true;
        wake.notify();
      });
      await Promise.all([workers, ...(useSlots ? [guarded(drain)] : [])]);
      if (failure !== null) throw (failure as { readonly error: unknown }).error;
      if (slots.length !== 0) throw new Error("ordered buffer not drained");
    } finally {
      try {
        await closeComponents([options.emitter, ...Object.values(emitters), ...Object.values(options.fetchers ?? {})]);
      } finally {
        this.#stats = {
          fetched,
          resumed,
          emitted,
          failed,
          durationMs: performance.now() - started,
          byStatus,
        };
      }
    }
    return emitted;
  }
}

/** One input's place in the ordered-delivery FIFO; `produced` is null until it is parsed. */
interface Slot {
  readonly index: number;
  produced: Produced | null;
}

interface WorkItem {
  readonly tuple: FetchEmitTuple;
  readonly index: number;
  readonly slot: Slot | null;
}

/** What produce made of one input: documents to emit, or the result that already says why there are none. */
interface Produced {
  readonly index: number;
  readonly tuple: FetchEmitTuple;
  /** Where `docs` go; null when `result` already says why there is nothing to emit. */
  readonly emitter: Emitter | null;
  readonly id: string;
  readonly docs: EmittedDocument[];
  readonly result: PipesResult | null;
  /** The parse exception that was recorded on the document and is emitted with it. */
  readonly parseException: string | undefined;
  readonly begun: number;
}

/** What `unpackBytes` is when nothing says otherwise, as the server's `maxUnpackBytes`. */
const DEFAULT_UNPACK_BYTES = 100 * 1024 * 1024;

/** The id the engine gives the fetcher it supplies for a `source`: ids that start with "__" are kept for it. */
const INLINE_FETCHER = "__inline";

/** Gives the documents of a source as tuples that point at them; the bytes wait in `inline` for the worker that takes the tuple. */
async function* inlineTuples(source: DocumentSource, inline: Map<string, PipeDocument | PipeFetchFailure>): PipesIterator {
  let next = 0;
  for await (const input of source.fetch()) {
    const key = String(next++);
    inline.set(key, input);
    yield { id: input.id, fetcher: INLINE_FETCHER, fetchKey: key };
  }
}

function inlineFetcher(inline: Map<string, PipeDocument | PipeFetchFailure>): Fetcher {
  return {
    async fetch(key) {
      const input = inline.get(key);
      inline.delete(key);
      if (input === undefined) throw new Error(`the document ${key} is no longer held`);
      if (isFetchFailure(input)) throw input.error;
      return input.data;
    },
  };
}

/** Closes each component once, all of them even when one fails, and throws the first failure. */
async function closeComponents(components: ReadonlyArray<{ close?(): Promise<void> | void } | undefined>): Promise<void> {
  let failure: { readonly error: unknown } | null = null;
  const seen = new Set<object>();
  for (const component of components) {
    if (component === undefined || seen.has(component)) continue;
    seen.add(component);
    try {
      await component.close?.();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== null) throw (failure as { readonly error: unknown }).error;
}

interface Notifier {
  wait(): Promise<void>;
  notify(): void;
}

/** Broadcast wake-up: notify() resolves every promise handed out by wait() so far. */
function createNotifier(): Notifier {
  let resolvers: Array<() => void> = [];
  return {
    wait: () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }),
    notify: () => {
      const pending = resolvers;
      resolvers = [];
      for (const resolve of pending) resolve();
    },
  };
}

/**
 * Resolves a client-supplied relative path under a trusted root. Rejects absolute paths,
 * `..` escapes and any existing symlink along the path. The path itself need not exist.
 */
export async function resolveWithinRoot(root: string, requested: string): Promise<string> {
  if (requested.includes("\0")) throw new PipesPathError("Path contains a NUL byte");
  if (isAbsolute(requested) || /^[A-Za-z]:/.test(requested)) {
    throw new PipesPathError(`Absolute paths are not allowed: ${requested}`);
  }
  const realRoot = await realpath(root);
  const target = resolve(realRoot, requested);
  const rel = relative(realRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PipesPathError(`Path escapes the configured root: ${requested}`);
  }
  let current = realRoot;
  for (const part of rel === "" ? [] : rel.split(sep)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new PipesPathError(`Symbolic links are not allowed: ${requested}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

/** Collects emitted documents in memory (tests and embedded use). */
export class MemoryEmitter implements Emitter {
  readonly documents: EmittedDocument[] = [];
  async emit(document: EmittedDocument): Promise<void> {
    this.documents.push(document);
  }
}

/** JSON configuration for filesystem → filesystem pipes. */
export interface PipesConfig {
  readonly mode?: PipeMode;
  readonly concurrency?: number;
  readonly maxQueue?: number;
  readonly ordered?: boolean;
  readonly source: { readonly type: "filesystem" | "http"; readonly path?: string; readonly urls?: readonly string[] };
  readonly sink?: { readonly type: "filesystem"; readonly path: string };
  /** Follow symlinks when reading a filesystem source (default true). */
  readonly followSymlinks?: boolean;
}

/** What a caller adds to a config: the parse, who hears the results, and what to do with a document that fails to parse. */
export interface PipesRunOptions {
  readonly ripstream?: PipesRipstream;
  readonly reporter?: Reporter;
  readonly onParseException?: OnParseException;
  /** UNPACK: what is emitted. See `PipesEngineOptions.unpack`; the shorthand config's default is REGULAR, the layout it always had. */
  readonly unpack?: UnpackSettings;
  /** UNPACK with `suffixStrategy: "DETECTED"`: the extension of a media type. See `PipesEngineOptions.extensionOf`. */
  readonly extensionOf?: ExtensionOf;
  /** The metadata filters of the run. See `PipesEngineOptions.metadataFilters`; they replace those of the settings. */
  readonly metadataFilters?: EmitMetadataFilters;
}

/** The id the shorthand config gives its one fetcher. */
const SOURCE_FETCHER = "source";

/**
 * Builds an engine from the shorthand config. It is one fetcher, one iterator and one emitter like any other, so the
 * shorthand has no code path of its own: `source` is the fetcher and the iterator that lists it, `sink` the emitter.
 */
export function createEngine(config: PipesConfig, options: PipesRunOptions = {}): PipesEngine {
  assertValidPipesConfig(config);
  const followSymlinks = config.followSymlinks ?? true;
  const http = config.source.type === "http";
  const fetcher: Fetcher = http
    ? new HttpFetcher()
    : new FileSystemFetcher({ basePath: config.source.path ?? ".", confineSymlinks: !followSymlinks });
  const iterator: PipesIterator = http
    ? new UrlListPipesIterator(config.source.urls ?? [], SOURCE_FETCHER)
    : new FileSystemPipesIterator({
        basePath: config.source.path ?? ".",
        fetcherId: SOURCE_FETCHER,
        symlinks: followSymlinks ? "follow" : "skip",
      });
  const emitter = config.sink === undefined ? new MemoryEmitter() : new FlatFileEmitter(config.sink.path);
  return new PipesEngine({
    iterator,
    fetchers: { [SOURCE_FETCHER]: fetcher },
    emitter,
    mode: config.mode ?? "CONTENT_ONLY",
    concurrency: config.concurrency ?? 4,
    maxQueue: config.maxQueue ?? 64,
    ordered: config.ordered ?? false,
    ...(options.ripstream === undefined ? {} : { ripstream: options.ripstream }),
    ...(options.reporter === undefined ? {} : { reporter: options.reporter }),
    ...(options.onParseException === undefined ? {} : { onParseException: options.onParseException }),
    // The shorthand's sink is flat, and a zip in it would be a `.bin` named after the key: it keeps the REGULAR layout.
    unpack: options.unpack ?? { outputFormat: "REGULAR" },
    ...(options.extensionOf === undefined ? {} : { extensionOf: options.extensionOf }),
    ...(options.metadataFilters === undefined ? {} : { metadataFilters: options.metadataFilters }),
  });
}

/** What a caller adds to Tika-shaped settings: where the tuples come from when the settings name no iterator, and the run options. */
export interface PipesSettingsRunOptions extends PipesRunOptions {
  /** Used instead of the settings' `pipes-iterator`, or when they have none: a service that takes its tuples from a request. */
  readonly iterator?: PipesIterator;
  /** Another try for a fetch or an emit that failed in a way that may not happen again. See `PipesEngineOptions.retry`. */
  readonly retry?: RetryOptions;
  /** The inputs an earlier run finished, to be left out, and where this run records its own. See `PipesEngineOptions.checkpoint`. */
  readonly checkpoint?: Checkpoint;
  /** Replaces the network, the clock or the credentials of the settings' S3 components (a test's fake S3). */
  readonly s3?: S3Transport;
  /** Replaces the network, or the ids drawn for embedded documents, of the settings' Elasticsearch and OpenSearch emitters. Their reporters take its network too. */
  readonly search?: SearchTransport;
  /** Replaces the network, the clock, the environment or the token of the settings' GCS components (a test's fake Cloud Storage, or an emulator's address). */
  readonly gcs?: GcsTransport;
  /** Replaces the network of the settings' Azure Blob components. */
  readonly azBlob?: AzBlobTransport;
  /** Replaces the network, or the ids drawn for embedded documents, of the settings' Solr components. */
  readonly solr?: SolrTransport;
  /** What the settings' metadata filters need that core has not (the language identifier of `charsoup-metadata-filter`). A filter whose service is missing is refused when the engine is built. */
  readonly metadataFilterServices?: MetadataFilterServices;
}

/** The ways a transport is given to a component that has one: not at all, when the run options have none. */
const withTransport = <T>(transport: T | undefined): { transport?: T } => (transport === undefined ? {} : { transport });

function iteratorFrom(settings: PipesIteratorSettings, options: PipesSettingsRunOptions): PipesIterator {
  switch (settings.type) {
    case "s3-pipes-iterator":
      return new S3PipesIterator({
        s3: settings.s3,
        fetcherId: settings.fetcherId,
        emitterId: settings.emitterId,
        ...(settings.prefix === undefined ? {} : { prefix: settings.prefix }),
        ...(settings.fileNamePattern === undefined ? {} : { fileNamePattern: settings.fileNamePattern }),
        ...withTransport(options.s3),
      });
    case "gcs-pipes-iterator":
      return new GcsPipesIterator({
        gcs: settings.gcs,
        fetcherId: settings.fetcherId,
        emitterId: settings.emitterId,
        ...(settings.prefix === undefined ? {} : { prefix: settings.prefix }),
        ...withTransport(options.gcs),
      });
    case "az-blob-pipes-iterator":
      return new AzBlobPipesIterator({
        azure: settings.azure,
        fetcherId: settings.fetcherId,
        emitterId: settings.emitterId,
        ...(settings.prefix === undefined ? {} : { prefix: settings.prefix }),
        ...(settings.timeoutMillis === undefined ? {} : { timeoutMillis: settings.timeoutMillis }),
        ...withTransport(options.azBlob),
      });
    case "solr-pipes-iterator":
      return new SolrPipesIterator({ settings, ...withTransport(options.solr) });
    case "file-system-pipes-iterator":
      return new FileSystemPipesIterator({ basePath: settings.basePath, fetcherId: settings.fetcherId, emitterId: settings.emitterId });
  }
}

function fetcherFrom(settings: PipesFetcherSettings, options: PipesSettingsRunOptions): Fetcher {
  switch (settings.type) {
    case "http-fetcher":
      return new HttpFetcher();
    case "s3-fetcher":
      return new S3Fetcher({
        s3: settings.s3,
        ...(settings.prefix === undefined ? {} : { prefix: settings.prefix }),
        ...(settings.maxLength === undefined ? {} : { maxLength: settings.maxLength }),
        ...withTransport(options.s3),
      });
    case "gcs-fetcher":
      return new GcsFetcher({ gcs: settings.gcs, ...withTransport(options.gcs) });
    case "az-blob-fetcher":
      return new AzBlobFetcher({ azure: settings.azure, ...withTransport(options.azBlob) });
    case "file-system-fetcher":
      return new FileSystemFetcher({
        ...(settings.basePath === undefined ? {} : { basePath: settings.basePath }),
        allowAbsolutePaths: settings.allowAbsolutePaths,
      });
  }
}

function emitterFrom(settings: PipesEmitterSettings, options: PipesSettingsRunOptions): Emitter {
  switch (settings.type) {
    case "s3-emitter":
      return new S3Emitter({
        s3: settings.s3,
        ...(settings.prefix === undefined ? {} : { prefix: settings.prefix }),
        ...(settings.fileExtension === undefined ? {} : { fileExtension: settings.fileExtension }),
        ...withTransport(options.s3),
      });
    case "es-emitter":
    case "opensearch-emitter":
      return new BulkSearchEmitter({ settings, ...withTransport(options.search) });
    case "gcs-emitter":
      return new GcsEmitter({
        gcs: settings.gcs,
        ...(settings.prefix === undefined ? {} : { prefix: settings.prefix }),
        ...(settings.fileExtension === undefined ? {} : { fileExtension: settings.fileExtension }),
        ...withTransport(options.gcs),
      });
    case "az-blob-emitter":
      return new AzBlobEmitter({
        azure: settings.azure,
        ...(settings.prefix === undefined ? {} : { prefix: settings.prefix }),
        ...(settings.fileExtension === undefined ? {} : { fileExtension: settings.fileExtension }),
        ...(settings.overwriteExisting === undefined ? {} : { overwriteExisting: settings.overwriteExisting }),
        ...withTransport(options.azBlob),
      });
    case "solr-emitter":
      return new SolrEmitter({ settings, ...withTransport(options.solr) });
    case "file-system-emitter":
      return new FileSystemEmitter({
        ...(settings.basePath === undefined ? {} : { basePath: settings.basePath }),
        allowAbsolutePaths: settings.allowAbsolutePaths,
        ...(settings.fileExtension === undefined ? {} : { fileExtension: settings.fileExtension }),
        onExists: settings.onExists,
        atomicWrites: settings.atomicWrites,
        compression: settings.compression,
        prettyPrint: settings.prettyPrint,
      });
  }
}

function reporterFrom(settings: PipesReporterSettings, options: PipesSettingsRunOptions): Reporter {
  switch (settings.type) {
    case "es-pipes-reporter":
    case "opensearch-pipes-reporter":
      return new SearchPipesReporter({ settings, ...withTransport(options.search) });
    case "file-system-jsonl-reporter":
      return new JsonlReporter(
        settings.path,
        {
          ...(settings.includes === undefined ? {} : { includes: settings.includes }),
          ...(settings.excludes === undefined ? {} : { excludes: settings.excludes }),
        },
        { onExists: settings.onExists, maxMessageLength: settings.maxMessageLength },
      );
  }
}

/**
 * Builds an engine from the pipes sections of a Tika configuration (`loadConfig(...).pipes`). Tika's defaults hold for
 * what the settings leave out: parseMode RMETA, onParseException EMIT. `concurrency` and `maxQueue` are the engine's when
 * the settings give none.
 */
export function createEngineFromSettings(settings: PipesSettings, options: PipesSettingsRunOptions = {}): PipesEngine {
  const iterator = options.iterator ?? (settings.iterator === undefined ? undefined : iteratorFrom(settings.iterator, options));
  if (iterator === undefined) {
    throw new RipstreamConfigError(["there is no pipes-iterator to take tuples from: configure one, or pass an iterator"]);
  }
  const fetchers: Record<string, Fetcher> = {};
  for (const fetcher of settings.fetchers) fetchers[fetcher.id] = fetcherFrom(fetcher, options);
  const emitters: Record<string, Emitter> = {};
  for (const emitter of settings.emitters) emitters[emitter.id] = emitterFrom(emitter, options);
  const reporters: Reporter[] = settings.reporters.map((reporter) => reporterFrom(reporter, options));
  if (options.reporter !== undefined) reporters.push(options.reporter);
  const onParseException = options.onParseException ?? settings.onParseException;
  // The run's own filters replace the configuration's; the configuration's are built here, once, for every input.
  const metadataFilters =
    options.metadataFilters ??
    (settings.metadataFilters === undefined && settings.parseContextMetadataFilters === undefined
      ? undefined
      : metadataFiltersOf(
          {
            metadataFilters: settings.metadataFilters ?? null,
            parseContextMetadataFilters: settings.parseContextMetadataFilters ?? null,
          },
          options.metadataFilterServices,
        ));
  return new PipesEngine({
    iterator,
    fetchers,
    emitters,
    mode: settings.parseMode ?? "RMETA",
    ...(settings.concurrency === undefined ? {} : { concurrency: settings.concurrency }),
    ...(settings.maxQueue === undefined ? {} : { maxQueue: settings.maxQueue }),
    ...(reporters.length === 0 ? {} : { reporter: reporters.length === 1 ? reporters[0]! : new CompositeReporter(reporters) }),
    ...(options.ripstream === undefined ? {} : { ripstream: options.ripstream }),
    ...(onParseException === undefined ? {} : { onParseException }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
    ...(options.unpack === undefined && settings.unpack === undefined ? {} : { unpack: options.unpack ?? settings.unpack }),
    ...(settings.digest === undefined ? {} : { digest: settings.digest }),
    ...(metadataFilters === undefined ? {} : { metadataFilters }),
    ...(options.extensionOf === undefined ? {} : { extensionOf: options.extensionOf }),
  });
}

/** Embedded API wrapper around the pipe engine. */
export class PipesClient {
  readonly #config: PipesConfig;
  readonly #options: PipesRunOptions;

  constructor(config: PipesConfig, options: PipesRunOptions = {}) {
    assertValidPipesConfig(config);
    this.#config = config;
    this.#options = options;
  }

  async run(): Promise<{ count: number; stats: PipesStats }> {
    const engine = createEngine(this.#config, this.#options);
    const count = await engine.run();
    return { count, stats: engine.stats };
  }
}

export { CheckpointStore, isTransientError, withRetry, type Checkpoint, type RetryOptions } from "./resilience.ts";
export { AsyncProcessor, DEFAULT_ASYNC_QUEUE_SIZE, OfferLargerThanQueueSize, type AsyncProcessorOptions } from "./async-processor.ts";
export { type ExtensionOf } from "./unpack.ts";
export { S3Emitter, S3Fetcher, S3PipesIterator, credentialsFor, s3ClientFor, type S3EmitterOptions, type S3FetcherOptions, type S3PipesIteratorOptions, type S3Transport } from "./s3/components.ts";
export { S3Client, S3Error, type S3ClientOptions } from "./s3/client.ts";
export { BulkSearchEmitter, type BulkSearchEmitterOptions, type SearchTransport } from "./search/bulk-emitter.ts";
export { SearchError } from "./search/bulk-client.ts";
export { SearchPipesReporter, type SearchPipesReporterOptions, type SearchReporterTransport } from "./search/reporter.ts";
export { GcsEmitter, GcsFetcher, GcsPipesIterator, gcsClientFor, type GcsEmitterOptions, type GcsFetcherOptions, type GcsPipesIteratorOptions, type GcsTransport } from "./gcs/components.ts";
export { GcsClient, GcsError, type GcsClientOptions, type GcsObject } from "./gcs/client.ts";
export { TokenError, applicationDefaultToken, metadataServerToken, parseServiceAccountKey, serviceAccountToken, type ServiceAccountKey, type TokenProvider } from "./gcs/credentials.ts";
export { AzBlobEmitter, AzBlobFetcher, AzBlobPipesIterator, azBlobClientFor, type AzBlobEmitterOptions, type AzBlobFetcherOptions, type AzBlobPipesIteratorOptions, type AzBlobTransport } from "./azblob/components.ts";
export { AzBlobClient, AzBlobError, type AzBlobClientOptions, type AzBlobObject } from "./azblob/client.ts";
export { SolrEmitter, SolrPipesIterator, solrClientFor, type SolrEmitterOptions, type SolrPipesIteratorOptions, type SolrTransport } from "./solr/components.ts";
export { SolrClient, SolrError, type SolrClientOptions, type SolrSelectPage } from "./solr/client.ts";
export { instanceCredentials, profileCredentials, staticCredentials, type CredentialProvider } from "./s3/credentials.ts";
export { signV4, type AwsCredentials } from "./s3/sigv4.ts";
export { buildUnpackPackage, packageName, zipChunks, type PackageFile, type UnpackInput, type UnpackPackage } from "./frictionless.ts";
export { CompositeEmitter, CompositeReporter, CsvSource, HttpEmitter, JsonSource, JsonlEmitter, JsonlReporter, LoggingReporter, ModuleEmitter, ModuleFetcher, StdoutEmitter, type JsonlReporterOptions, type StatusFilter } from "./adapters.ts";
