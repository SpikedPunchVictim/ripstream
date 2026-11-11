import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

/*
 * Where a GCS component gets its access token. Tika's components build `StorageOptions` with a project id and nothing
 * else, so the token comes from Google's application default credentials. Two of its sources are read here: the service
 * account key file `GOOGLE_APPLICATION_CREDENTIALS` names (a JWT signed with the key's RS256 private key, exchanged at the
 * key's `token_uri`) and the metadata server of a Google Cloud VM. The gcloud user credentials file, other kinds of key
 * file (`authorized_user`, `external_account`, `impersonated_service_account`) and GCE's other environment variables are
 * not read.
 */

/** Gives an access token, from the cache while it is good. */
export type TokenProvider = () => Promise<string>;

export interface TokenOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  /** How long the token endpoint may take. Default 10 seconds. */
  readonly timeoutMs?: number;
}

export interface ServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string;
  readonly private_key_id?: string;
  readonly token_uri: string;
}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** How long before it expires a token is replaced. */
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

/** The longest stretch of an error response that goes into a message. */
const MESSAGE_LIMIT = 500;
const clipped = (value: string): string => (value.length > MESSAGE_LIMIT ? `${value.slice(0, MESSAGE_LIMIT)}...` : value);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A service account key as the JSON file gives it, or an error that names the file and what is wrong. */
export function parseServiceAccountKey(json: string, where: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`${where} is not JSON: ${(error as Error).message}`, { cause: error });
  }
  if (!isObject(parsed)) throw new Error(`${where} must be a JSON object`);
  if (parsed.type !== undefined && parsed.type !== "service_account") {
    throw new Error(`${where} has type ${JSON.stringify(parsed.type)}, which ripstream does not read: only "service_account" key files (the gcloud user credentials, external accounts and impersonation are not supported)`);
  }
  for (const field of ["client_email", "private_key"] as const) {
    if (typeof parsed[field] !== "string" || parsed[field] === "") throw new Error(`${where} has no ${field}`);
  }
  const uri = parsed.token_uri ?? DEFAULT_TOKEN_URI;
  if (typeof uri !== "string" || !/^https?:\/\//.test(uri)) throw new Error(`${where}: token_uri must be an http or https URL`);
  return {
    client_email: parsed.client_email as string,
    private_key: parsed.private_key as string,
    ...(typeof parsed.private_key_id === "string" && parsed.private_key_id !== "" ? { private_key_id: parsed.private_key_id } : {}),
    token_uri: uri,
  };
}

/** What a token endpoint answered when it was not a success: the HTTP status, so that a 503 is retried and a 400 is not. */
export class TokenError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "TokenError";
    this.status = status;
  }
}

/** The token the endpoint answered, and how many seconds it holds. */
interface Issued {
  readonly token: string;
  readonly expiresInSeconds: number;
}

/** Keeps a token until five minutes before it expires; a refresh in progress is shared by every caller. */
function cached(load: () => Promise<Issued>, now: () => Date): TokenProvider {
  let current: { token: string; expires: number } | undefined;
  let refreshing: Promise<string> | undefined;
  return async () => {
    if (current !== undefined && now().getTime() < current.expires - REFRESH_BEFORE_EXPIRY_MS) return current.token;
    refreshing ??= load()
      .then((issued) => {
        current = { token: issued.token, expires: now().getTime() + issued.expiresInSeconds * 1000 };
        return issued.token;
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };
}

/** The `access_token` and `expires_in` of a token endpoint's answer. */
async function readIssued(response: Response, from: string): Promise<Issued> {
  const text = await response.text();
  if (!response.ok) throw new TokenError(`${from} answered ${response.status}: ${clipped(text)}`, response.status);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new TokenError(`${from} answered 200 with a body that is not JSON: ${clipped(text)}`);
  }
  if (!isObject(body) || typeof body.access_token !== "string" || body.access_token === "") throw new TokenError(`${from} gave no access_token: ${clipped(text)}`);
  const expiresInSeconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 0;
  return { token: body.access_token, expiresInSeconds };
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

/** The signed JWT of Google's service-account flow: RS256, valid for the hour the token endpoint allows at most. */
function signedAssertion(key: ServiceAccountKey, scope: string, issuedAt: number): string {
  const header = { alg: "RS256", typ: "JWT", ...(key.private_key_id === undefined ? {} : { kid: key.private_key_id }) };
  const claims = { iss: key.client_email, scope, aud: key.token_uri, iat: issuedAt, exp: issuedAt + 3600 };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  try {
    return `${unsigned}.${base64url(createSign("RSA-SHA256").update(unsigned).sign(key.private_key))}`;
  } catch (error) {
    throw new Error(`the private_key of the service account key ${key.client_email} could not sign: ${(error as Error).message}`, { cause: error });
  }
}

/** The token of a service account: its JWT exchanged at its `token_uri`. Not run against Google's token endpoint. */
export function serviceAccountToken(key: ServiceAccountKey, options: TokenOptions & { readonly scope: string }): TokenProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  return cached(async () => {
    const assertion = signedAssertion(key, options.scope, Math.floor(now().getTime() / 1000));
    const response = await doFetch(key.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    return readIssued(response, `the token endpoint ${key.token_uri}`);
  }, now);
}

export interface MetadataServerOptions extends TokenOptions {
  /** Default `http://` + `GCE_METADATA_HOST`, else `http://metadata.google.internal`. */
  readonly metadataEndpoint?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The token of the VM's default service account, from the metadata server. Not run against a Google Cloud VM. */
export function metadataServerToken(options: MetadataServerOptions = {}): TokenProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const host = env.GCE_METADATA_HOST;
  const endpoint = (options.metadataEndpoint ?? (host === undefined || host === "" ? "http://metadata.google.internal" : `http://${host}`)).replace(/\/$/, "");
  const path = "/computeMetadata/v1/instance/service-accounts/default/token";
  return cached(async () => {
    const response = await doFetch(`${endpoint}${path}`, {
      headers: { "metadata-flavor": "Google" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
    return readIssued(response, `the metadata server ${endpoint}`);
  }, now);
}

/**
 * Google's application default credentials, the two sources ripstream reads: the service account key file named by
 * `GOOGLE_APPLICATION_CREDENTIALS`, and when the variable is not set the metadata server. The file is read on the first
 * token; a failure to read it is the failure of that call, and the next call reads it again.
 */
export function applicationDefaultToken(options: MetadataServerOptions & { readonly scope: string }): TokenProvider {
  const env = options.env ?? process.env;
  const file = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file === undefined || file === "") return metadataServerToken(options);
  let provider: TokenProvider | undefined;
  return async () => {
    if (provider === undefined) {
      let json: string;
      try {
        json = await readFile(file, "utf8");
      } catch (error) {
        throw new Error(`GOOGLE_APPLICATION_CREDENTIALS names ${file}, which cannot be read: ${(error as Error).message}`, { cause: error });
      }
      provider = serviceAccountToken(parseServiceAccountKey(json, file), options);
    }
    return provider();
  };
}
