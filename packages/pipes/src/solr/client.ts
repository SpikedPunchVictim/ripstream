import type { SolrConnectionSettings } from "@spikedpunch/ripstream-core";

/*
 * The two Solr calls pipes makes, over HTTP with `fetch`: the JSON update handler (`/<collection>/update`) and `/select`.
 * Tika uses SolrJ, which sends an update as javabin; Solr's own JSON update format carries the same documents. A request
 * goes to the first of `urls` that can be connected to, with the basic credentials of the connection when it has them.
 */

/** What Solr, or the way to it, answered when it was not a success. `status` is the HTTP status; `code` an errno the retry logic knows. */
export class SolrError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, details: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, details.cause === undefined ? {} : { cause: details.cause });
    this.name = "SolrError";
    this.status = details.status;
    this.code = details.code;
  }
}

/** One page of a `/select` answer: the documents, and the cursor to ask for the next page with. */
export interface SolrSelectPage {
  readonly docs: ReadonlyArray<Record<string, unknown>>;
  readonly nextCursorMark: string | undefined;
}

export interface SolrClientOptions {
  /** Replaces the network (a test's fake). Default the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const MESSAGE_LIMIT = 1000;
const clipped = (value: string): string => (value.length > MESSAGE_LIMIT ? `${value.slice(0, MESSAGE_LIMIT)}... (${value.length - MESSAGE_LIMIT} more characters)` : value);

/** The errno that says no connection was made: a request that failed with one of these was not seen by Solr, so the next URL may take it. */
const NOT_CONNECTED: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "UND_ERR_CONNECT_TIMEOUT"]);

function notConnected(error: unknown): boolean {
  const { code } = ((error as { cause?: unknown } | null)?.cause ?? {}) as { code?: unknown };
  return typeof code === "string" && NOT_CONNECTED.has(code);
}

/** The `error.msg` of a Solr error body, or the start of the body when it has none. */
function errorDetail(text: string): string {
  try {
    const msg = ((JSON.parse(text) as { error?: { msg?: unknown } } | null)?.error ?? {}).msg;
    if (typeof msg === "string") return msg;
  } catch {
    // not JSON: the text itself is the detail
  }
  return clipped(text.trim());
}

export class SolrClient {
  readonly #connection: SolrConnectionSettings;
  readonly #fetch: typeof fetch;
  readonly #authorization: string | undefined;

  constructor(connection: SolrConnectionSettings, options: SolrClientOptions = {}) {
    this.#connection = connection;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#authorization = connection.userName === undefined ? undefined : `Basic ${Buffer.from(`${connection.userName}:${connection.password ?? ""}`, "utf8").toString("base64")}`;
  }

  /** One request to one URL, read to its end within the time a request may take. */
  async #attempt(what: string, url: string, init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{ status: number; text: string }> {
    const { socketTimeoutMillis } = this.#connection;
    const timeout = AbortSignal.timeout(socketTimeoutMillis);
    try {
      const response = await this.#fetch(url, {
        method: init.method,
        headers: { accept: "application/json", ...(this.#authorization === undefined ? {} : { authorization: this.#authorization }), ...init.headers },
        // The credentials go to the URLs the operator set and to no other: a redirect is an error to fix in the settings.
        redirect: "error",
        signal: init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout]),
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      if (timeout.aborted && init.signal?.aborted !== true) throw new SolrError(`Solr ${what} timed out after ${socketTimeoutMillis} ms`, { code: "ETIMEDOUT", cause: error });
      throw error;
    }
  }

  async #request(what: "update" | "select", query: ReadonlyArray<readonly [string, string]>, init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const { urls, collection } = this.#connection;
    const pairs: Array<readonly [string, string]> = [...query, ["wt", "json"]];
    const queryString = pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
    let unreachable: unknown;
    for (const base of urls) {
      let answer: { status: number; text: string };
      try {
        answer = await this.#attempt(what, `${base}/${encodeURIComponent(collection)}/${what}?${queryString}`, init);
      } catch (error) {
        if (!notConnected(error)) throw error;
        unreachable = error;
        continue;
      }
      return this.#parse(what, answer);
    }
    // undici's "fetch failed" has the errno's message ("connect ECONNREFUSED ...") as its cause.
    const failure = unreachable as Error | undefined;
    const reason = failure?.cause instanceof Error ? failure.cause.message : (failure?.message ?? "there is no URL");
    throw new SolrError(`Solr ${what} could not connect to ${urls.join(", ")}: ${reason}`, { cause: unreachable });
  }

  #parse(what: string, answer: { status: number; text: string }): Record<string, unknown> {
    if (answer.status < 200 || answer.status > 299) {
      const detail = errorDetail(answer.text);
      throw new SolrError(`Solr ${what} ${answer.status}${detail === "" ? "" : `: ${detail}`}`, { status: answer.status });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.text);
    } catch {
      throw new SolrError(`Solr ${what} answered ${answer.status} with a body that is not JSON: ${clipped(answer.text)}`);
    }
    const header = (parsed as { responseHeader?: { status?: unknown } } | null)?.responseHeader;
    // The status of the response header is Solr's own; SolrJ's caller, Tika's emitter, refuses what is not 0.
    if (header?.status !== 0) throw new SolrError(`Solr ${what}: Bad status: ${clipped(answer.text)}`);
    return parsed as Record<string, unknown>;
  }

  /** Adds the documents, as one request, to be committed within `commitWithin` ms. A version conflict is not an error (`failOnVersionConflicts=false`). */
  async update(docs: ReadonlyArray<Record<string, unknown>>, options: { commitWithin: number; signal?: AbortSignal }): Promise<void> {
    await this.#request(
      "update",
      [
        ["commitWithin", String(options.commitWithin)],
        ["failOnVersionConflicts", "false"],
      ],
      { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(docs), ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );
  }

  /** `/select` with the parameters as they are. */
  async select(params: ReadonlyArray<readonly [string, string]>, options: { signal?: AbortSignal } = {}): Promise<SolrSelectPage> {
    const parsed = await this.#request("select", params, { method: "GET", ...(options.signal === undefined ? {} : { signal: options.signal }) });
    const docs = (parsed.response as { docs?: unknown } | undefined)?.docs;
    if (!Array.isArray(docs)) throw new SolrError("Solr select answered with no response.docs");
    const cursor = parsed.nextCursorMark;
    return { docs: docs as Array<Record<string, unknown>>, nextCursorMark: typeof cursor === "string" ? cursor : undefined };
  }
}
