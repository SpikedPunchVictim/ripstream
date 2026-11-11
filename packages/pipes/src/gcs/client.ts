import type { TokenProvider } from "./credentials.ts";

/*
 * The three Cloud Storage calls pipes makes, over the JSON API: objects.get (`alt=media`), objects.insert (a simple
 * `uploadType=media` upload) and objects.list (`pageToken`). A request carries the bearer token of the provider and is
 * sent with `fetch`, to `storage.googleapis.com` or to `endpoint` (a storage emulator such as fake-gcs-server).
 */

export interface GcsClientOptions {
  readonly bucket: string;
  readonly token: TokenProvider;
  /** Where the API is. Default `https://storage.googleapis.com`. */
  readonly endpoint?: string;
  /** Replaces the network (a test's fake). Default the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** What Cloud Storage answered when it was not a success: the HTTP status and the `reason` of the error body (`notFound`, `forbidden`). */
export class GcsError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.name = "GcsError";
    this.status = status;
    this.reason = reason;
  }
}

/** An object the bucket lists: its name and its size in bytes. */
export interface GcsObject {
  readonly name: string;
  readonly size: number;
}

const MESSAGE_LIMIT = 500;
const clipped = (value: string): string => (value.length > MESSAGE_LIMIT ? `${value.slice(0, MESSAGE_LIMIT)}...` : value);

/** The `reason` and `message` of the JSON error body Google's APIs answer with, when the body is one. */
function errorDetail(text: string): { reason?: string; message?: string } {
  try {
    const error = (JSON.parse(text) as { error?: { message?: unknown; errors?: Array<{ reason?: unknown }> } }).error;
    const reason = error?.errors?.[0]?.reason;
    return {
      ...(typeof reason === "string" ? { reason } : {}),
      ...(typeof error?.message === "string" ? { message: error.message } : {}),
    };
  } catch {
    return {};
  }
}

export class GcsClient {
  readonly #options: GcsClientOptions;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(options: GcsClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#base = (options.endpoint ?? "https://storage.googleapis.com").replace(/\/$/, "");
  }

  async #send(method: "GET" | "POST", url: string, init: { headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal } = {}): Promise<Response> {
    const token = await this.#options.token();
    // A redirect would carry the token to another host: a redirect is an error to fix in the settings.
    const response = await this.#fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      redirect: "error",
      // The bytes are sent as they are; the cast is the lib's `Uint8Array<ArrayBuffer>` where ours may be over a SharedArrayBuffer.
      ...(init.body === undefined ? {} : { body: init.body as Uint8Array<ArrayBuffer> }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
    if (response.ok) return response;
    const text = await response.text().catch(() => "");
    const { reason, message } = errorDetail(text);
    throw new GcsError(response.status, reason, `GCS ${method} ${response.status}${reason === undefined ? "" : ` ${reason}`}${message === undefined ? (text === "" ? "" : `: ${clipped(text)}`) : `: ${message}`}`);
  }

  get #objects(): string {
    return `${this.#base}/storage/v1/b/${encodeURIComponent(this.#options.bucket)}/o`;
  }

  /** The object's bytes. */
  async get(name: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const response = await this.#send("GET", `${this.#objects}/${encodeURIComponent(name)}?alt=media`, options.signal === undefined ? {} : { signal: options.signal });
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(name: string, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<void> {
    const url = `${this.#base}/upload/storage/v1/b/${encodeURIComponent(this.#options.bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`;
    const response = await this.#send("POST", url, { headers: { "content-type": "application/octet-stream" }, body: bytes, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    await response.body?.cancel();
  }

  /** Every object under `prefix`, page by page (`pageToken`), in the order Cloud Storage lists them. */
  async *list(prefix: string | undefined, options: { signal?: AbortSignal } = {}): AsyncGenerator<GcsObject> {
    let pageToken: string | undefined;
    do {
      const query = [`fields=${encodeURIComponent("items(name,size),nextPageToken")}`];
      if (prefix !== undefined && prefix !== "") query.push(`prefix=${encodeURIComponent(prefix)}`);
      if (pageToken !== undefined) query.push(`pageToken=${encodeURIComponent(pageToken)}`);
      const response = await this.#send("GET", `${this.#objects}?${query.join("&")}`, options.signal === undefined ? {} : { signal: options.signal });
      const page = (await response.json()) as { items?: Array<{ name?: unknown; size?: unknown }>; nextPageToken?: unknown };
      for (const item of page.items ?? []) {
        if (typeof item.name !== "string") throw new Error("GCS list gave an object with no name");
        yield { name: item.name, size: Number(item.size ?? 0) };
      }
      pageToken = typeof page.nextPageToken === "string" && page.nextPageToken !== "" ? page.nextPageToken : undefined;
    } while (pageToken !== undefined);
  }
}
