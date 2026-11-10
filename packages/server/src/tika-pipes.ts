import { SYSTEM_COMPONENT_PREFIX, type PipesSettings } from "@spikedpunch/ripstream-core";
import {
  AsyncProcessor,
  OfferLargerThanQueueSize,
  createEngineFromSettings,
  httpResponseFor,
  parseFetchEmitTuple,
  type ExtensionOf,
  type FetchEmitTuple,
  type PipesResult,
  type PipesRipstream,
} from "@spikedpunch/ripstream-pipes";
import { HttpError } from "./http-error.ts";

/*
 * Tika's /pipes and /async (tikajs-68os.6.5, tika-server PipesResource and AsyncResource). Both take Tika's FetchEmitTuple
 * and run it against the fetchers and emitters the operator configured, so a request names components, never paths.
 */

/** Tika's `maxQueuePauseMillis` is 60 000; a request held that long would meet the server's own request timeout. */
export const DEFAULT_ASYNC_MAX_WAIT_MS = 5_000;

/** Tika's PipesConfig.DEFAULT_MAX_WAIT_FOR_CLIENT_MILLIS, in seconds: the Retry-After of a 429 from /pipes. */
const MAX_WAIT_FOR_CLIENT_SECONDS = 60;

export interface TikaPipesOptions {
  readonly settings: PipesSettings;
  /** Parses every tuple: the server's ripstream, isolated and under its ceilings. */
  readonly ripstream: PipesRipstream;
  /** The extension of a media type, for UNPACK with `suffixStrategy: DETECTED`. See `PipesEngineOptions.extensionOf`. */
  readonly extensionOf?: ExtensionOf;
  /** How long an /async offer waits for room in the queue before it is answered 429. Default 5 000. */
  readonly asyncMaxWaitMs?: number;
}

/** What a route sends: Tika's HTTP status, the Retry-After that goes with it (seconds), and the JSON body. */
export interface TikaPipesAnswer {
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly body: Readonly<Record<string, unknown>>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Tika's PipesParsingHelper.rejectReservedComponentIds: a request may not name the components the server keeps for itself. */
function rejectReservedIds(tuple: FetchEmitTuple): void {
  for (const [id, kind] of [
    [tuple.fetcher, "fetcher"],
    [tuple.emitter, "emitter"],
  ] as const) {
    if (id !== undefined && id.startsWith(SYSTEM_COMPONENT_PREFIX)) {
      throw new HttpError(400, `'${id}' is reserved for the server's internal use and may not be named as a ${kind} by a request`);
    }
  }
}

export class TikaPipes {
  readonly #settings: PipesSettings;
  readonly #ripstream: PipesRipstream;
  readonly #extensionOf: ExtensionOf | undefined;
  readonly #asyncMaxWaitMs: number;
  readonly #fetcherIds: ReadonlySet<string>;
  readonly #emitterIds: ReadonlySet<string>;
  #processor: AsyncProcessor | undefined;

  constructor(options: TikaPipesOptions) {
    this.#settings = options.settings;
    this.#ripstream = options.ripstream;
    this.#extensionOf = options.extensionOf;
    this.#asyncMaxWaitMs = options.asyncMaxWaitMs ?? DEFAULT_ASYNC_MAX_WAIT_MS;
    this.#fetcherIds = new Set(options.settings.fetchers.map((fetcher) => fetcher.id));
    this.#emitterIds = new Set(options.settings.emitters.map((emitter) => emitter.id));
  }

  /**
   * POST /pipes: one tuple, parsed and emitted before the answer. The answer is `{status, message?}` with the HTTP status
   * Tika gives that result (a parse exception that was recorded is still 200). The settings' reporters are not run: the
   * answer is the report, and a reporter that appends to a file would fail the second request.
   */
  async pipes(body: unknown): Promise<TikaPipesAnswer> {
    const { issues, tuple } = parseFetchEmitTuple(body);
    if (tuple === undefined) throw new HttpError(400, `Could not parse the /pipes request body: ${issues.join("; ")}`);
    rejectReservedIds(tuple);
    const results: PipesResult[] = [];
    const engine = createEngineFromSettings(
      { ...this.#settings, reporters: [] },
      {
        iterator: (async function* () {
          yield tuple;
        })(),
        ripstream: this.#ripstream,
        ...(this.#extensionOf === undefined ? {} : { extensionOf: this.#extensionOf }),
        reporter: { report: (result) => void results.push(result) },
      },
    );
    await engine.run();
    // One tuple is one result, in every parse mode.
    const outcome = results[0];
    if (outcome === undefined) throw new Error(`the /pipes run gave no result for tuple ${JSON.stringify(tuple.id)}`);
    const http = httpResponseFor(outcome.status, MAX_WAIT_FOR_CLIENT_SECONDS);
    return {
      status: http.status,
      ...(http.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: http.retryAfterSeconds }),
      // `pipesResult` leaves out an empty message, as Tika leaves out a blank one.
      body: { status: outcome.status, ...(outcome.message === undefined ? {} : { message: outcome.message }) },
    };
  }

  /**
   * POST /async: `{"tuples": [...]}`, queued for the background run. Every tuple is checked against the configured
   * fetchers and emitters before any is queued (Tika's "can't find fetcher for X"), so a batch is taken whole or refused.
   * 200 `{status: "ok", added}`; 429 `{status: "throttled", message, capacity}` with a Retry-After when the queue stayed full;
   * 400 for a body that cannot be taken or a batch that could never fit. What became of each tuple is in the settings'
   * reporters and emitters, not in the answer.
   */
  async enqueue(body: unknown): Promise<TikaPipesAnswer> {
    const tuples = this.#parseAsyncBody(body);
    const processor = (this.#processor ??= new AsyncProcessor(this.#settings, {
        ripstream: this.#ripstream,
        ...(this.#extensionOf === undefined ? {} : { extensionOf: this.#extensionOf }),
      }));
    let offered: boolean;
    try {
      offered = await processor.offer(tuples, this.#asyncMaxWaitMs);
    } catch (error) {
      if (error instanceof OfferLargerThanQueueSize) throw new HttpError(400, error.message);
      throw error;
    }
    if (offered) return { status: 200, body: { status: "ok", added: tuples.length } };
    return {
      status: 429,
      retryAfterSeconds: httpResponseFor("CLIENT_UNAVAILABLE_WITHIN_MS", this.#asyncMaxWaitMs / 1000).retryAfterSeconds ?? 1,
      body: {
        status: "throttled",
        message: `not able to receive request of size ${tuples.length} at this time`,
        capacity: processor.capacity,
      },
    };
  }

  /** Stops taking tuples and waits for the ones already taken: each was answered 200, so each is owed its result. */
  async close(): Promise<void> {
    await this.#processor?.close();
  }

  #parseAsyncBody(body: unknown): FetchEmitTuple[] {
    if (!isObject(body)) throw new HttpError(400, "Could not parse the /async request body: it must be a JSON object with a `tuples` array");
    for (const key of Object.keys(body)) {
      if (key !== "tuples") throw new HttpError(400, `Could not parse the /async request body: ${key} is not a field of it (it has tuples)`);
    }
    const listed = body.tuples;
    if (!Array.isArray(listed)) throw new HttpError(400, "Could not parse the /async request body: tuples must be an array");
    return listed.map((entry, index) => {
      const { issues, tuple } = parseFetchEmitTuple(entry);
      if (tuple === undefined) throw new HttpError(400, `Could not parse the /async request body: tuples[${index}]: ${issues.join("; ")}`);
      rejectReservedIds(tuple);
      if (!this.#fetcherIds.has(tuple.fetcher)) throw new HttpError(400, `can't find fetcher for ${tuple.fetcher}`);
      if (tuple.emitter !== undefined) {
        if (!this.#emitterIds.has(tuple.emitter)) throw new HttpError(400, `can't find emitter for ${tuple.emitter}`);
      } else if (this.#emitterIds.size !== 1) {
        // The engine's default emitter is the only one there is; with none or several, nobody would be told where the result went.
        throw new HttpError(400, `tuples[${index}] names no emitter, and ${this.#emitterIds.size} are configured: name one`);
      }
      return tuple;
    });
  }
}
