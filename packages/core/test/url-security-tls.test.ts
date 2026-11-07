import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { pinnedFetch } from "../src/pinned-fetch.ts";
import { UrlSecurityError, safeFetch } from "../src/index.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const cert = fixture("pinned-test.cert.pem");
const key = fixture("pinned-test.key.pem");
const LOOPBACK = [{ address: "127.0.0.1", family: 4 }];

async function listenTls(): Promise<{ server: Server; port: number; sni: string[] }> {
  const sni: string[] = [];
  const server = createServer({ key, cert, SNICallback: (name, cb) => { sni.push(name); cb(null, undefined); } },
    (req, res) => res.end(`host=${req.headers.host}`));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, sni };
}

test("pinnedFetch over HTTPS connects to the pinned IP, sends SNI/Host and verifies the original hostname", async () => {
  const { server, port, sni } = await listenTls();
  try {
    const res = await pinnedFetch(new URL(`https://pinned.test:${port}/`), {}, LOOPBACK, undefined, { ca: cert });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), `host=pinned.test:${port}`);
    assert.deepEqual(sni, ["pinned.test"]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("pinnedFetch over HTTPS fails when the certificate does not match the original hostname", async () => {
  const { server, port } = await listenTls();
  try {
    await assert.rejects(
      pinnedFetch(new URL(`https://other.test:${port}/`), {}, LOOPBACK, undefined, { ca: cert }),
      (e: NodeJS.ErrnoException) => e.code === "ERR_TLS_CERT_ALTNAME_INVALID",
    );
    // Without the trusted CA the self-signed cert is rejected too (verification is not disabled).
    await assert.rejects(pinnedFetch(new URL(`https://pinned.test:${port}/`), {}, LOOPBACK));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("safeFetch rejects a redirect to a loopback-resolving host before connecting to it", async () => {
  let hits = 0;
  const target = createHttpServer((_q, res) => { hits++; res.end("reached"); });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const port = (target.address() as AddressInfo).port;
  try {
    let hops = 0;
    const fetchImpl = (async () => {
      hops++;
      return new Response(null, { status: 302, headers: { location: `http://evil.example:${port}/` } });
    }) as typeof fetch;
    const lookupImpl = (async (host: string) =>
      host === "evil.example" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]) as never;
    await assert.rejects(
      safeFetch("http://public.example/", {}, { fetchImpl, lookupImpl }),
      UrlSecurityError,
    );
    assert.equal(hops, 1);
    assert.equal(hits, 0);
    // Same for a host resolving to the cloud metadata address.
    await assert.rejects(
      safeFetch("http://public.example/", {}, {
        fetchImpl: (async () => new Response(null, { status: 301, headers: { location: "http://metadata.example/" } })) as typeof fetch,
        lookupImpl: (async (host: string) =>
          host === "metadata.example" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]) as never,
      }),
      UrlSecurityError,
    );
  } finally {
    target.close();
  }
});
