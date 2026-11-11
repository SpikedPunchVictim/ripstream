import type { SearchReporterSettings } from "@spikedpunch/ripstream-core";
import type { Reporter } from "../index.ts";
import { assertValidFilter, wants, type StatusFilter } from "../adapters.ts";
import type { PipesResult } from "../result.ts";
import type { FetchEmitTuple } from "../tuple.ts";
import { bulkAuthorization, postBulk } from "./bulk-client.ts";

/*
 * Tika's es-pipes-reporter and opensearch-pipes-reporter (tika-pipes-es ESPipesReporter and tika-pipes-opensearch
 * OpenSearchPipesReporter 4.2.0): each result a run reports is upserted into an index as one document, found by the
 * emit key of its input, that says how the input ended. Both POST to `<index url>/_bulk` over plain HTTP; these do the
 * same with `fetch`, so ripstream has no client library of either to carry.
 */

/** The seam a test replaces: the network. */
export interface SearchReporterTransport {
  readonly fetchImpl?: typeof fetch;
}

export interface SearchPipesReporterOptions {
  readonly settings: SearchReporterSettings;
  readonly transport?: SearchReporterTransport;
}

/**
 * Writes `<keyPrefix>parse_status` (the status's name) and `<keyPrefix>parse_time_ms` (the milliseconds the input took, as
 * a string) of each result the filter lets through, as `{"update": {"_id", "routing"?, "retry_on_conflict": 3}}` and
 * `{"doc": {...}, "doc_as_upsert": true}`. Tika also writes `exit_value`, the exit value of an external process that the
 * result's metadata carries; a ripstream result carries no metadata, so there is none. Where Tika logs a report that
 * failed and goes on, this throws, and the engine ends the run: the operator's record of the run must not go missing quietly.
 */
export class SearchPipesReporter implements Reporter {
  readonly #settings: SearchReporterSettings;
  readonly #filter: StatusFilter;
  readonly #fetch: typeof fetch;
  readonly #authorization: string | undefined;

  constructor(options: SearchPipesReporterOptions) {
    const { settings, transport } = options;
    const filter: StatusFilter = {
      ...(settings.includes === undefined ? {} : { includes: settings.includes }),
      ...(settings.excludes === undefined ? {} : { excludes: settings.excludes }),
    };
    assertValidFilter(filter);
    this.#settings = settings;
    this.#filter = filter;
    this.#fetch = transport?.fetchImpl ?? fetch;
    this.#authorization = bulkAuthorization(settings);
  }

  async report(result: PipesResult, tuple?: FetchEmitTuple): Promise<void> {
    if (!wants(this.#filter, result)) return;
    const { type, url, keyPrefix, includeRouting, socketTimeoutMillis } = this.#settings;
    if (tuple === undefined) throw new Error(`${type} needs the tuple of the input: its emit key is the id of the document it writes`);
    const id = tuple.emitKey ?? tuple.id;
    const action = { _id: id, ...(includeRouting && id !== "" ? { routing: id } : {}), retry_on_conflict: 3 };
    const doc = { [`${keyPrefix}parse_status`]: result.status, [`${keyPrefix}parse_time_ms`]: String(Math.round(result.elapsedMs)) };
    const body = `${JSON.stringify({ update: action })}\n${JSON.stringify({ doc, doc_as_upsert: true })}\n`;
    await postBulk({ fetchImpl: this.#fetch, label: type, url, authorization: this.#authorization, socketTimeoutMillis, body });
  }
}
