import { createHash, createHmac } from "node:crypto";

/*
 * AWS Signature Version 4 for S3 (the Authorization header form), with node:crypto and nothing else. Tika's S3
 * components use the AWS SDK for Java; this is the same signature over `fetch`, so a request is exactly what the SDK
 * sends for the operations pipes needs: GET, PUT and a ListObjectsV2 listing.
 *
 * Checked against the examples AWS publishes in "Signature Calculations for the Authorization Header" (GET Object, PUT
 * Object, GET Bucket): packages/pipes/test/s3-sigv4.test.ts.
 */

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present for temporary credentials (an instance role, `aws_session_token` in a profile): sent as `x-amz-security-token`. */
  readonly sessionToken?: string;
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** The hash of an empty body, which a GET sends as `x-amz-content-sha256`. */
export const EMPTY_PAYLOAD_SHA256 = sha256Hex("");

const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** RFC 3986 percent-encoding as SigV4 wants it: only `A-Za-z0-9-_.~` stay; `/` stays too when `keepSlash`. */
export function uriEncode(value: string, keepSlash = false): string {
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char) || (keepSlash && char === "/")) encoded += char;
    else encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

export interface SignInput {
  readonly method: string;
  /** The path as it is sent: already encoded once, as S3 does not encode it again to sign it. */
  readonly encodedPath: string;
  /** The query as pairs; they are encoded and sorted here. */
  readonly query?: ReadonlyArray<readonly [string, string]>;
  /** Every header to send and sign except the four this adds, names in any case. Must include `host`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Lower-case hex SHA-256 of the body. */
  readonly payloadSha256: string;
  readonly region: string;
  readonly service?: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}

export interface Signed {
  /** Every header to send, lower-case names: the input's, `x-amz-content-sha256`, `x-amz-date`, the token and `authorization`. */
  readonly headers: Record<string, string>;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

const amzDate = (now: Date): string => now.toISOString().replace(/[-:]|\.\d{3}/g, "");

export function canonicalQuery(query: ReadonlyArray<readonly [string, string]> = []): string {
  return query
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function signV4(input: SignInput): Signed {
  const service = input.service ?? "s3";
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  if (headers.host === undefined) throw new RangeError("a signed request needs a host header");
  headers["x-amz-content-sha256"] = input.payloadSha256;
  headers["x-amz-date"] = date;
  if (input.credentials.sessionToken !== undefined) headers["x-amz-security-token"] = input.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method,
    input.encodedPath,
    canonicalQuery(input.query),
    ...names.map((name) => `${name}:${headers[name]}`),
    "",
    signedHeaders,
    input.payloadSha256,
  ].join("\n");
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}
