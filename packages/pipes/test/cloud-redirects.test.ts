import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AzBlobClient, GcsClient, SolrClient, metadataServerToken, serviceAccountToken } from "../src/index.ts";
import { postBulk } from "../src/search/bulk-client.ts";

/*
 * Every request of the GCS, Azure Blob, Solr and search components carries a credential (a bearer token, a SAS token, basic
 * authentication, an API key), so none of them follows a redirect: it would send the credential to a host the operator did not
 * name. Each is pointed at a server that answers every request with a 307 to a second server, which records what reaches it.
 */

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/** Runs with the URL of a server that redirects, and the requests (method, path and credentials) that reached its target. */
async function withRedirect(run: (redirecting: string, reached: string[]) => Promise<void>): Promise<void> {
  const reached: string[] = [];
  const target = createServer((request, response) => {
    reached.push(`${request.method} ${request.url} authorization=${request.headers.authorization ?? ""}`);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const targetUrl = await listen(target);
  const redirecting = createServer((request, response) => {
    response.writeHead(307, { location: `${targetUrl}${request.url}` }).end();
  });
  const redirectingUrl = await listen(redirecting);
  try {
    await run(redirectingUrl, reached);
  } finally {
    await close(redirecting);
    await close(target);
  }
}

const drain = async (items: AsyncIterable<unknown>): Promise<void> => {
  for await (const item of items) void item;
};

test("GCS: get, put and list do not follow a redirect with the bearer token", async () => {
  await withRedirect(async (endpoint, reached) => {
    const client = new GcsClient({ bucket: "docs", token: async () => "secret-token", endpoint });
    await assert.rejects(client.get("a.txt"));
    await assert.rejects(client.put("a.txt", new Uint8Array([1])));
    await assert.rejects(drain(client.list(undefined)));
    assert.deepEqual(reached, []);
  });
});

test("GCS: the token endpoint and the metadata server are not followed to another host either", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  await withRedirect(async (endpoint, reached) => {
    const signed = serviceAccountToken({ client_email: "svc@example.iam", private_key: privateKey, token_uri: `${endpoint}/token` }, { scope: "scope" });
    await assert.rejects(signed());
    await assert.rejects(metadataServerToken({ metadataEndpoint: endpoint })());
    assert.deepEqual(reached, []);
  });
});

test("Azure Blob: get, put and list do not follow a redirect with the SAS token", async () => {
  await withRedirect(async (endpoint, reached) => {
    const client = new AzBlobClient({ endpoint, container: "docs", sasToken: "sig=secret" });
    await assert.rejects(client.get("a.txt"));
    await assert.rejects(client.put("a.txt", new Uint8Array([1])));
    await assert.rejects(drain(client.list(undefined)));
    assert.deepEqual(reached, []);
  });
});

test("Solr: update and select do not follow a redirect with the basic credentials", async () => {
  await withRedirect(async (url, reached) => {
    const client = new SolrClient({ urls: [url], collection: "docs", userName: "user", password: "secret", socketTimeoutMillis: 5000 });
    await assert.rejects(client.update([{ id: "1" }], { commitWithin: 1000 }));
    await assert.rejects(client.select([["q", "*:*"]]));
    assert.deepEqual(reached, []);
  });
});

test("search: the _bulk request does not follow a redirect with the API key", async () => {
  await withRedirect(async (url, reached) => {
    await assert.rejects(postBulk({ fetchImpl: fetch, label: "es-emitter", url: `${url}/index`, authorization: "ApiKey secret", socketTimeoutMillis: undefined, body: "{}\n" }));
    assert.deepEqual(reached, []);
  });
});
