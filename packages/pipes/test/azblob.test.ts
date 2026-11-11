import assert from "node:assert/strict";
import { test } from "node:test";
import type { AzBlobConnectionSettings } from "@spikedpunch/ripstream-core";
import {
  AzBlobClient,
  AzBlobEmitter,
  AzBlobError,
  AzBlobFetcher,
  AzBlobPipesIterator,
  isTransientError,
  type FetchEmitTuple,
} from "../src/index.ts";
import { fakeAzureBlob, type FakeAzureBlob } from "./fixtures/fake-azure-blob.ts";

/*
 * The Azure Blob components (tikajs-68os.32), against a Blob service in memory that answers Get Blob, Put Blob and List
 * Blobs the way the REST API does and refuses a request whose SAS token is not the one it was given, parameter for
 * parameter, or lacks the permission (`sp`) the call needs. Not run against Azure Blob Storage or Azurite.
 */

// The shape of a service SAS as the portal gives it: percent-encoded, with a signature that has +, / and = in it.
const SAS = "sv=2022-11-02&ss=b&srt=sco&sp=rwlc&se=2031-01-01T00%3A00%3A00Z&sig=ab%2Bc%2Fd%3D%3D";
const READ_ONLY_SAS = "sv=2022-11-02&sr=c&sp=rl&sig=cd%2Be%2Ff%3D";
const signal = new AbortController().signal;

async function withAzure(run: (azure: FakeAzureBlob, connection: AzBlobConnectionSettings) => Promise<void>, options: { sas?: string; accountPath?: string } = {}): Promise<void> {
  const sas = options.sas ?? SAS;
  const azure = await fakeAzureBlob("docs", { sas, ...(options.accountPath === undefined ? {} : { accountPath: options.accountPath }) });
  try {
    await run(azure, { endpoint: azure.url, container: azure.container, sasToken: sas });
  } finally {
    await azure.close();
  }
}

const clientFor = (connection: AzBlobConnectionSettings): AzBlobClient => new AzBlobClient(connection);

test("a blob with an awkward name is put and read back, and the SAS token reaches the service as it was pasted", async () => {
  await withAzure(async (azure, connection) => {
    const client = clientFor(connection);
    for (const name of ["plain.txt", "dir/sub dir/a+b.txt", "ünï/日本語.pdf", "q?x=1#frag&y.bin", "100%/done.txt", "a//b.txt", "a b"]) {
      await client.put(name, new TextEncoder().encode(`body of ${name}`));
      assert.equal(azure.blobs.get(name)?.toString(), `body of ${name}`);
      assert.equal(Buffer.from(await client.get(name)).toString(), `body of ${name}`);
    }
    for (const request of azure.requests) {
      assert.ok(request.url.endsWith(`&${SAS}`) || request.url.includes(`?${SAS}`), `the token is appended as it is: ${request.url}`);
      assert.match(String(request.headers["x-ms-version"]), /^\d{4}-\d\d-\d\d$/);
    }
  });
});

test("a leading ? on the token, as the portal gives it, is dropped", async () => {
  await withAzure(async (azure, connection) => {
    const client = clientFor({ ...connection, sasToken: `?${SAS}` });
    await client.put("a.txt", new Uint8Array([1]));
    assert.ok(azure.blobs.has("a.txt"));
    assert.ok(!azure.requests[0]?.url.includes("??"), "one ? only");
  });
});

test("an endpoint with a path, as Azurite has, is kept, and a trailing slash on it is not doubled", async () => {
  await withAzure(
    async (azure, connection) => {
      const client = clientFor({ ...connection, endpoint: `${connection.endpoint}/` });
      await client.put("a/b.txt", new Uint8Array([7]));
      assert.deepEqual([...(await client.get("a/b.txt"))], [7]);
      assert.match(azure.requests[0]?.url ?? "", /^\/devstoreaccount1\/docs\/a\/b\.txt\?/);
    },
    { accountPath: "/devstoreaccount1" },
  );
});

test("a token that is not the service's is an AuthenticationFailed with the status, and the message does not carry the token", async () => {
  await withAzure(async (_azure, connection) => {
    const client = clientFor({ ...connection, sasToken: SAS.replace("sig=ab%2Bc", "sig=zz%2Bc") });
    const error = (await client.get("a").catch((caught: unknown) => caught)) as AzBlobError;
    assert.ok(error instanceof AzBlobError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "AuthenticationFailed");
    assert.match(error.message, /^Azure Blob GET 403 AuthenticationFailed: Server failed to authenticate/);
    assert.ok(!error.message.includes("zz"), "no token in the message");
    assert.ok(!error.message.includes("RequestId"), "the message is the first line only");
    assert.equal(isTransientError(error), false);
  });
});

test("a token without the permission the call needs is an AuthorizationPermissionMismatch", async () => {
  await withAzure(
    async (azure, connection) => {
      azure.blobs.set("a", Buffer.from("x"));
      const client = clientFor(connection);
      assert.equal(Buffer.from(await client.get("a")).toString(), "x", "r is there");
      await assert.rejects(client.put("b", new Uint8Array([1])), (error: unknown) => error instanceof AzBlobError && error.status === 403 && error.code === "AuthorizationPermissionMismatch");
      assert.ok(!azure.blobs.has("b"));
    },
    { sas: READ_ONLY_SAS },
  );
});

test("a blob that is not there is a 404 BlobNotFound, a container that is not there a 404 ContainerNotFound, and neither is transient", async () => {
  await withAzure(async (_azure, connection) => {
    const missing = (await clientFor(connection).get("nope").catch((caught: unknown) => caught)) as AzBlobError;
    assert.equal(missing.message, "Azure Blob GET 404 BlobNotFound: The specified blob does not exist.");
    assert.equal(isTransientError(missing), false);
    const nowhere = (await clientFor({ ...connection, container: "elsewhere" }).get("a").catch((caught: unknown) => caught)) as AzBlobError;
    assert.equal(nowhere.code, "ContainerNotFound");
    await assert.rejects(Array.fromAsync(clientFor({ ...connection, container: "elsewhere" }).list(undefined)), /Azure Blob GET 404 ContainerNotFound/);
  });
});

test("a 503 ServerBusy and a 500 are the kind a retry may help", async () => {
  await withAzure(async (azure, connection) => {
    azure.blobs.set("a", Buffer.from("x"));
    azure.failNext("a", 503, "ServerBusy");
    const busy = (await clientFor(connection).get("a").catch((caught: unknown) => caught)) as AzBlobError;
    assert.equal(busy.status, 503);
    assert.equal(busy.code, "ServerBusy");
    assert.equal(isTransientError(busy), true);
    azure.failNext("a", 500, "InternalError");
    assert.equal(isTransientError(await clientFor(connection).get("a").catch((caught: unknown) => caught)), true);
    assert.equal(Buffer.from(await clientFor(connection).get("a")).toString(), "x", "the planned failures are used up");
  });
});

test("a put without overwrite sends If-None-Match: * and a second put is a 409 BlobAlreadyExists; with overwrite it replaces", async () => {
  await withAzure(async (azure, connection) => {
    const client = clientFor(connection);
    await client.put("a", new Uint8Array([1]), { overwrite: false });
    assert.equal(azure.requests[0]?.headers["if-none-match"], "*");
    assert.equal(azure.requests[0]?.headers["x-ms-blob-type"], "BlockBlob");
    assert.equal(azure.requests[0]?.headers["content-length"], "1");
    const error = (await client.put("a", new Uint8Array([2]), { overwrite: false }).catch((caught: unknown) => caught)) as AzBlobError;
    assert.equal(error.status, 409);
    assert.equal(error.code, "BlobAlreadyExists");
    assert.equal(isTransientError(error), false);
    assert.deepEqual([...(azure.blobs.get("a") ?? [])], [1], "the first blob is kept");
    await client.put("a", new Uint8Array([3]), { overwrite: true });
    assert.equal(azure.requests.at(-1)?.headers["if-none-match"], undefined);
    assert.deepEqual([...(azure.blobs.get("a") ?? [])], [3]);
  });
});

test("an empty body is a put of 0 bytes, which a list then shows as size 0", async () => {
  await withAzure(async (azure, connection) => {
    await clientFor(connection).put("empty", new Uint8Array(0));
    assert.equal(azure.blobs.get("empty")?.length, 0);
    assert.deepEqual(await Array.fromAsync(clientFor(connection).list(undefined)), [{ name: "empty", size: 0 }]);
  });
});

test("list pages by marker, filters by prefix, reads the sizes, and decodes the XML in the names", async () => {
  await withAzure(async (azure, connection) => {
    azure.pageSize = 2;
    const names = ["a&b<c>.txt", "docs/1.pdf", "docs/2.pdf", "docs/3 +x.pdf", "docs/4.pdf", "other/5.pdf", "zz\u0001ctl.bin"];
    for (const name of names) azure.blobs.set(name, Buffer.from(name));
    const all = await Array.fromAsync(clientFor(connection).list(undefined));
    assert.deepEqual(all.map((blob) => blob.name), [...names].sort());
    assert.ok(all.every((blob) => blob.size === Buffer.byteLength(blob.name)));
    assert.equal(azure.requests.length, 4, "7 blobs at 2 a page are 4 requests");
    assert.ok(azure.requests.slice(1).every((request) => request.url.includes("marker=")), "the marker is sent back");
    assert.ok(azure.requests[1]?.url.includes("marker=2!8!MDA%2B%2F9%3D%3D"), "the + / = of the marker are encoded");
    const docs = await Array.fromAsync(clientFor(connection).list("docs/"));
    assert.deepEqual(docs.map((blob) => blob.name), ["docs/1.pdf", "docs/2.pdf", "docs/3 +x.pdf", "docs/4.pdf"]);
  });
});

test("a blob name the service sends base64 encoded, as for a character XML cannot carry, is decoded", async () => {
  await withAzure(async (azure, connection) => {
    azure.blobs.set("zz\u0001ctl.bin", Buffer.from("x"));
    assert.deepEqual(await Array.fromAsync(clientFor(connection).list(undefined)), [{ name: "zz\u0001ctl.bin", size: 1 }]);
    assert.equal(Buffer.from(await clientFor(connection).get("zz\u0001ctl.bin")).toString(), "x");
  });
});

test("a list that takes longer than the timeout fails with a message that names it", async () => {
  await withAzure(async (azure, connection) => {
    azure.listDelayMs = 400;
    await assert.rejects(Array.fromAsync(clientFor(connection).list(undefined, { timeoutMs: 40 })), /Azure Blob GET timed out after 40 ms/);
  });
});

test("a blob name a URL cannot carry, empty or a . or .. segment, is refused before any request", async () => {
  await withAzure(async (azure, connection) => {
    const client = clientFor(connection);
    for (const name of ["", "a/../b", "./a", "a/.."]) {
      await assert.rejects(client.get(name), /blob name (is empty|".*" has a "\." or "\.\." segment)/, JSON.stringify(name));
      await assert.rejects(client.put(name, new Uint8Array([1])), /blob name/);
    }
    assert.equal(azure.requests.length, 0);
  });
});

test("AzBlobFetcher reads the blob its fetch key names, with no prefix added", async () => {
  await withAzure(async (azure, connection) => {
    azure.blobs.set("in/doc.txt", Buffer.from("hello"));
    const fetcher = new AzBlobFetcher({ azure: connection });
    assert.equal(Buffer.from(await fetcher.fetch("in/doc.txt", { signal })).toString(), "hello");
    await assert.rejects(fetcher.fetch("doc.txt", { signal }), /Azure Blob GET 404 BlobNotFound/);
  });
});

test("AzBlobEmitter writes prefix/emitKey.json: the metadata list for a document, content for CONTENT_ONLY, bytes as they are", async () => {
  await withAzure(async (azure, connection) => {
    const emitter = new AzBlobEmitter({ azure: connection, prefix: "out", fileExtension: "json" });
    await emitter.emit({ id: "a.txt", mode: "CONCATENATE", metadata: { "Content-Type": "text/plain" }, text: "body" });
    await emitter.emit({ id: "b.txt", mode: "CONTENT_ONLY", text: "just content" });
    await emitter.emit({ id: "c.zip-embed/1", mode: "UNPACK", bytes: new Uint8Array([9, 8, 7]) });
    assert.deepEqual(JSON.parse(azure.blobs.get("out/a.txt.json")?.toString() ?? ""), [{ "Content-Type": "text/plain", "tk:content": "body" }]);
    assert.equal(azure.blobs.get("out/b.txt.json")?.toString(), "just content");
    assert.deepEqual([...(azure.blobs.get("out/c.zip-embed/1.json") ?? [])], [9, 8, 7], "Tika puts the extension on a stream emit as well");
  });
});

test("AzBlobEmitter with no prefix and a blank extension writes the key as it is, and refuses an empty metadata list as Tika does", async () => {
  await withAzure(async (azure, connection) => {
    const emitter = new AzBlobEmitter({ azure: connection, fileExtension: "" });
    await emitter.emit({ id: "x/y.bin", bytes: new Uint8Array([1]) });
    assert.ok(azure.blobs.has("x/y.bin"));
    await assert.rejects(emitter.emit({ id: "empty", mode: "RMETA", objects: [] }), /metadata list must not be null or empty/);
    assert.ok(!azure.blobs.has("empty"));
  });
});

test("AzBlobEmitter does not overwrite unless asked, as Tika's overwriteExisting false does", async () => {
  await withAzure(async (azure, connection) => {
    const keep = new AzBlobEmitter({ azure: connection, fileExtension: "" });
    await keep.emit({ id: "a", bytes: new Uint8Array([1]) });
    await assert.rejects(keep.emit({ id: "a", bytes: new Uint8Array([2]) }), /Azure Blob PUT 409 BlobAlreadyExists/);
    assert.deepEqual([...(azure.blobs.get("a") ?? [])], [1]);
    await new AzBlobEmitter({ azure: connection, fileExtension: "", overwriteExisting: true }).emit({ id: "a", bytes: new Uint8Array([3]) });
    assert.deepEqual([...(azure.blobs.get("a") ?? [])], [3]);
  });
});

async function tuplesOf(iterator: AzBlobPipesIterator): Promise<FetchEmitTuple[]> {
  const tuples: FetchEmitTuple[] = [];
  for await (const tuple of iterator) tuples.push(tuple);
  return tuples;
}

test("AzBlobPipesIterator lists a tuple for each blob under the prefix, in listing order, and skips a blob of 0 bytes as Tika does", async () => {
  await withAzure(async (azure, connection) => {
    azure.pageSize = 2;
    for (const name of ["docs/a.pdf", "docs/b.txt", "docs/sub", "docs/sub/c.pdf", "other/d.pdf"]) azure.blobs.set(name, name === "docs/sub" ? Buffer.alloc(0) : Buffer.from("x"));
    const found = await tuplesOf(new AzBlobPipesIterator({ azure: connection, prefix: "docs", fetcherId: "f", emitterId: "e" }));
    assert.deepEqual(found, [
      { id: "docs/a.pdf", fetcher: "f", fetchKey: "docs/a.pdf", emitter: "e", emitKey: "docs/a.pdf" },
      { id: "docs/b.txt", fetcher: "f", fetchKey: "docs/b.txt", emitter: "e", emitKey: "docs/b.txt" },
      { id: "docs/sub/c.pdf", fetcher: "f", fetchKey: "docs/sub/c.pdf", emitter: "e", emitKey: "docs/sub/c.pdf" },
    ]);
    const whole = await tuplesOf(new AzBlobPipesIterator({ azure: connection, fetcherId: "f" }));
    assert.equal(whole.length, 4, "no prefix: the whole container, and with no emitter id no emitter");
    assert.equal(whole[0]?.emitter, undefined);
  });
});

test("AzBlobPipesIterator drops one trailing slash from the prefix as Tika does, so docs/ also finds docs-old/", async () => {
  await withAzure(async (azure, connection) => {
    for (const name of ["docs/a.pdf", "docs-old/b.pdf", "other/c.pdf"]) azure.blobs.set(name, Buffer.from("x"));
    const found = await tuplesOf(new AzBlobPipesIterator({ azure: connection, prefix: "docs/", fetcherId: "f", emitterId: "e" }));
    assert.deepEqual(found.map((tuple) => tuple.id), ["docs-old/b.pdf", "docs/a.pdf"]);
    assert.ok(azure.requests[0]?.url.includes("prefix=docs&"), "prefix=docs, no slash");
  });
});

test("AzBlobPipesIterator gives its timeoutMillis to each list request, and a list that is slower ends the run", async () => {
  await withAzure(async (azure, connection) => {
    azure.blobs.set("a", Buffer.from("x"));
    azure.listDelayMs = 400;
    await assert.rejects(tuplesOf(new AzBlobPipesIterator({ azure: connection, fetcherId: "f", timeoutMillis: 40 })), /timed out after 40 ms/);
    azure.listDelayMs = 0;
    assert.equal((await tuplesOf(new AzBlobPipesIterator({ azure: connection, fetcherId: "f", timeoutMillis: 40 }))).length, 1);
  });
});

test("the container name is percent-encoded in the URL, as each segment of a blob name is", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response("x");
  }) as unknown as typeof fetch;
  const client = new AzBlobClient({ endpoint: "http://azure.test", container: "a/b?c", sasToken: "sig=1" }, { fetchImpl });
  await client.get("dir/a b.txt");
  assert.deepEqual(urls, ["http://azure.test/a%2Fb%3Fc/dir/a%20b.txt?sig=1"]);
});
