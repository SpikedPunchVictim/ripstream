import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * A search service's `_bulk` endpoint, over HTTP: it records each request whole and answers what the test says (by default
 * the success body Elasticsearch and OpenSearch give). It does not index anything: what a test checks is what was sent.
 */

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

export interface FakeSearch {
  readonly url: string;
  readonly requests: Recorded[];
  /** The next requests are answered with this status and body (one request, or `times`). */
  answer(status: number, body: string, times?: number): void;
  /** Every `_bulk` body the service received, as the lines of newline-delimited JSON. */
  lines(): unknown[][];
  close(): Promise<void>;
}

const OK = JSON.stringify({ took: 1, errors: false, items: [] });

export async function fakeSearch(): Promise<FakeSearch> {
  const requests: Recorded[] = [];
  const planned: Array<{ status: number; body: string }> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      const next = planned.shift() ?? { status: 200, body: OK };
      response.writeHead(next.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(next.body)) });
      response.end(next.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    answer: (status, body, times = 1) => {
      for (let count = 0; count < times; count++) planned.push({ status, body });
    },
    lines: () => requests.map((request) => request.body.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as unknown)),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
