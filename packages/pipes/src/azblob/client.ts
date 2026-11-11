import { firstTag, xmlText } from "../s3/client.ts";
import type { AzBlobConnectionSettings } from "@spikedpunch/ripstream-core";

/*
 * The three Blob service calls pipes makes, over the REST API: Get Blob, Put Blob (a single block blob) and List Blobs
 * (flat, with `marker`). A request carries the SAS token as the tail of its query and is sent with `fetch`, to the
 * account's endpoint, which for an emulator such as Azurite has the account name in its path.
 */

// The service version the requests ask for. A SAS token is not tied to it.
const API_VERSION = "2021-08-06";

/** What the Blob service answered when it was not a success: the HTTP status and its error code (`BlobNotFound`, `AuthenticationFailed`). */
export class AzBlobError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "AzBlobError";
    this.status = status;
    this.code = code;
  }
}

/** A blob the container lists: its name and its size in bytes. */
export interface AzBlobObject {
  readonly name: string;
  readonly size: number;
}

export interface AzBlobClientOptions {
  /** Replaces the network (a test's fake). Default the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const MESSAGE_LIMIT = 300;
const clipped = (value: string): string => (value.length > MESSAGE_LIMIT ? `${value.slice(0, MESSAGE_LIMIT)}...` : value);

/** The blob's path below the container: each segment encoded, the slashes kept. */
function blobPath(name: string): string {
  if (name === "") throw new Error("blob name is empty");
  const segments = name.split("/");
  // fetch resolves these before it sends the request, so the blob a name means could not be the blob that is asked for.
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`blob name ${JSON.stringify(name)} has a "." or ".." segment, which a URL cannot carry (fetch resolves it before sending)`);
  }
  return segments.map(encodeURIComponent).join("/");
}

/** Runs `work` with a signal that ends at `timeoutMs` as well as with the caller's, and says so when it was the timeout. */
async function withTimeout<T>(method: string, timeoutMs: number | undefined, signal: AbortSignal | undefined, work: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  if (timeoutMs === undefined) return work(signal);
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await work(signal === undefined ? timeout : AbortSignal.any([signal, timeout]));
  } catch (error) {
    if (timeout.aborted && signal?.aborted !== true) throw new Error(`Azure Blob ${method} timed out after ${timeoutMs} ms`, { cause: error });
    throw error;
  }
}

/** One page of List Blobs: the blobs of it, and the marker of the next page when there is one. */
function parseListPage(xml: string): { blobs: AzBlobObject[]; nextMarker: string | undefined } {
  const blobs: AzBlobObject[] = [];
  for (const match of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
    const entry = match[1] ?? "";
    const name = /<Name([^>]*)>([^<]*)<\/Name>/.exec(entry);
    if (name === null) throw new Error("Azure Blob list gave a blob with no Name");
    const attributes = (name[1] ?? "").trim();
    // The service sends a name base64 encoded when it has a character XML cannot carry.
    if (attributes !== "" && attributes !== 'Encoding="base64"') throw new Error(`Azure Blob list gave a Name with an encoding ripstream does not read: ${attributes}`);
    const raw = name[2] ?? "";
    const length = firstTag(entry, "Content-Length");
    if (length === undefined) throw new Error(`Azure Blob list gave the blob ${JSON.stringify(raw)} with no Content-Length`);
    blobs.push({ name: attributes === "" ? xmlText(raw) : Buffer.from(raw, "base64").toString("utf8"), size: Number(length) });
  }
  const marker = firstTag(xml, "NextMarker");
  return { blobs, nextMarker: marker === undefined || marker === "" ? undefined : xmlText(marker) };
}

export class AzBlobClient {
  readonly #fetch: typeof fetch;
  readonly #container: string;
  readonly #base: string;
  readonly #sas: string;

  constructor(settings: AzBlobConnectionSettings, options: AzBlobClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#container = settings.container;
    this.#base = settings.endpoint.replace(/\/+$/, "");
    // The portal gives a token with a leading `?`.
    this.#sas = settings.sasToken.replace(/^\?/, "");
  }

  get #containerUrl(): string {
    return `${this.#base}/${encodeURIComponent(this.#container)}`;
  }

  async #send(method: "GET" | "PUT", url: string, init: { headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal } = {}): Promise<Response> {
    // A redirect would carry the token to another host: a redirect is an error to fix in the settings.
    const response = await this.#fetch(url, {
      method,
      headers: { "x-ms-version": API_VERSION, ...init.headers },
      redirect: "error",
      // The bytes are sent as they are; the cast is the lib's `Uint8Array<ArrayBuffer>` where ours may be over a SharedArrayBuffer.
      ...(init.body === undefined ? {} : { body: init.body as Uint8Array<ArrayBuffer> }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
    if (response.ok) return response;
    const text = await response.text().catch(() => "");
    const code = response.headers.get("x-ms-error-code") ?? firstTag(text, "Code") ?? undefined;
    const detail = firstTag(text, "Message");
    // The service's message goes on with RequestId and Time lines; the first line is the reason.
    const message = detail === undefined ? clipped(text.trim()) : (xmlText(detail).split("\n")[0] ?? "").trim();
    // The URL is left out of the message: it ends with the token.
    throw new AzBlobError(response.status, code, `Azure Blob ${method} ${response.status}${code === undefined ? "" : ` ${code}`}${message === "" ? "" : `: ${message}`}`);
  }

  /** The blob's bytes. */
  async get(name: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const response = await this.#send("GET", `${this.#containerUrl}/${blobPath(name)}?${this.#sas}`, options.signal === undefined ? {} : { signal: options.signal });
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Writes the blob as one block blob. Without `overwrite` (which is the default) an existing blob is a 409
   * BlobAlreadyExists, as the Azure SDK's `upload(stream, length, false)` does with `If-None-Match: *`.
   */
  async put(name: string, bytes: Uint8Array, options: { overwrite?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const headers: Record<string, string> = { "x-ms-blob-type": "BlockBlob", "content-type": "application/octet-stream" };
    if (options.overwrite === false) headers["if-none-match"] = "*";
    const response = await this.#send("PUT", `${this.#containerUrl}/${blobPath(name)}?${this.#sas}`, { headers, body: bytes, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    await response.body?.cancel();
  }

  /** Every blob under `prefix`, page by page (`marker`), in the order the service lists them. `timeoutMs` is for each page. */
  async *list(prefix: string | undefined, options: { signal?: AbortSignal; timeoutMs?: number } = {}): AsyncGenerator<AzBlobObject> {
    let marker: string | undefined;
    do {
      const query = ["restype=container", "comp=list"];
      if (prefix !== undefined && prefix !== "") query.push(`prefix=${encodeURIComponent(prefix)}`);
      if (marker !== undefined) query.push(`marker=${encodeURIComponent(marker)}`);
      const url = `${this.#containerUrl}?${query.join("&")}&${this.#sas}`;
      const page = await withTimeout("GET", options.timeoutMs, options.signal, async (signal) => {
        const response = await this.#send("GET", url, signal === undefined ? {} : { signal });
        return parseListPage(await response.text());
      });
      yield* page.blobs;
      marker = page.nextMarker;
    } while (marker !== undefined);
  }
}
