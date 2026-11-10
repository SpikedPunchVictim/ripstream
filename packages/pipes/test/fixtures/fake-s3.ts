import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sha256Hex, signV4 } from "../../src/s3/sigv4.ts";

/*
 * A bucket in memory, over HTTP, in path style (`/bucket/key`). It checks what a real S3 checks first: the request's
 * signature, recomputed from what arrived (the method, the path and query as sent, the headers the client says it signed,
 * the body's hash). A request signed for something other than what was sent is a 403 SignatureDoesNotMatch.
 */

export const ACCESS_KEY = "AKIAFAKEFAKEFAKE0000";
export const SECRET_KEY = "fakeSecretKey/ForTests+0123456789abcdefgh";

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

export interface FakeS3 {
  readonly url: string;
  readonly bucket: string;
  readonly objects: Map<string, Buffer>;
  readonly requests: Recorded[];
  /** Answers the next request for this key with this status and error code instead of serving it. */
  failNext(key: string, status: number, code: string, times?: number): void;
  /** Keys per ListObjectsV2 page. Default 1000. */
  pageSize: number;
  close(): Promise<void>;
}

const xml = (code: string, message: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`;
const escapeXml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function fakeS3(bucket: string, options: { sessionToken?: string } = {}): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const requests: Recorded[] = [];
  const failures = new Map<string, { status: number; code: string; times: number }>();
  const state = { pageSize: 1000 };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      const send = (status: number, payload: string | Buffer, headers: Record<string, string> = {}): void => {
        response.writeHead(status, { "content-length": String(Buffer.byteLength(payload)), ...headers });
        response.end(request.method === "HEAD" ? undefined : payload);
      };
      const fail = (status: number, code: string, message: string): void => send(status, xml(code, message), { "content-type": "application/xml" });

      const [rawPath = "/", rawQuery = ""] = (request.url ?? "/").split("?");
      const authorization = request.headers.authorization ?? "";
      const header = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(authorization);
      if (header === null) return fail(403, "AccessDenied", "no signature");
      const [, accessKey, , region, signedHeaders, signature] = header;
      if (accessKey !== ACCESS_KEY) return fail(403, "InvalidAccessKeyId", "unknown key");
      const sent: Record<string, string> = {};
      for (const name of (signedHeaders ?? "").split(";")) {
        if (["x-amz-content-sha256", "x-amz-date", "x-amz-security-token"].includes(name)) continue;
        sent[name] = String(request.headers[name] ?? "");
      }
      const amzDate = String(request.headers["x-amz-date"] ?? "");
      const payload = sha256Hex(body);
      if (request.headers["x-amz-content-sha256"] !== payload) return fail(400, "XAmzContentSHA256Mismatch", "the body does not match its hash");
      const expected = signV4({
        method: request.method ?? "",
        encodedPath: rawPath,
        query: [...new URLSearchParams(rawQuery).entries()],
        headers: sent,
        payloadSha256: payload,
        region: region ?? "",
        credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }) },
        now: new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`),
      });
      if (expected.signature !== signature) return fail(403, "SignatureDoesNotMatch", "the request signature does not match");
      if (options.sessionToken !== undefined && request.headers["x-amz-security-token"] !== options.sessionToken) return fail(403, "InvalidToken", "bad token");

      const segments = rawPath.split("/").slice(1);
      if (decodeURIComponent(segments[0] ?? "") !== bucket) return fail(404, "NoSuchBucket", "no such bucket");
      const key = segments.slice(1).map((segment) => decodeURIComponent(segment)).join("/");

      const planned = failures.get(key);
      if (planned !== undefined && planned.times > 0) {
        planned.times--;
        return fail(planned.status, planned.code, "planned failure");
      }

      if (request.method === "PUT") {
        objects.set(key, body);
        return send(200, "", { etag: '"fake"' });
      }
      if (request.method === "GET" && key === "") {
        const query = new URLSearchParams(rawQuery);
        if (query.get("list-type") !== "2") return fail(400, "InvalidRequest", "only ListObjectsV2");
        const prefix = query.get("prefix") ?? "";
        const after = query.get("continuation-token");
        const keys = [...objects.keys()].filter((candidate) => candidate.startsWith(prefix)).sort();
        const start = after === null ? 0 : keys.findIndex((candidate) => candidate > Buffer.from(after, "base64url").toString("utf8"));
        const page = start < 0 ? [] : keys.slice(start, start + state.pageSize);
        const truncated = start >= 0 && start + state.pageSize < keys.length;
        const token = truncated ? Buffer.from(page[page.length - 1] ?? "").toString("base64url") : null;
        return send(
          200,
          `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><Name>${bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${token === null ? "" : `<NextContinuationToken>${token}</NextContinuationToken>`}${page.map((name) => `<Contents><Key>${escapeXml(name)}</Key><Size>${objects.get(name)?.length ?? 0}</Size></Contents>`).join("")}</ListBucketResult>`,
          { "content-type": "application/xml" },
        );
      }
      if (request.method === "GET") {
        const found = objects.get(key);
        if (found === undefined) return fail(404, "NoSuchKey", "The specified key does not exist.");
        return send(200, found, { "content-type": "application/octet-stream" });
      }
      return fail(405, "MethodNotAllowed", request.method ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    requests,
    failNext: (key, status, code, times = 1) => void failures.set(key, { status, code, times }),
    get pageSize() {
      return state.pageSize;
    },
    set pageSize(value: number) {
      state.pageSize = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
