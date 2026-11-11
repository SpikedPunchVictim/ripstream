import type { CredentialProvider } from "./credentials.ts";
import { EMPTY_PAYLOAD_SHA256, sha256Hex, signV4, uriEncode } from "./sigv4.ts";

/*
 * The three S3 calls pipes makes: GetObject, PutObject and ListObjectsV2. A request is signed with SigV4 and sent with
 * `fetch`, to the AWS endpoint of the region or to `endpoint` (S3-compatible storage such as MinIO), in virtual-hosted
 * style (`bucket.host/key`) or, with `pathStyle`, `host/bucket/key`, as the AWS SDK for Java builds them.
 */

export interface S3ClientOptions {
  readonly region: string;
  readonly bucket: string;
  readonly credentials: CredentialProvider;
  /** An S3-compatible service's URL: Tika's `endpointConfigurationService`. */
  readonly endpoint?: string;
  /** Tika's `pathStyleAccessEnabled`. */
  readonly pathStyle?: boolean;
  /** Replaces the network (a test's fake S3). Default the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

/** What S3 answered when it was not a success: the HTTP status, and the error `Code` of the body (`NoSuchKey`, `AccessDenied`). */
export class S3Error extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "S3Error";
    this.status = status;
    this.code = code;
  }
}

/** An element's text, with XML's predefined and numeric character references decoded. */
export function xmlText(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity] ?? _;
  });
}

/** The text of the first `<tag>text</tag>` of `xml`, still escaped. A self-closing `<tag />` is none. */
export const firstTag = (xml: string, tag: string): string | undefined => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];

export class S3Client {
  readonly #options: S3ClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: S3ClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** Where a request for `encodedPath` goes: its URL and the `host` header it is signed for. */
  #locate(encodedKeyPath: string): { origin: string; host: string; path: string } {
    const { bucket, region, endpoint, pathStyle } = this.#options;
    const base = endpoint === undefined ? new URL(`https://s3.${region}.amazonaws.com`) : new URL(endpoint);
    // A bucket name with a dot does not match the service's wildcard certificate in virtual-hosted style; the SDK uses path style for it.
    const pathStyled = pathStyle === true || (endpoint === undefined && bucket.includes("."));
    if (pathStyled) return { origin: base.origin, host: base.host, path: `${base.pathname.replace(/\/$/, "")}/${uriEncode(bucket)}${encodedKeyPath}` };
    const host = `${bucket}.${base.host}`;
    return { origin: `${base.protocol}//${host}`, host, path: `${base.pathname.replace(/\/$/, "")}${encodedKeyPath}` };
  }

  async #send(
    method: "GET" | "PUT",
    encodedKeyPath: string,
    init: { query?: ReadonlyArray<readonly [string, string]>; headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal },
  ): Promise<Response> {
    const where = this.#locate(encodedKeyPath);
    const credentials = await this.#options.credentials();
    const body = init.body;
    const signed = signV4({
      method,
      encodedPath: where.path === "" ? "/" : where.path,
      ...(init.query === undefined ? {} : { query: init.query }),
      headers: { host: where.host, ...init.headers },
      payloadSha256: body === undefined ? EMPTY_PAYLOAD_SHA256 : sha256Hex(body),
      region: this.#options.region,
      credentials,
      now: (this.#options.now ?? (() => new Date()))(),
    });
    const { host: _host, ...sendable } = signed.headers;
    const query = init.query === undefined || init.query.length === 0 ? "" : `?${init.query.map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`).join("&")}`;
    // A redirect would carry the signature to another host; a bucket in another region is an error to fix in the settings.
    const response = await this.#fetch(`${where.origin}${where.path === "" ? "/" : where.path}${query}`, {
      method,
      headers: sendable,
      redirect: "error",
      // The bytes are sent as they are; the cast is the lib's `Uint8Array<ArrayBuffer>` where ours may be over a SharedArrayBuffer.
      ...(body === undefined ? {} : { body: body as Uint8Array<ArrayBuffer> }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
    if (response.ok) return response;
    const text = await response.text().catch(() => "");
    const code = firstTag(text, "Code");
    const message = firstTag(text, "Message");
    throw new S3Error(response.status, code, `S3 ${method} ${response.status}${code === undefined ? "" : ` ${code}`}${message === undefined ? "" : `: ${xmlText(message)}`}`);
  }

  /** The object's bytes. With `maxLength`, an object that says it is longer is refused before its body is read. */
  async get(key: string, options: { signal?: AbortSignal; maxLength?: number } = {}): Promise<Uint8Array> {
    const response = await this.#send("GET", `/${uriEncode(key, true)}`, options.signal === undefined ? {} : { signal: options.signal });
    const declared = Number(response.headers.get("content-length"));
    if (options.maxLength !== undefined && options.maxLength > -1 && Number.isFinite(declared) && declared > options.maxLength) {
      await response.body?.cancel();
      throw new Error(`S3 object ${JSON.stringify(key)} is ${declared} bytes, over the maxLength of ${options.maxLength}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(key: string, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<void> {
    const response = await this.#send("PUT", `/${uriEncode(key, true)}`, { body: bytes, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    await response.body?.cancel();
  }

  /** Every key under `prefix`, page by page (ListObjectsV2, as `listObjectsV2Paginator` does), in the order S3 lists them. */
  async *list(prefix: string | undefined, options: { signal?: AbortSignal } = {}): AsyncGenerator<string> {
    let token: string | undefined;
    do {
      const query: Array<readonly [string, string]> = [["list-type", "2"]];
      if (prefix !== undefined && prefix !== "") query.push(["prefix", prefix]);
      if (token !== undefined) query.push(["continuation-token", token]);
      const response = await this.#send("GET", "/", { query, ...(options.signal === undefined ? {} : { signal: options.signal }) });
      const xml = await response.text();
      for (const match of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<\/Contents>/g)) yield xmlText(match[1] ?? "");
      token = firstTag(xml, "IsTruncated") === "true" ? firstTag(xml, "NextContinuationToken") : undefined;
      if (token !== undefined) token = xmlText(token);
    } while (token !== undefined);
  }
}
