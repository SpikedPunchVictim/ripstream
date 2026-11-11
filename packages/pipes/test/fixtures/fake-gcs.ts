import { createVerify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * Google Cloud Storage in memory, over HTTP, with the three endpoints a client meets: the OAuth token endpoint (which
 * checks the service-account JWT's RS256 signature against the public key it was given, and its claims), the metadata
 * server's token path, and the storage JSON API (objects.get with alt=media, objects.insert with uploadType=media,
 * objects.list with pageToken). A storage request without a token this server issued is a 401; a write with a token
 * whose scope does not allow writes is a 403.
 */

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

export interface FakeGcs {
  readonly url: string;
  readonly tokenUrl: string;
  readonly bucket: string;
  readonly objects: Map<string, Buffer>;
  readonly requests: Recorded[];
  /** The header and claims of every assertion whose signature checked out. */
  readonly assertions: Array<{ header: Record<string, unknown>; claims: Record<string, unknown> }>;
  /** Objects per list page. Default 1000. */
  pageSize: number;
  /** Answers the next requests for this object with this status and reason instead of serving it. */
  failNext(name: string, status: number, reason: string, times?: number): void;
  close(): Promise<void>;
}

export interface FakeGcsOptions {
  /** The public half of the service account's key: assertions signed by anything else are refused. */
  readonly publicKey: KeyObject;
  readonly clientEmail: string;
  /** The clock the token endpoint checks `iat` and `exp` against, in ms. Default the real one. */
  readonly now?: () => number;
}

const WRITE_SCOPES = ["https://www.googleapis.com/auth/devstorage.read_write", "https://www.googleapis.com/auth/devstorage.full_control", "https://www.googleapis.com/auth/cloud-platform"];
const READ_SCOPES = [...WRITE_SCOPES, "https://www.googleapis.com/auth/devstorage.read_only"];

const decodePart = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

export async function fakeGcs(bucket: string, options: FakeGcsOptions): Promise<FakeGcs> {
  const objects = new Map<string, Buffer>();
  const requests: Recorded[] = [];
  const assertions: FakeGcs["assertions"] = [];
  const failures = new Map<string, { status: number; reason: string; times: number }>();
  const tokens = new Map<string, string>();
  const state = { pageSize: 1000, url: "", lists: 0 };
  const now = options.now ?? Date.now;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      const send = (status: number, payload: string | Buffer, type = "application/json"): void => {
        response.writeHead(status, { "content-type": type, "content-length": String(Buffer.byteLength(payload)) });
        response.end(payload);
      };
      const fail = (status: number, reason: string, message: string): void => send(status, JSON.stringify({ error: { code: status, message, errors: [{ reason, message }] } }));
      const issue = (scope: string): void => {
        const token = `ya29.fake-${tokens.size + 1}`;
        tokens.set(token, scope);
        send(200, JSON.stringify({ access_token: token, expires_in: 3600, token_type: "Bearer" }));
      };
      const refuse = (description: string): void => send(400, JSON.stringify({ error: "invalid_grant", error_description: description }));

      const url = new URL(request.url ?? "/", "http://fake");

      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(body.toString("utf8"));
        if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return refuse("grant_type is not the JWT bearer grant");
        const [encodedHeader = "", encodedClaims = "", signature = "", ...extra] = (form.get("assertion") ?? "").split(".");
        if (extra.length > 0 || signature === "") return refuse("the assertion is not a JWT");
        const header = decodePart(encodedHeader);
        const claims = decodePart(encodedClaims);
        if (header.alg !== "RS256") return refuse(`alg ${String(header.alg)} is not RS256`);
        const verifier = createVerify("RSA-SHA256").update(`${encodedHeader}.${encodedClaims}`);
        if (!verifier.verify(options.publicKey, Buffer.from(signature, "base64url"))) return refuse("Invalid JWT Signature.");
        if (claims.iss !== options.clientEmail) return refuse("iss is not the service account");
        if (claims.aud !== `${state.url}/token`) return refuse("aud is not the token endpoint");
        const iat = Number(claims.iat);
        const exp = Number(claims.exp);
        if (!(Math.abs(iat - now() / 1000) < 300 && exp > iat && exp - iat <= 3600)) return refuse("iat or exp is out of range");
        if (typeof claims.scope !== "string" || claims.scope === "") return refuse("no scope");
        assertions.push({ header, claims });
        return issue(claims.scope);
      }

      if (url.pathname === "/computeMetadata/v1/instance/service-accounts/default/token") {
        if (request.headers["metadata-flavor"] !== "Google") return send(403, "Missing Metadata-Flavor:Google header.", "text/plain");
        return issue("https://www.googleapis.com/auth/cloud-platform");
      }

      const scope = tokens.get(/^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "");
      if (scope === undefined) return fail(401, "authError", "Invalid Credentials");
      const write = request.method === "POST";
      if (!(write ? WRITE_SCOPES : READ_SCOPES).some((allowed) => scope.split(" ").includes(allowed))) {
        return fail(403, "insufficientPermissions", "Provided scope(s) are not authorized");
      }
      const prefix = `/b/${bucket}/o`;
      const path = url.pathname.replace(/^\/(upload\/)?storage\/v1/, "");
      if (!path.startsWith("/b/")) return fail(404, "notFound", "Not Found");
      if (!path.startsWith(`${prefix}`)) return fail(404, "notFound", `The specified bucket does not exist.`);

      if (request.method === "GET" && path === prefix) {
        // A client that does not send the page token back would list the first page for ever: fail it instead of hanging the test.
        if (++state.lists > 1000) return fail(500, "backendError", "runaway pagination: more than 1000 list requests");
        const wanted = url.searchParams.get("prefix") ?? "";
        const names = [...objects.keys()].filter((name) => name.startsWith(wanted)).sort();
        const start = Number(url.searchParams.get("pageToken") ?? "0");
        const page = names.slice(start, start + state.pageSize);
        const next = start + state.pageSize < names.length ? { nextPageToken: String(start + state.pageSize) } : {};
        return send(200, JSON.stringify({ kind: "storage#objects", items: page.map((name) => ({ name, size: String(objects.get(name)?.length ?? 0) })), ...next }));
      }
      if (request.method === "GET" && path.startsWith(`${prefix}/`)) {
        const name = decodeURIComponent(path.slice(prefix.length + 1));
        const planned = failures.get(name);
        if (planned !== undefined && planned.times > 0) {
          planned.times--;
          return fail(planned.status, planned.reason, "planned failure");
        }
        if (url.searchParams.get("alt") !== "media") return fail(400, "invalid", "only alt=media");
        const found = objects.get(name);
        if (found === undefined) return fail(404, "notFound", `No such object: ${bucket}/${name}`);
        return send(200, found, "application/octet-stream");
      }
      if (request.method === "POST" && path === prefix) {
        const name = url.searchParams.get("name");
        if (url.searchParams.get("uploadType") !== "media" || name === null) return fail(400, "invalid", "only uploadType=media with a name");
        objects.set(name, body);
        return send(200, JSON.stringify({ kind: "storage#object", bucket, name, size: String(body.length) }));
      }
      return fail(405, "methodNotAllowed", request.method ?? "");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  return {
    url: state.url,
    tokenUrl: `${state.url}/token`,
    bucket,
    objects,
    requests,
    assertions,
    get pageSize() {
      return state.pageSize;
    },
    set pageSize(value: number) {
      state.pageSize = value;
    },
    failNext: (name, status, reason, times = 1) => {
      failures.set(name, { status, reason, times });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
