import type { GcsConnectionSettings } from "@spikedpunch/ripstream-core";
import type { EmittedDocument, Emitter } from "../index.ts";
import { documentJson, documentObjects } from "../file-system-emitter.ts";
import type { FetchContext, FetchEmitTuple, Fetcher, PipesIterator } from "../tuple.ts";
import { GcsClient } from "./client.ts";
import { applicationDefaultToken, type TokenProvider } from "./credentials.ts";

/*
 * Tika's gcs-fetcher, gcs-emitter and gcs-pipes-iterator (tika-pipes-gcs 4.2.0), over `GcsClient`. Tika uses the Google
 * Cloud Storage client library; these send the same requests to the JSON API with `fetch` and node:crypto, so ripstream has
 * no Google dependency.
 */

const READ_ONLY = "https://www.googleapis.com/auth/devstorage.read_only";
const READ_WRITE = "https://www.googleapis.com/auth/devstorage.read_write";

/** The seams a test replaces: the network, the clock, the environment the credentials are found by, and where the API is. */
export interface GcsTransport {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  /** What `GOOGLE_APPLICATION_CREDENTIALS` and `GCE_METADATA_HOST` are read from. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where the storage API is, for a storage emulator. Default Google's. */
  readonly endpoint?: string;
  /** Replaces the application default credentials. */
  readonly token?: TokenProvider;
}

/** A client for the bucket, whose token has the scope `scope` asks for: a reader needs less than a writer. */
export function gcsClientFor(settings: GcsConnectionSettings, scope: string, transport: GcsTransport = {}): GcsClient {
  const token =
    transport.token ??
    applicationDefaultToken({
      scope,
      ...(transport.env === undefined ? {} : { env: transport.env }),
      ...(transport.fetchImpl === undefined ? {} : { fetchImpl: transport.fetchImpl }),
      ...(transport.now === undefined ? {} : { now: transport.now }),
    });
  return new GcsClient({
    bucket: settings.bucket,
    token,
    ...(transport.endpoint === undefined ? {} : { endpoint: transport.endpoint }),
    ...(transport.fetchImpl === undefined ? {} : { fetchImpl: transport.fetchImpl }),
  });
}

export interface GcsFetcherOptions {
  readonly gcs: GcsConnectionSettings;
  readonly transport?: GcsTransport;
}

/** Tika's GCSFetcher: the object of the bucket that the fetch key names, as it is. */
export class GcsFetcher implements Fetcher {
  readonly #client: GcsClient;

  constructor(options: GcsFetcherOptions) {
    this.#client = gcsClientFor(options.gcs, READ_ONLY, options.transport);
  }

  fetch(key: string, context: FetchContext): Promise<Uint8Array> {
    return this.#client.get(key, { signal: context.signal });
  }
}

export interface GcsEmitterOptions {
  readonly gcs: GcsConnectionSettings;
  /** Put before every key with a `/`. */
  readonly prefix?: string;
  /** Added to every key after a dot, bytes included: Tika's `emit(path, InputStream)` does the same as its metadata emit. */
  readonly fileExtension?: string;
  readonly transport?: GcsTransport;
}

/**
 * Tika's GCSEmitter: `prefix/emitKey.fileExtension`. A metadata document is the JSON list (compact, as Tika's
 * `JsonMetadataList.toJson`), CONTENT_ONLY the content, and embedded bytes the bytes. Tika puts the extension on all of
 * them, so an unpacked file is `<emitKey>-embed/<id>.json` with the default `fileExtension`; set it to blank to avoid that.
 * An empty metadata list is refused, as Tika's is.
 */
export class GcsEmitter implements Emitter {
  readonly #client: GcsClient;
  readonly #prefix: string;
  readonly #fileExtension: string;

  constructor(options: GcsEmitterOptions) {
    this.#client = gcsClientFor(options.gcs, READ_WRITE, options.transport);
    this.#prefix = options.prefix === undefined || options.prefix === "" ? "" : `${options.prefix}/`;
    this.#fileExtension = options.fileExtension === undefined || options.fileExtension === "" ? "" : `.${options.fileExtension}`;
  }

  async emit(document: EmittedDocument): Promise<void> {
    const data =
      document.bytes !== undefined
        ? document.bytes
        : document.mode === "CONTENT_ONLY"
          ? Buffer.from(document.text ?? "", "utf8")
          : Buffer.from(this.#metadataJson(document), "utf8");
    await this.#client.put(`${this.#prefix}${document.id}${this.#fileExtension}`, data);
  }

  #metadataJson(document: EmittedDocument): string {
    if (documentObjects(document).length === 0) throw new Error(`metadata list must not be null or empty (${JSON.stringify(document.id)})`);
    return documentJson(document);
  }
}

export interface GcsPipesIteratorOptions {
  readonly gcs: GcsConnectionSettings;
  readonly prefix?: string;
  readonly fetcherId: string;
  readonly emitterId?: string;
  readonly transport?: GcsTransport;
}

/**
 * Tika's GCSPipesIterator: one tuple for each object under `prefix`, in the order Cloud Storage lists them, id, fetch key
 * and emit key the object's name. An object of 0 bytes is left out, as Tika leaves out directories that way.
 */
export class GcsPipesIterator implements PipesIterator {
  readonly #client: GcsClient;
  readonly #options: GcsPipesIteratorOptions;

  constructor(options: GcsPipesIteratorOptions) {
    this.#options = options;
    this.#client = gcsClientFor(options.gcs, READ_ONLY, options.transport);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<FetchEmitTuple> {
    const { fetcherId, emitterId, prefix } = this.#options;
    for await (const object of this.#client.list(prefix)) {
      if (object.size === 0) continue;
      yield { id: object.name, fetcher: fetcherId, fetchKey: object.name, ...(emitterId === undefined ? {} : { emitter: emitterId, emitKey: object.name }) };
    }
  }
}
