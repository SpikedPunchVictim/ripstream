/*
 * The one request that Tika's Elasticsearch and OpenSearch emitters and reporters (tika-pipes-es and tika-pipes-opensearch
 * 4.2.0) make: POST newline-delimited JSON to `<index url>/_bulk`, with an API key or basic credentials, and read the
 * answer's status and its `errors` flag. Each of them does it in a copy of its own in Tika; here it is written once.
 */

/** What `_bulk` answered when it was not a success: the HTTP status, so that a rejected request (429, 5xx) is retried. */
export class SearchError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SearchError";
    this.status = status;
  }
}

/** The longest stretch of an error response that goes into a message. */
const MESSAGE_LIMIT = 1000;

const clipped = (value: string): string => (value.length > MESSAGE_LIMIT ? `${value.slice(0, MESSAGE_LIMIT)}… (${value.length - MESSAGE_LIMIT} more characters)` : value);

export interface BulkCredentials {
  readonly apiKey?: string;
  readonly userName?: string;
  readonly password?: string;
}

/** The `Authorization` header: an API key wins over a user name, as in Tika. Neither: no header. */
export function bulkAuthorization(credentials: BulkCredentials): string | undefined {
  if (credentials.apiKey !== undefined) return `ApiKey ${credentials.apiKey}`;
  if (credentials.userName !== undefined) return `Basic ${Buffer.from(`${credentials.userName}:${credentials.password ?? ""}`, "utf8").toString("base64")}`;
  return undefined;
}

export interface BulkRequest {
  readonly fetchImpl: typeof fetch;
  /** Names the component in an error: its type, such as `es-emitter`. */
  readonly label: string;
  /** The index's URL, without a trailing slash: `/_bulk` is added to it. */
  readonly url: string;
  readonly authorization: string | undefined;
  /** The time the request may take. Undefined: no limit. */
  readonly socketTimeoutMillis: number | undefined;
  /** Newline-delimited JSON, ending in a newline. */
  readonly body: string;
}

/** Sends the request. Throws a `SearchError` for a status other than 200, an answer that is not JSON, and `errors: true`. */
export async function postBulk(request: BulkRequest): Promise<void> {
  const { label, authorization, socketTimeoutMillis } = request;
  const response = await request.fetchImpl(`${request.url}/_bulk`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json; charset=utf-8",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: request.body,
    // The credentials go to the URL the operator set and to no other: a redirect is an error to fix in the settings.
    redirect: "error",
    ...(socketTimeoutMillis === undefined ? {} : { signal: AbortSignal.timeout(socketTimeoutMillis) }),
  });
  const answer = await response.text();
  if (response.status !== 200) throw new SearchError(`${label} _bulk ${response.status}: ${clipped(answer)}`, response.status);
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    throw new SearchError(`${label} _bulk answered 200 with a body that is not JSON: ${clipped(answer)}`);
  }
  // `errors` is what the service sets when any one entry failed; the request as a whole is then 200. Nothing here retries it:
  // the entries that did succeed would be indexed again, and an embedded document's id is drawn anew each time.
  if (typeof parsed === "object" && parsed !== null && (parsed as { errors?: unknown }).errors === true) {
    throw new SearchError(`${label} _bulk reported errors: ${clipped(answer)}`);
  }
}
