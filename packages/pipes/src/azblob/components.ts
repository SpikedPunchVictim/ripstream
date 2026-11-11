import type { AzBlobConnectionSettings } from "@spikedpunch/ripstream-core";
import type { EmittedDocument, Emitter } from "../index.ts";
import { documentJson, documentObjects } from "../file-system-emitter.ts";
import type { FetchContext, FetchEmitTuple, Fetcher, PipesIterator } from "../tuple.ts";
import { AzBlobClient } from "./client.ts";

/*
 * Tika's az-blob-fetcher, az-blob-emitter and az-blob-pipes-iterator (tika-pipes-az-blob 4.2.0), over `AzBlobClient`. Tika
 * uses the Azure Storage Blob client library; these send the same requests to the REST API with `fetch`, so ripstream has
 * no Azure dependency. Like Tika's, they authorise with a SAS token.
 */

/** The seam a test replaces: the network. */
export interface AzBlobTransport {
  readonly fetchImpl?: typeof fetch;
}

export function azBlobClientFor(settings: AzBlobConnectionSettings, transport: AzBlobTransport = {}): AzBlobClient {
  return new AzBlobClient(settings, transport.fetchImpl === undefined ? {} : { fetchImpl: transport.fetchImpl });
}

export interface AzBlobFetcherOptions {
  readonly azure: AzBlobConnectionSettings;
  readonly transport?: AzBlobTransport;
}

/** Tika's AZBlobFetcher with its endpoint, SAS token and container set: the blob of the container that the fetch key names, as it is. */
export class AzBlobFetcher implements Fetcher {
  readonly #client: AzBlobClient;

  constructor(options: AzBlobFetcherOptions) {
    this.#client = azBlobClientFor(options.azure, options.transport);
  }

  fetch(key: string, context: FetchContext): Promise<Uint8Array> {
    return this.#client.get(key, { signal: context.signal });
  }
}

export interface AzBlobEmitterOptions {
  readonly azure: AzBlobConnectionSettings;
  /** Put before every key with a `/`. */
  readonly prefix?: string;
  /** Added to every key after a dot, bytes included: Tika's `emit(path, InputStream)` does the same as its metadata emit. */
  readonly fileExtension?: string;
  /** Replace a blob that is there. Tika's default is false, which makes writing over one an error. */
  readonly overwriteExisting?: boolean;
  readonly transport?: AzBlobTransport;
}

/**
 * Tika's AZBlobEmitter: `prefix/emitKey.fileExtension`. A metadata document is the JSON list (compact, as Tika's
 * `JsonMetadataList.toJson`), CONTENT_ONLY the content, and embedded bytes the bytes. Tika puts the extension on all of
 * them, so an unpacked file is `<emitKey>-embed/<id>.json` with the default `fileExtension`; set it to blank to avoid that.
 * An empty metadata list is refused, as Tika's is.
 */
export class AzBlobEmitter implements Emitter {
  readonly #client: AzBlobClient;
  readonly #prefix: string;
  readonly #fileExtension: string;
  readonly #overwrite: boolean;

  constructor(options: AzBlobEmitterOptions) {
    this.#client = azBlobClientFor(options.azure, options.transport);
    this.#prefix = options.prefix === undefined || options.prefix === "" ? "" : `${options.prefix}/`;
    this.#fileExtension = options.fileExtension === undefined || options.fileExtension === "" ? "" : `.${options.fileExtension}`;
    this.#overwrite = options.overwriteExisting === true;
  }

  async emit(document: EmittedDocument): Promise<void> {
    const data =
      document.bytes !== undefined
        ? document.bytes
        : document.mode === "CONTENT_ONLY"
          ? Buffer.from(document.text ?? "", "utf8")
          : Buffer.from(this.#metadataJson(document), "utf8");
    await this.#client.put(`${this.#prefix}${document.id}${this.#fileExtension}`, data, { overwrite: this.#overwrite });
  }

  #metadataJson(document: EmittedDocument): string {
    if (documentObjects(document).length === 0) throw new Error(`metadata list must not be null or empty (${JSON.stringify(document.id)})`);
    return documentJson(document);
  }
}

export interface AzBlobPipesIteratorOptions {
  readonly azure: AzBlobConnectionSettings;
  readonly prefix?: string;
  /** Milliseconds each List Blobs request may take. Default Tika's 360000. */
  readonly timeoutMillis?: number;
  readonly fetcherId: string;
  readonly emitterId?: string;
  readonly transport?: AzBlobTransport;
}

const DEFAULT_TIMEOUT_MILLIS = 360000;

/**
 * Tika's AZBlobPipesIterator: one tuple for each blob under `prefix`, in the order the service lists them, id, fetch key
 * and emit key the blob's name. A blob of 0 bytes is left out, as Tika leaves out directory placeholders that way. One
 * trailing `/` of the prefix is dropped, as Tika drops it, so `docs/` also lists `docs-old/`.
 */
export class AzBlobPipesIterator implements PipesIterator {
  readonly #client: AzBlobClient;
  readonly #options: AzBlobPipesIteratorOptions;

  constructor(options: AzBlobPipesIteratorOptions) {
    this.#options = options;
    this.#client = azBlobClientFor(options.azure, options.transport);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<FetchEmitTuple> {
    const { fetcherId, emitterId, prefix, timeoutMillis } = this.#options;
    const listed = prefix?.endsWith("/") === true ? prefix.slice(0, -1) : prefix;
    for await (const blob of this.#client.list(listed, { timeoutMs: timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS })) {
      if (blob.size === 0) continue;
      yield { id: blob.name, fetcher: fetcherId, fetchKey: blob.name, ...(emitterId === undefined ? {} : { emitter: emitterId, emitKey: blob.name }) };
    }
  }
}
