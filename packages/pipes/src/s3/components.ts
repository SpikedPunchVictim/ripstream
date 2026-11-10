import type { S3ConnectionSettings } from "@spikedpunch/ripstream-core";
import type { EmittedDocument, Emitter } from "../index.ts";
import { documentJson } from "../file-system-emitter.ts";
import type { FetchContext, FetchEmitTuple, Fetcher, PipesIterator } from "../tuple.ts";
import { S3Client, type S3ClientOptions } from "./client.ts";
import { instanceCredentials, profileCredentials, staticCredentials, type CredentialProvider } from "./credentials.ts";

/*
 * Tika's s3-fetcher, s3-emitter and s3-pipes-iterator (tika-pipes-s3 4.2.0), over `S3Client`. Tika uses the AWS SDK for
 * Java; these send the same requests with `fetch` and node:crypto, so ripstream has no AWS dependency.
 */

/** The seams a test replaces: the network, the clock and where the credentials come from. */
export interface S3Transport {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  /** Replaces the provider the settings name. */
  readonly credentials?: CredentialProvider;
}

export function credentialsFor(settings: S3ConnectionSettings): CredentialProvider {
  switch (settings.credentialsProvider) {
    case "key_secret":
      return staticCredentials(settings.accessKey ?? "", settings.secretKey ?? "");
    case "profile":
      return profileCredentials(settings.profile ?? "");
    case "instance":
      return instanceCredentials();
  }
}

export function s3ClientFor(settings: S3ConnectionSettings, transport: S3Transport = {}): S3Client {
  const options: S3ClientOptions = {
    region: settings.region,
    bucket: settings.bucket,
    credentials: transport.credentials ?? credentialsFor(settings),
    pathStyle: settings.pathStyle,
    ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
    ...(transport.fetchImpl === undefined ? {} : { fetchImpl: transport.fetchImpl }),
    ...(transport.now === undefined ? {} : { now: transport.now }),
  };
  return new S3Client(options);
}

export interface S3FetcherOptions {
  readonly s3: S3ConnectionSettings;
  /** Put in front of the fetch key as it is: Tika adds no slash. */
  readonly prefix?: string;
  /** An object longer than this many bytes is refused before it is read. */
  readonly maxLength?: number;
  readonly transport?: S3Transport;
}

/** Tika's S3Fetcher: the object `prefix + fetchKey` of the bucket. */
export class S3Fetcher implements Fetcher {
  readonly #client: S3Client;
  readonly #prefix: string;
  readonly #maxLength: number | undefined;

  constructor(options: S3FetcherOptions) {
    this.#client = s3ClientFor(options.s3, options.transport);
    this.#prefix = options.prefix ?? "";
    this.#maxLength = options.maxLength;
  }

  fetch(key: string, context: FetchContext): Promise<Uint8Array> {
    return this.#client.get(this.#prefix === "" ? key : `${this.#prefix}${key}`, {
      signal: context.signal,
      ...(this.#maxLength === undefined ? {} : { maxLength: this.#maxLength }),
    });
  }
}

export interface S3EmitterOptions {
  readonly s3: S3ConnectionSettings;
  /** Put before every key with a `/`. */
  readonly prefix?: string;
  /** Added to every key after a dot, bytes included: Tika's `emit(path, InputStream)` does the same as its metadata emit. */
  readonly fileExtension?: string;
  readonly transport?: S3Transport;
}

/**
 * Tika's S3Emitter: `PUT prefix/emitKey.fileExtension`. A metadata document is the JSON list (compact, as Tika's
 * `JsonMetadataList.toJson`), CONTENT_ONLY the content, and embedded bytes the bytes. Tika puts the extension on all of
 * them, so an unpacked file is `<emitKey>-embed/<id>.json` with the default `fileExtension`; set it to blank to avoid that.
 */
export class S3Emitter implements Emitter {
  readonly #client: S3Client;
  readonly #prefix: string;
  readonly #fileExtension: string;

  constructor(options: S3EmitterOptions) {
    this.#client = s3ClientFor(options.s3, options.transport);
    this.#prefix = options.prefix === undefined || options.prefix === "" ? "" : `${options.prefix}/`;
    this.#fileExtension = options.fileExtension === undefined || options.fileExtension === "" ? "" : `.${options.fileExtension}`;
  }

  async emit(document: EmittedDocument): Promise<void> {
    const data =
      document.bytes !== undefined
        ? document.bytes
        : document.mode === "CONTENT_ONLY"
          ? Buffer.from(document.text ?? "", "utf8")
          : Buffer.from(documentJson(document), "utf8");
    await this.#client.put(`${this.#prefix}${document.id}${this.#fileExtension}`, data);
  }
}

export interface S3PipesIteratorOptions {
  readonly s3: S3ConnectionSettings;
  readonly prefix?: string;
  /** A key is listed when this matches anywhere in its file name (the part after the last `/`). */
  readonly fileNamePattern?: string;
  readonly fetcherId: string;
  readonly emitterId?: string;
  readonly transport?: S3Transport;
}

/** The name of a key: what follows the last `/` (Tika's `FilenameUtils.getName`, which also reads `\`). */
const fileNameOf = (key: string): string => key.slice(Math.max(key.lastIndexOf("/"), key.lastIndexOf("\\")) + 1);

/** Tika's S3PipesIterator: one tuple for each key under `prefix`, in the order S3 lists them, id, fetch key and emit key the key. */
export class S3PipesIterator implements PipesIterator {
  readonly #client: S3Client;
  readonly #options: S3PipesIteratorOptions;
  readonly #pattern: RegExp | undefined;

  constructor(options: S3PipesIteratorOptions) {
    this.#options = options;
    this.#client = s3ClientFor(options.s3, options.transport);
    this.#pattern = options.fileNamePattern === undefined ? undefined : new RegExp(options.fileNamePattern);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<FetchEmitTuple> {
    const { fetcherId, emitterId, prefix } = this.#options;
    for await (const key of this.#client.list(prefix)) {
      if (this.#pattern !== undefined && !this.#pattern.test(fileNameOf(key))) continue;
      yield { id: key, fetcher: fetcherId, fetchKey: key, ...(emitterId === undefined ? {} : { emitter: emitterId, emitKey: key }) };
    }
  }
}
