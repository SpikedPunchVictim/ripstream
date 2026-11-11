import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * Apache Solr in memory, over HTTP, for one collection: the JSON update handler (`POST /solr/<collection>/update`, which
 * stores the documents it is given by their id) and `/select` with `cursorMark` the way Solr answers it (`q=*:*`, `fq` as
 * field:value, `sort`, `rows`, `fl`, `nextCursorMark` that is the cursor it was given once nothing is left). A cursor
 * without a sort that ends in the unique key is refused with a 400, as Solr refuses it. With `auth`, a request without
 * the right basic credentials is a 401.
 */

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

export interface FakeSolr {
  /** Solr's root, where a configuration's `solrUrls` point: `http://127.0.0.1:port/solr`. */
  readonly url: string;
  readonly collection: string;
  /** What `/select` searches, and what the update handler stores, by `id`. */
  readonly docs: Map<string, Record<string, unknown>>;
  readonly requests: Recorded[];
  /** The next requests are answered with this status and JSON body instead of being served. */
  answerNext(status: number, body: unknown, times?: number): void;
  /** How long an answer is held back, in ms. Default 0. */
  delayMs: number;
  close(): Promise<void>;
}

export interface FakeSolrOptions {
  readonly auth?: { readonly userName: string; readonly password: string };
}

const header = (status: number, extra: Record<string, unknown> = {}) => ({ responseHeader: { status, QTime: 1, ...extra } });
const compare = (left: unknown, right: unknown): number => (typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right)));

export async function fakeSolr(collection: string, options: FakeSolrOptions = {}): Promise<FakeSolr> {
  const docs = new Map<string, Record<string, unknown>>();
  const requests: Recorded[] = [];
  const planned: Array<{ status: number; body: unknown; times: number }> = [];
  const state = { delayMs: 0, url: "" };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      const send = (status: number, payload: unknown, extra: Record<string, string> = {}): void => {
        // A string is sent as it is, so that a test can answer with what is not JSON.
        const text = typeof payload === "string" ? payload : JSON.stringify(payload);
        const answer = (): void => {
          response.writeHead(status, { "content-type": "application/json;charset=utf-8", "content-length": String(Buffer.byteLength(text)), ...extra });
          response.end(text);
        };
        if (state.delayMs > 0) setTimeout(answer, state.delayMs);
        else answer();
      };
      const fail = (status: number, msg: string, extra: Record<string, string> = {}): void => send(status, { ...header(status), error: { msg, code: status } }, extra);

      if (options.auth !== undefined) {
        const expected = `Basic ${Buffer.from(`${options.auth.userName}:${options.auth.password}`, "utf8").toString("base64")}`;
        if (request.headers.authorization !== expected) return fail(401, "require authentication", { "www-authenticate": 'Basic realm="solr"' });
      }
      const next = planned[0];
      if (next !== undefined) {
        next.times--;
        if (next.times <= 0) planned.shift();
        return send(next.status, next.body);
      }

      const url = new URL(request.url ?? "/", "http://fake");
      const root = `/solr/${collection}`;
      if (!url.pathname.startsWith(`${root}/`)) return fail(404, `Cannot find collection '${url.pathname.split("/")[2] ?? ""}'`);

      if (request.method === "POST" && url.pathname === `${root}/update`) {
        if (!String(request.headers["content-type"]).startsWith("application/json")) return fail(415, `Unsupported Media Type: ${String(request.headers["content-type"])}`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return fail(400, "Cannot parse the JSON body");
        }
        if (!Array.isArray(parsed)) return fail(400, "this fake takes a JSON array of documents");
        for (const doc of parsed as Array<Record<string, unknown>>) docs.set(String(doc.id), doc);
        return send(200, header(0));
      }

      if (request.method === "GET" && url.pathname === `${root}/select`) {
        const cursor = url.searchParams.get("cursorMark");
        const sort = (url.searchParams.get("sort") ?? "").split(",").filter((clause) => clause !== "").map((clause) => clause.trim().split(/\s+/));
        if (url.searchParams.get("q") !== "*:*") return fail(400, "this fake answers q=*:* only");
        if (cursor === null) return fail(400, "this fake is asked with a cursorMark");
        if (!sort.some(([name]) => name === "id")) return fail(400, "Cursor functionality requires a sort containing a uniqueKey field tie breaker");
        const rows = Number(url.searchParams.get("rows") ?? "10");
        const filters = url.searchParams.getAll("fq").map((query) => {
          const [field = "", ...rest] = query.split(":");
          return [field, rest.join(":").replace(/^"(.*)"$/, "$1")] as const;
        });
        const fields = (url.searchParams.get("fl") ?? "").split(",").filter((field) => field !== "");
        const found = [...docs.values()]
          .filter((doc) => filters.every(([field, value]) => String(doc[field]) === value))
          .sort((left, right) => {
            for (const [name = "", direction = "asc"] of sort) {
              const order = compare(left[name], right[name]);
              if (order !== 0) return direction === "desc" ? -order : order;
            }
            return 0;
          });
        const start = cursor === "*" ? 0 : Number(/^c(\d+)$/.exec(cursor)?.[1] ?? Number.NaN);
        if (Number.isNaN(start)) return fail(400, `Unable to parse 'cursorMark' after the mark: ${cursor}`);
        const page = found.slice(start, start + rows).map((doc) => (fields.length === 0 ? doc : Object.fromEntries(fields.filter((field) => field in doc).map((field) => [field, doc[field]]))));
        return send(200, { ...header(0), response: { numFound: found.length, start: 0, numFoundExact: true, docs: page }, nextCursorMark: page.length === 0 ? cursor : `c${start + page.length}` });
      }
      return fail(405, `${request.method ?? ""} ${url.pathname} is not served`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}/solr`;
  return {
    url: state.url,
    collection,
    docs,
    requests,
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(value: number) {
      state.delayMs = value;
    },
    answerNext: (status, body, times = 1) => {
      planned.push({ status, body, times });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
