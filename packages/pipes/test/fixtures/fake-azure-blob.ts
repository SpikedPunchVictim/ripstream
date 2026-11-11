import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * Azure Blob Storage in memory, over HTTP: Get Blob, Put Blob and List Blobs (flat, with `marker`) of one container, as
 * the REST API answers them (XML list and error bodies, `x-ms-error-code`). Every request must carry the SAS token the
 * fake was given, parameter for parameter after decoding: a client that decodes, encodes twice or drops part of the token
 * is a 403 AuthenticationFailed, and a token whose `sp` lacks the permission the call needs is a 403
 * AuthorizationPermissionMismatch. `accountPath` is the path an emulator such as Azurite puts before the container.
 */

export interface Recorded {
  readonly method: string;
  /** The path and query as the client sent them, so a test can see the token travel unchanged. */
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

export interface FakeAzureBlob {
  /** The account's endpoint: where a configuration's `endpoint` points. */
  readonly url: string;
  readonly container: string;
  readonly blobs: Map<string, Buffer>;
  readonly requests: Recorded[];
  /** Blobs per list page, which is the service's own cap on `maxresults`. Default 5000. */
  pageSize: number;
  /** How long a List Blobs answer is held back, in ms. Default 0. */
  listDelayMs: number;
  /** Answers the next requests for this blob with this status and error code instead of serving it. */
  failNext(name: string, status: number, code: string, times?: number): void;
  close(): Promise<void>;
}

export interface FakeAzureBlobOptions {
  /** The SAS token, as it is pasted into a configuration: a query string without its `?`. */
  readonly sas: string;
  readonly accountPath?: string;
}

const xmlEscape = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// What XML 1.0 cannot carry in an element: the service sends such a blob name base64 encoded.
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const MARKER_TAIL = "!8!MDA+/9==";

export async function fakeAzureBlob(container: string, options: FakeAzureBlobOptions): Promise<FakeAzureBlob> {
  const blobs = new Map<string, Buffer>();
  const requests: Recorded[] = [];
  const failures = new Map<string, { status: number; code: string; times: number }>();
  const state = { pageSize: 5000, listDelayMs: 0, url: "", lists: 0 };
  const expected = new URLSearchParams(options.sas);
  const permissions = expected.get("sp") ?? "";
  const accountPath = options.accountPath ?? "";

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      const send = (status: number, payload: string | Buffer, type: string, extra: Record<string, string> = {}): void => {
        response.writeHead(status, { "content-type": type, "content-length": String(Buffer.byteLength(payload)), "x-ms-request-id": "fake-request", ...extra });
        response.end(payload);
      };
      const fail = (status: number, code: string, message: string): void =>
        send(status, `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}\nRequestId:fake-request\nTime:2026-01-01T00:00:00.0000000Z</Message></Error>`, "application/xml", { "x-ms-error-code": code });

      const url = new URL(request.url ?? "/", "http://fake");
      for (const [key, value] of expected) {
        if (url.searchParams.get(key) !== value) return fail(403, "AuthenticationFailed", `Server failed to authenticate the request: the SAS parameter ${key} is not the one this fake was given.`);
      }
      if (!request.headers["x-ms-version"]) return fail(400, "MissingRequiredHeader", "An HTTP header that's mandatory for this request is not specified: x-ms-version.");
      const allowed = (permission: string): boolean => permissions.includes(permission);
      const denied = (): void => fail(403, "AuthorizationPermissionMismatch", "This request is not authorized to perform this operation using this permission.");

      const rooted = `${accountPath}/${container}`;
      if (!(url.pathname === rooted || url.pathname.startsWith(`${rooted}/`))) return fail(404, "ContainerNotFound", "The specified container does not exist.");

      if (request.method === "GET" && url.pathname === rooted) {
        if (url.searchParams.get("restype") !== "container" || url.searchParams.get("comp") !== "list") return fail(400, "InvalidQueryParameterValue", "only restype=container&comp=list");
        if (!allowed("l")) return denied();
        // A client that does not send the marker back would list the first page for ever: fail it instead of hanging the test.
        if (++state.lists > 1000) return fail(500, "InternalError", "runaway pagination: more than 1000 list requests");
        const marker = url.searchParams.get("marker");
        if (marker !== null && !marker.endsWith(MARKER_TAIL)) return fail(400, "InvalidQueryParameterValue", `Value for one of the query parameters specified in the request URI is invalid: marker=${marker}`);
        const start = marker === null ? 0 : Number(marker.slice(0, -MARKER_TAIL.length));
        const wanted = url.searchParams.get("prefix") ?? "";
        const names = [...blobs.keys()].filter((name) => name.startsWith(wanted)).sort();
        const page = names.slice(start, start + state.pageSize);
        const next = start + state.pageSize < names.length ? `<NextMarker>${start + state.pageSize}${MARKER_TAIL}</NextMarker>` : "<NextMarker />";
        const items = page
          .map((name) => {
            const label = NOT_XML.test(name) ? `<Name Encoding="base64">${Buffer.from(name, "utf8").toString("base64")}</Name>` : `<Name>${xmlEscape(name)}</Name>`;
            return `<Blob>${label}<Properties><Creation-Time>Mon, 01 Jan 2026 00:00:00 GMT</Creation-Time><Content-Length>${blobs.get(name)?.length ?? 0}</Content-Length><Content-Type>application/octet-stream</Content-Type><BlobType>BlockBlob</BlobType></Properties></Blob>`;
          })
          .join("");
        const xml = `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="${state.url}${accountPath}/" ContainerName="${container}"><Prefix>${xmlEscape(wanted)}</Prefix><Blobs>${items}</Blobs>${next}</EnumerationResults>`;
        const answer = (): void => send(200, xml, "application/xml");
        if (state.listDelayMs > 0) setTimeout(answer, state.listDelayMs);
        else answer();
        return;
      }

      const name = url.pathname
        .slice(rooted.length + 1)
        .split("/")
        .map((segment) => decodeURIComponent(segment))
        .join("/");
      if (request.method === "GET") {
        const planned = failures.get(name);
        if (planned !== undefined && planned.times > 0) {
          planned.times--;
          return fail(planned.status, planned.code, "planned failure");
        }
        if (!allowed("r")) return denied();
        const found = blobs.get(name);
        if (found === undefined) return fail(404, "BlobNotFound", "The specified blob does not exist.");
        return send(200, found, "application/octet-stream", { "x-ms-blob-type": "BlockBlob" });
      }
      if (request.method === "PUT") {
        if (!allowed("w") && !allowed("c")) return denied();
        if (request.headers["x-ms-blob-type"] !== "BlockBlob") return fail(400, "MissingRequiredHeader", "x-ms-blob-type: BlockBlob is the only kind this fake takes.");
        if (request.headers["if-none-match"] === "*" && blobs.has(name)) return fail(409, "BlobAlreadyExists", "The specified blob already exists.");
        blobs.set(name, body);
        return send(201, "", "application/xml");
      }
      return fail(405, "UnsupportedHttpVerb", `The verb ${request.method ?? ""} is not supported.`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  return {
    url: `${state.url}${accountPath}`,
    container,
    blobs,
    requests,
    get pageSize() {
      return state.pageSize;
    },
    set pageSize(value: number) {
      state.pageSize = value;
    },
    get listDelayMs() {
      return state.listDelayMs;
    },
    set listDelayMs(value: number) {
      state.listDelayMs = value;
    },
    failNext: (name, status, code, times = 1) => {
      failures.set(name, { status, code, times });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
