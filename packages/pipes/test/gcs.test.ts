import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GcsConnectionSettings } from "@spikedpunch/ripstream-core";
import {
  GcsClient,
  GcsEmitter,
  GcsError,
  GcsFetcher,
  GcsPipesIterator,
  TokenError,
  applicationDefaultToken,
  isTransientError,
  metadataServerToken,
  parseServiceAccountKey,
  serviceAccountToken,
  type FetchEmitTuple,
  type ServiceAccountKey,
} from "../src/index.ts";
import { fakeGcs, type FakeGcs } from "./fixtures/fake-gcs.ts";

/*
 * The GCS components (tikajs-68os.31), against a Cloud Storage in memory that checks the service-account JWT's RS256
 * signature and claims the way Google's token endpoint does, and each storage request's token and scope. Not run against
 * Google Cloud Storage, Google's token endpoint or the metadata server.
 */

const READ_ONLY = "https://www.googleapis.com/auth/devstorage.read_only";
const READ_WRITE = "https://www.googleapis.com/auth/devstorage.read_write";
const CLIENT_EMAIL = "tika@my-project.iam.gserviceaccount.com";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

async function withGcs(run: (gcs: FakeGcs, key: ServiceAccountKey) => Promise<void>, options: { now?: () => number } = {}): Promise<void> {
  const gcs = await fakeGcs("test-bucket", { publicKey, clientEmail: CLIENT_EMAIL, ...options });
  try {
    await run(gcs, { client_email: CLIENT_EMAIL, private_key: PRIVATE_PEM, private_key_id: "kid-1", token_uri: gcs.tokenUrl });
  } finally {
    await gcs.close();
  }
}

const clientFor = (gcs: FakeGcs, key: ServiceAccountKey, scope = READ_WRITE): GcsClient =>
  new GcsClient({ bucket: gcs.bucket, endpoint: gcs.url, token: serviceAccountToken(key, { scope }) });

/** A key file on disk and the environment that points at it, for the application-default path. */
async function withKeyFile(run: (env: Record<string, string>, gcs: FakeGcs) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-gcs-"));
  try {
    await withGcs(async (gcs, key) => {
      const file = join(directory, "key.json");
      writeFileSync(file, JSON.stringify({ type: "service_account", ...key }));
      await run({ GOOGLE_APPLICATION_CREDENTIALS: file }, gcs);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const CONNECTION: GcsConnectionSettings = { projectId: "my-project", bucket: "test-bucket" };

// ---- service-account credentials -----------------------------------------------------------------------------------

test("a service account's token comes from an RS256 JWT of the key's id, issuer, scope and token_uri, and the token endpoint verified its signature", async () => {
  await withGcs(async (gcs, key) => {
    const token = await serviceAccountToken(key, { scope: READ_ONLY })();
    assert.match(token, /^ya29\.fake-/);
    assert.equal(gcs.assertions.length, 1, "the fake verified the signature before it issued a token");
    const { header, claims } = gcs.assertions[0]!;
    assert.deepEqual(header, { alg: "RS256", typ: "JWT", kid: "kid-1" });
    assert.equal(claims.iss, CLIENT_EMAIL);
    assert.equal(claims.scope, READ_ONLY);
    assert.equal(claims.aud, gcs.tokenUrl);
    assert.equal(Number(claims.exp) - Number(claims.iat), 3600);
  });
});

test("the token is kept until five minutes before it expires, and two callers at once share one exchange", async () => {
  let clock = Date.parse("2026-03-01T00:00:00Z");
  await withGcs(
    async (gcs, key) => {
      const token = serviceAccountToken(key, { scope: READ_ONLY, now: () => new Date(clock) });
      const [first, second] = await Promise.all([token(), token()]);
      assert.equal(first, second);
      assert.equal(gcs.assertions.length, 1);
      clock += 54 * 60_000;
      assert.equal(await token(), first, "54 minutes in, 6 left: kept");
      clock += 2 * 60_000;
      assert.notEqual(await token(), first, "within five minutes of the end: replaced");
      assert.equal(gcs.assertions.length, 2);
    },
    { now: () => clock },
  );
});

test("a signature by another key is refused by the token endpoint, and the error says what it answered", async () => {
  await withGcs(async (_gcs, key) => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    await assert.rejects(serviceAccountToken({ ...key, private_key: other }, { scope: READ_ONLY })(), /token endpoint \S+ answered 400.*Invalid JWT Signature/);
  });
});

test("a private key that is not a key is an error that names it, not an opaque crypto failure", async () => {
  await withGcs(async (_gcs, key) => {
    await assert.rejects(serviceAccountToken({ ...key, private_key: "not a pem" }, { scope: READ_ONLY })(), /private_key of the service account key .* could not sign/);
  });
});

test("parseServiceAccountKey names what is missing and what it does not read", () => {
  const good = { type: "service_account", client_email: CLIENT_EMAIL, private_key: PRIVATE_PEM };
  assert.deepEqual(parseServiceAccountKey(JSON.stringify(good), "key.json"), { client_email: CLIENT_EMAIL, private_key: PRIVATE_PEM, token_uri: "https://oauth2.googleapis.com/token" });
  assert.equal(parseServiceAccountKey(JSON.stringify({ ...good, private_key_id: "k", token_uri: "http://t" }), "key.json").private_key_id, "k");
  assert.throws(() => parseServiceAccountKey("{", "key.json"), /key\.json is not JSON/);
  assert.throws(() => parseServiceAccountKey("[]", "key.json"), /key\.json must be a JSON object/);
  assert.throws(() => parseServiceAccountKey(JSON.stringify({ ...good, client_email: undefined }), "key.json"), /key\.json has no client_email/);
  assert.throws(() => parseServiceAccountKey(JSON.stringify({ ...good, private_key: "" }), "key.json"), /key\.json has no private_key/);
  assert.throws(() => parseServiceAccountKey(JSON.stringify({ type: "authorized_user", client_id: "x" }), "key.json"), /type "authorized_user", which ripstream does not read: only "service_account"/);
  assert.throws(() => parseServiceAccountKey(JSON.stringify({ ...good, token_uri: "ftp://t" }), "key.json"), /token_uri must be an http or https URL/);
});

// ---- application-default credentials -------------------------------------------------------------------------------

test("application default credentials read the service account file GOOGLE_APPLICATION_CREDENTIALS names", async () => {
  await withKeyFile(async (env, gcs) => {
    const token = await applicationDefaultToken({ scope: READ_ONLY, env })();
    assert.match(token, /^ya29\.fake-/);
    assert.equal(gcs.assertions[0]?.claims.scope, READ_ONLY);
  });
});

test("without the variable, application default credentials come from the metadata server, which wants Metadata-Flavor: Google", async () => {
  await withGcs(async (gcs) => {
    const token = await applicationDefaultToken({ scope: READ_ONLY, env: {}, metadataEndpoint: gcs.url })();
    assert.match(token, /^ya29\.fake-/);
    const request = gcs.requests.find((entry) => entry.url.startsWith("/computeMetadata/"));
    assert.equal(request?.headers["metadata-flavor"], "Google");
    assert.equal(gcs.assertions.length, 0, "no JWT was made");
  });
});

test("GCE_METADATA_HOST names the metadata server, as Google's libraries read it", async () => {
  await withGcs(async (gcs) => {
    const host = new URL(gcs.url).host;
    assert.match(await metadataServerToken({ env: { GCE_METADATA_HOST: host } })(), /^ya29\.fake-/);
  });
});

test("application default credentials say what failed: a missing file, a user credential, an unreachable metadata server", async () => {
  await assert.rejects(applicationDefaultToken({ scope: READ_ONLY, env: { GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/key.json" } })(), /GOOGLE_APPLICATION_CREDENTIALS .*\/nonexistent\/key\.json/);
  const directory = mkdtempSync(join(tmpdir(), "ripstream-gcs-"));
  try {
    const file = join(directory, "user.json");
    writeFileSync(file, JSON.stringify({ type: "authorized_user", client_id: "x", client_secret: "y", refresh_token: "z" }));
    await assert.rejects(applicationDefaultToken({ scope: READ_ONLY, env: { GOOGLE_APPLICATION_CREDENTIALS: file } })(), /type "authorized_user", which ripstream does not read/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const refused = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(applicationDefaultToken({ scope: READ_ONLY, env: {}, fetchImpl: refused })(), /metadata server \S+ answered 404/);
});

// ---- the client against the storage API ----------------------------------------------------------------------------

test("a PUT then a GET round-trips bytes, with names that need encoding sent as one path segment, and the server checked every token", async () => {
  await withGcs(async (gcs, key) => {
    const client = clientFor(gcs, key);
    const name = "dir one/ünï?#+&=%.bin";
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await client.put(name, bytes);
    assert.deepEqual([...(gcs.objects.get(name) ?? [])], [...bytes]);
    assert.deepEqual([...(await client.get(name))], [...bytes]);
    const encoded = encodeURIComponent(name);
    assert.deepEqual(
      gcs.requests.filter((request) => request.url.includes("/o")).map((request) => `${request.method} ${request.url}`),
      [`POST /upload/storage/v1/b/test-bucket/o?uploadType=media&name=${encoded}`, `GET /storage/v1/b/test-bucket/o/${encoded}?alt=media`],
    );
    assert.equal(gcs.requests.find((request) => request.method === "POST" && request.url.startsWith("/upload"))?.headers["content-type"], "application/octet-stream");
  });
});

test("a missing object is a GcsError with the status and the reason of the body", async () => {
  await withGcs(async (gcs, key) => {
    const error = await clientFor(gcs, key).get("nope").catch((caught: unknown) => caught);
    assert.ok(error instanceof GcsError);
    assert.equal(error.status, 404);
    assert.equal(error.reason, "notFound");
    assert.equal(error.message, "GCS GET 404 notFound: No such object: test-bucket/nope");
    assert.equal(isTransientError(error), false, "a missing object is the same on the next try");
  });
});

test("a token the server does not know is a 401, a scope that cannot write is a 403, and a 503 is the kind a retry may help", async () => {
  await withGcs(async (gcs, key) => {
    const unknown = new GcsClient({ bucket: gcs.bucket, endpoint: gcs.url, token: async () => "not-a-token" });
    const denied = await unknown.get("a").catch((caught: unknown) => caught);
    assert.ok(denied instanceof GcsError);
    assert.equal(denied.status, 401);
    const readOnly = clientFor(gcs, key, READ_ONLY);
    await assert.rejects(readOnly.put("a", new Uint8Array(1)), /GCS POST 403 insufficientPermissions/);
    gcs.objects.set("a", Buffer.from("x"));
    gcs.failNext("a", 503, "backendError");
    const busy = await clientFor(gcs, key).get("a").catch((caught: unknown) => caught);
    assert.ok(busy instanceof GcsError);
    assert.equal(busy.status, 503);
    assert.equal(isTransientError(busy), true);
  });
});

test("list follows the page token, filters by prefix, and gives each object's size", async () => {
  await withGcs(async (gcs, key) => {
    gcs.pageSize = 2;
    for (const name of ["in/a.txt", "in/b&c.txt", "in/d<e>.txt", "in/f.txt", "in/g.txt", "out/h.txt"]) gcs.objects.set(name, Buffer.from(name));
    gcs.objects.set("in/empty/", Buffer.alloc(0));
    const listed: Array<{ name: string; size: number }> = [];
    for await (const object of clientFor(gcs, key).list("in/")) listed.push(object);
    assert.deepEqual(
      listed.map((object) => object.name),
      ["in/a.txt", "in/b&c.txt", "in/d<e>.txt", "in/empty/", "in/f.txt", "in/g.txt"],
    );
    assert.deepEqual(listed.find((object) => object.name === "in/a.txt"), { name: "in/a.txt", size: 8 });
    assert.equal(listed.find((object) => object.name === "in/empty/")?.size, 0);
    assert.equal(gcs.requests.filter((request) => request.url.startsWith("/storage/v1/b/test-bucket/o?")).length, 3, "6 objects at 2 a page");
    const all: string[] = [];
    for await (const object of clientFor(gcs, key).list(undefined)) all.push(object.name);
    assert.equal(all.length, 7);
  });
});

test("list of nothing is empty, and a bucket that does not exist is an error", async () => {
  await withGcs(async (gcs, key) => {
    const none: string[] = [];
    for await (const object of clientFor(gcs, key).list("zzz")) none.push(object.name);
    assert.deepEqual(none, []);
    const missing = new GcsClient({ bucket: "other-bucket", endpoint: gcs.url, token: serviceAccountToken(key, { scope: READ_ONLY }) });
    await assert.rejects(
      (async () => {
        for await (const _ of missing.list(undefined)) void _;
      })(),
      /GCS GET 404 notFound: The specified bucket does not exist/,
    );
  });
});

// ---- the components ------------------------------------------------------------------------------------------------

test("GcsFetcher reads the object its fetch key names, with no prefix added, and asks for a read-only scope", async () => {
  await withKeyFile(async (env, gcs) => {
    gcs.objects.set("in/doc.txt", Buffer.from("hello"));
    const fetcher = new GcsFetcher({ gcs: CONNECTION, transport: { env, endpoint: gcs.url } });
    const signal = new AbortController().signal;
    assert.equal(Buffer.from(await fetcher.fetch("in/doc.txt", { signal })).toString(), "hello");
    await assert.rejects(fetcher.fetch("doc.txt", { signal }), /GCS GET 404 notFound/);
    assert.equal(gcs.assertions[0]?.claims.scope, READ_ONLY);
  });
});

test("GcsEmitter writes prefix/emitKey.json: the metadata list for a document, content for CONTENT_ONLY, bytes as they are, and asks for a read-write scope", async () => {
  await withKeyFile(async (env, gcs) => {
    const emitter = new GcsEmitter({ gcs: CONNECTION, prefix: "out", fileExtension: "json", transport: { env, endpoint: gcs.url } });
    await emitter.emit({ id: "a.txt", mode: "CONCATENATE", metadata: { "Content-Type": "text/plain" }, text: "body" });
    await emitter.emit({ id: "b.txt", mode: "CONTENT_ONLY", text: "just content" });
    await emitter.emit({ id: "c.zip-embed/1", mode: "UNPACK", bytes: new Uint8Array([9, 8, 7]) });
    assert.deepEqual(JSON.parse(gcs.objects.get("out/a.txt.json")?.toString() ?? ""), [{ "Content-Type": "text/plain", "tk:content": "body" }]);
    assert.equal(gcs.objects.get("out/b.txt.json")?.toString(), "just content");
    assert.deepEqual([...(gcs.objects.get("out/c.zip-embed/1.json") ?? [])], [9, 8, 7], "Tika puts the extension on a stream emit as well");
    assert.equal(gcs.assertions[0]?.claims.scope, READ_WRITE);
  });
});

test("GcsEmitter with no prefix and a blank extension writes the key as it is, and refuses an empty metadata list as Tika does", async () => {
  await withKeyFile(async (env, gcs) => {
    const emitter = new GcsEmitter({ gcs: CONNECTION, fileExtension: "", transport: { env, endpoint: gcs.url } });
    await emitter.emit({ id: "x/y.bin", bytes: new Uint8Array([1]) });
    assert.ok(gcs.objects.has("x/y.bin"));
    await assert.rejects(emitter.emit({ id: "empty", mode: "RMETA", objects: [] }), /metadata list must not be null or empty/);
    assert.ok(!gcs.objects.has("empty"));
  });
});

test("GcsPipesIterator lists a tuple for each object under the prefix, in listing order, and skips an object of 0 bytes as Tika does", async () => {
  await withKeyFile(async (env, gcs) => {
    for (const name of ["docs/a.pdf", "docs/b.txt", "docs/sub/", "docs/sub/c.pdf", "other/d.pdf"]) gcs.objects.set(name, name.endsWith("/") ? Buffer.alloc(0) : Buffer.from("x"));
    const tuples: FetchEmitTuple[] = [];
    for await (const tuple of new GcsPipesIterator({ gcs: CONNECTION, prefix: "docs/", fetcherId: "f", emitterId: "e", transport: { env, endpoint: gcs.url } })) tuples.push(tuple);
    assert.deepEqual(tuples, [
      { id: "docs/a.pdf", fetcher: "f", fetchKey: "docs/a.pdf", emitter: "e", emitKey: "docs/a.pdf" },
      { id: "docs/b.txt", fetcher: "f", fetchKey: "docs/b.txt", emitter: "e", emitKey: "docs/b.txt" },
      { id: "docs/sub/c.pdf", fetcher: "f", fetchKey: "docs/sub/c.pdf", emitter: "e", emitKey: "docs/sub/c.pdf" },
    ]);
    const whole: string[] = [];
    for await (const tuple of new GcsPipesIterator({ gcs: CONNECTION, fetcherId: "f", transport: { env, endpoint: gcs.url } })) whole.push(tuple.id);
    assert.equal(whole.length, 4, "no prefix: the whole bucket, and with no emitter id no emitter");
  });
});

test("a token that cannot be had fails the fetch with the reason", async () => {
  const unavailable = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  const fetcher = new GcsFetcher({ gcs: CONNECTION, transport: { env: {}, fetchImpl: unavailable } });
  const error = await fetcher.fetch("a", { signal: new AbortController().signal }).catch((caught: unknown) => caught);
  assert.match(String((error as Error).message), /metadata server \S+ answered 503/);
});

test("a token endpoint's 503 is the kind a retry may help, and its 400 is not", () => {
  assert.equal(isTransientError(new TokenError("busy", 503)), true);
  assert.equal(isTransientError(new TokenError("bad grant", 400)), false);
  assert.equal(isTransientError(new TokenError("no status")), false);
});
