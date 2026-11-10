import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, type S3ConnectionSettings } from "@spikedpunch/ripstream-core";
import {
  S3Client,
  S3Emitter,
  S3Error,
  S3Fetcher,
  S3PipesIterator,
  createEngineFromSettings,
  instanceCredentials,
  isTransientError,
  profileCredentials,
  staticCredentials,
  type FetchEmitTuple,
} from "../src/index.ts";
import { ACCESS_KEY, SECRET_KEY, fakeS3, type FakeS3 } from "./fixtures/fake-s3.ts";

/*
 * The S3 components (tikajs-68os.6.6), against a bucket in memory that checks each request's signature the way S3 does,
 * and against a fetch that records the URL a request is sent to. Not run against AWS or an S3-compatible service.
 */

const REGION = "us-east-1";

async function withBucket(run: (s3: FakeS3, connection: S3ConnectionSettings) => Promise<void>, options: { sessionToken?: string } = {}): Promise<void> {
  const s3 = await fakeS3("test-bucket", options);
  try {
    await run(s3, { region: REGION, bucket: "test-bucket", credentialsProvider: "key_secret", accessKey: ACCESS_KEY, secretKey: SECRET_KEY, endpoint: s3.url, pathStyle: true });
  } finally {
    await s3.close();
  }
}

const clientFor = (connection: S3ConnectionSettings, sessionToken?: string): S3Client =>
  new S3Client({
    region: connection.region,
    bucket: connection.bucket,
    credentials: async () => ({ accessKeyId: connection.accessKey ?? "", secretAccessKey: connection.secretKey ?? "", ...(sessionToken === undefined ? {} : { sessionToken }) }),
    pathStyle: true,
    ...(connection.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
  });

// ---- where a request goes ------------------------------------------------------------------------------------------

/** The URL and Host a client sends a request for, without a network. */
async function sentTo(options: Partial<ConstructorParameters<typeof S3Client>[0]>, key = "k"): Promise<{ url: string; authorization: string }> {
  let seen = { url: "", authorization: "" };
  const client = new S3Client({
    region: REGION,
    bucket: "my-bucket",
    credentials: staticCredentials(ACCESS_KEY, SECRET_KEY),
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen = { url, authorization: String((init.headers as Record<string, string>).authorization) };
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch,
    now: () => new Date("2026-01-02T03:04:05Z"),
    ...options,
  });
  await client.put(key, new Uint8Array(0));
  return seen;
}

test("AWS: virtual-hosted style on the region's endpoint; a bucket with a dot is path style, as the SDK does", async () => {
  assert.equal((await sentTo({})).url, "https://my-bucket.s3.us-east-1.amazonaws.com/k");
  assert.equal((await sentTo({ bucket: "my.bucket" })).url, "https://s3.us-east-1.amazonaws.com/my.bucket/k");
  assert.equal((await sentTo({ pathStyle: true })).url, "https://s3.us-east-1.amazonaws.com/my-bucket/k");
});

test("an endpoint: virtual-hosted (`bucket.host`) unless path style is asked for, a port kept", async () => {
  assert.equal((await sentTo({ endpoint: "http://minio.local:9000" })).url, "http://my-bucket.minio.local:9000/k");
  assert.equal((await sentTo({ endpoint: "http://minio.local:9000", pathStyle: true })).url, "http://minio.local:9000/my-bucket/k");
  assert.equal((await sentTo({ endpoint: "https://storage.example/base/", pathStyle: true })).url, "https://storage.example/base/my-bucket/k");
});

test("a key is percent-encoded once, `/` kept: spaces, non-ASCII, `?` and `#`", async () => {
  assert.equal((await sentTo({}, "dir/a b/ü?#+.txt")).url, "https://my-bucket.s3.us-east-1.amazonaws.com/dir/a%20b/%C3%BC%3F%23%2B.txt");
});

test("the signature names the region, the service and the day of the clock", async () => {
  const { authorization } = await sentTo({});
  assert.match(authorization, new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/20260102/us-east-1/s3/aws4_request, SignedHeaders=`));
});

// ---- the client against a bucket that checks signatures ------------------------------------------------------------

test("a PUT then a GET round-trips bytes, with keys that need encoding, and the bucket verified every signature", async () => {
  await withBucket(async (s3, connection) => {
    const client = clientFor(connection);
    const key = "dir one/ünï?#+&=%.bin";
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await client.put(key, bytes);
    assert.deepEqual([...(s3.objects.get(key) ?? [])], [...bytes]);
    assert.deepEqual([...(await client.get(key))], [...bytes]);
    assert.equal(s3.requests.length, 2);
  });
});

test("a missing object is an S3Error with the status and the code of the body", async () => {
  await withBucket(async (_s3, connection) => {
    const error = await clientFor(connection).get("nope").catch((caught: unknown) => caught);
    assert.ok(error instanceof S3Error);
    assert.equal(error.status, 404);
    assert.equal(error.code, "NoSuchKey");
    assert.match(error.message, /NoSuchKey: The specified key does not exist/);
    assert.equal(isTransientError(error), false, "a missing key is the same on the next try");
  });
});

test("wrong credentials are a 403 the bucket gives, and a 5xx is the kind a retry may help", async () => {
  await withBucket(async (s3, connection) => {
    const wrong = clientFor({ ...connection, secretKey: "not-the-secret" });
    const denied = await wrong.get("a").catch((caught: unknown) => caught);
    assert.ok(denied instanceof S3Error);
    assert.equal(denied.code, "SignatureDoesNotMatch");
    s3.objects.set("a", Buffer.from("x"));
    s3.failNext("a", 503, "SlowDown");
    const busy = await clientFor(connection).get("a").catch((caught: unknown) => caught);
    assert.ok(busy instanceof S3Error);
    assert.equal(busy.status, 503);
    assert.equal(isTransientError(busy), true);
  });
});

test("temporary credentials send and sign x-amz-security-token", async () => {
  await withBucket(
    async (s3, connection) => {
      s3.objects.set("a", Buffer.from("payload"));
      assert.equal(Buffer.from(await clientFor(connection, "SESSION-TOKEN").get("a")).toString(), "payload");
      assert.equal(s3.requests[0]?.headers["x-amz-security-token"], "SESSION-TOKEN");
    },
    { sessionToken: "SESSION-TOKEN" },
  );
});

test("get refuses an object longer than maxLength before reading it", async () => {
  await withBucket(async (s3, connection) => {
    s3.objects.set("big", Buffer.alloc(1000));
    s3.objects.set("small", Buffer.alloc(10));
    const client = clientFor(connection);
    await assert.rejects(client.get("big", { maxLength: 100 }), /is 1000 bytes, over the maxLength of 100/);
    assert.equal((await client.get("small", { maxLength: 100 })).length, 10);
    assert.equal((await client.get("big", { maxLength: -1 })).length, 1000);
  });
});

test("list follows the continuation token across pages, decodes XML in keys, and filters by prefix", async () => {
  await withBucket(async (s3, connection) => {
    s3.pageSize = 2;
    for (const key of ["in/a.txt", "in/b&c.txt", "in/d<e>.txt", "in/f.txt", "in/g.txt", "out/h.txt"]) s3.objects.set(key, Buffer.from(key));
    const keys: string[] = [];
    for await (const key of clientFor(connection).list("in/")) keys.push(key);
    assert.deepEqual(keys, ["in/a.txt", "in/b&c.txt", "in/d<e>.txt", "in/f.txt", "in/g.txt"]);
    assert.equal(s3.requests.length, 3, "5 keys at 2 a page");
    const all: string[] = [];
    for await (const key of clientFor(connection).list(undefined)) all.push(key);
    assert.equal(all.length, 6);
  });
});

test("list of an empty bucket is empty, and a bucket that does not exist is an error", async () => {
  await withBucket(async (_s3, connection) => {
    const none: string[] = [];
    for await (const key of clientFor(connection).list("zzz")) none.push(key);
    assert.deepEqual(none, []);
    const missing = clientFor({ ...connection, bucket: "other-bucket" });
    await assert.rejects(
      (async () => {
        for await (const _ of missing.list(undefined)) void _;
      })(),
      /NoSuchBucket/,
    );
  });
});

// ---- the components ------------------------------------------------------------------------------------------------

test("S3Fetcher reads prefix + fetchKey, with no slash added", async () => {
  await withBucket(async (s3, connection) => {
    s3.objects.set("in/doc.txt", Buffer.from("hello"));
    const signal = new AbortController().signal;
    assert.equal(Buffer.from(await new S3Fetcher({ s3: connection, prefix: "in/" }).fetch("doc.txt", { signal })).toString(), "hello");
    assert.equal(Buffer.from(await new S3Fetcher({ s3: connection }).fetch("in/doc.txt", { signal })).toString(), "hello");
    assert.equal(Buffer.from(await new S3Fetcher({ s3: connection, prefix: "in" }).fetch("/doc.txt", { signal })).toString(), "hello");
    await assert.rejects(new S3Fetcher({ s3: connection, prefix: "in" }).fetch("doc.txt", { signal }), /NoSuchKey/, "`in` + `doc.txt` is `indoc.txt`: Tika adds no slash");
  });
});

test("S3Emitter writes prefix/emitKey.json: the metadata list for a document, content for CONTENT_ONLY, bytes as they are", async () => {
  await withBucket(async (s3, connection) => {
    const emitter = new S3Emitter({ s3: connection, prefix: "out", fileExtension: "json" });
    await emitter.emit({ id: "a.txt", mode: "CONCATENATE", metadata: { "Content-Type": "text/plain" }, text: "body" });
    await emitter.emit({ id: "b.txt", mode: "CONTENT_ONLY", text: "just content" });
    await emitter.emit({ id: "c.zip-embed/1", mode: "UNPACK", bytes: new Uint8Array([9, 8, 7]) });
    assert.deepEqual(JSON.parse(s3.objects.get("out/a.txt.json")?.toString() ?? ""), [{ "Content-Type": "text/plain", "tk:content": "body" }]);
    assert.equal(s3.objects.get("out/b.txt.json")?.toString(), "just content");
    assert.deepEqual([...(s3.objects.get("out/c.zip-embed/1.json") ?? [])], [9, 8, 7], "Tika puts the extension on a stream emit as well");
  });
});

test("S3Emitter with no prefix and a blank extension writes the key as it is", async () => {
  await withBucket(async (s3, connection) => {
    await new S3Emitter({ s3: connection, fileExtension: "" }).emit({ id: "x/y.bin", bytes: new Uint8Array([1]) });
    assert.ok(s3.objects.has("x/y.bin"));
  });
});

test("S3PipesIterator lists tuples, in listing order, for the fetcher and emitter it is given, and filters by file name", async () => {
  await withBucket(async (s3, connection) => {
    for (const key of ["docs/a.pdf", "docs/b.txt", "docs/sub/c.pdf", "other/d.pdf"]) s3.objects.set(key, Buffer.from("x"));
    const tuples: FetchEmitTuple[] = [];
    for await (const tuple of new S3PipesIterator({ s3: connection, prefix: "docs/", fileNamePattern: "\\.pdf$", fetcherId: "f", emitterId: "e" })) tuples.push(tuple);
    assert.deepEqual(tuples, [
      { id: "docs/a.pdf", fetcher: "f", fetchKey: "docs/a.pdf", emitter: "e", emitKey: "docs/a.pdf" },
      { id: "docs/sub/c.pdf", fetcher: "f", fetchKey: "docs/sub/c.pdf", emitter: "e", emitKey: "docs/sub/c.pdf" },
    ]);
    const pattern: string[] = [];
    for await (const tuple of new S3PipesIterator({ s3: connection, fileNamePattern: "^docs", fetcherId: "f" })) pattern.push(tuple.id);
    assert.deepEqual(pattern, [], "the pattern is matched against the file name, not the whole key");
  });
});

// ---- a configuration, end to end -----------------------------------------------------------------------------------

test("the iterator lists whole keys, so a fetcher prefix on top of an iterator prefix doubles it, as in Tika", async () => {
  await withBucket(async (s3, connection) => {
    s3.objects.set("in/one.txt", Buffer.from("first document"));
    s3.objects.set("in/two.txt", Buffer.from("second document"));
    const common = { region: REGION, bucket: connection.bucket, credentialsProvider: "key_secret", accessKey: ACCESS_KEY, secretKey: SECRET_KEY, endpointConfigurationService: s3.url, pathStyleAccessEnabled: true };
    const config = loadConfig({
      fetchers: { src: { "s3-fetcher": { ...common, prefix: "in/" } } },
      emitters: { dst: { "s3-emitter": { ...common, prefix: "out/", fileExtension: "json" } } },
      "pipes-iterator": { "s3-pipes-iterator": { ...common, prefix: "in/", fetcherId: "src", emitterId: "dst" } },
      pipes: { parseMode: "RMETA" },
    });
    const engine = createEngineFromSettings(config.pipes!);
    await engine.run();
    // The iterator lists `in/one.txt` and the fetcher puts its own prefix in front of that, as Tika's does: `in/in/one.txt` is not there.
    assert.equal(engine.stats.fetched, 2);
    assert.equal(engine.stats.failed, 2, "the fetcher's prefix doubled: the operator's to fix, as in Tika");
    assert.deepEqual(engine.stats.byStatus, { FETCH_EXCEPTION: 2 });
  });
});

test("the same configuration without a fetcher prefix parses each object and writes its metadata list under the emitter's prefix", async () => {
  await withBucket(async (s3, connection) => {
    s3.objects.set("in/one.txt", Buffer.from("first document"));
    s3.objects.set("in/two.txt", Buffer.from("second document"));
    const common = { region: REGION, bucket: connection.bucket, credentialsProvider: "key_secret", accessKey: ACCESS_KEY, secretKey: SECRET_KEY, endpointConfigurationService: s3.url, pathStyleAccessEnabled: true };
    const settings = loadConfig({
      fetchers: { src: { "s3-fetcher": common } },
      emitters: { dst: { "s3-emitter": { ...common, prefix: "out/", fileExtension: "json" } } },
      "pipes-iterator": { "s3-pipes-iterator": { ...common, prefix: "in/", fetcherId: "src", emitterId: "dst" } },
      pipes: { parseMode: "RMETA" },
    }).pipes!;
    const engine = createEngineFromSettings(settings);
    await engine.run();
    assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 2 });
    const written = [...s3.objects.keys()].filter((key) => key.startsWith("out/")).sort();
    assert.deepEqual(written, ["out/in/one.txt.json", "out/in/two.txt.json"], "prefix/emitKey.fileExtension; the emitter adds the slash itself, so `out/` is `out`");
    const list = JSON.parse(s3.objects.get("out/in/two.txt.json")?.toString() ?? "[]") as Array<Record<string, string>>;
    assert.match(list[0]?.["tk:content"] ?? "", /second document/);
  });
});

test("a transient 503 from the bucket is tried again by the engine's retry, and a missing key is not", async () => {
  await withBucket(async (s3, connection) => {
    s3.objects.set("a.txt", Buffer.from("alpha"));
    s3.failNext("a.txt", 503, "SlowDown", 1);
    const settings = loadConfig({
      fetchers: { src: { "s3-fetcher": { region: REGION, bucket: connection.bucket, credentialsProvider: "key_secret", accessKey: ACCESS_KEY, secretKey: SECRET_KEY, endpointConfigurationService: s3.url, pathStyleAccessEnabled: true } } },
      emitters: { dst: { "s3-emitter": { region: REGION, bucket: connection.bucket, credentialsProvider: "key_secret", accessKey: ACCESS_KEY, secretKey: SECRET_KEY, endpointConfigurationService: s3.url, pathStyleAccessEnabled: true, prefix: "out" } } },
      pipes: { parseMode: "RMETA" },
    }).pipes!;
    const iterator = (async function* (): AsyncGenerator<FetchEmitTuple> {
      yield { id: "a.txt", fetcher: "src", fetchKey: "a.txt", emitter: "dst" };
      yield { id: "missing.txt", fetcher: "src", fetchKey: "missing.txt", emitter: "dst" };
    })();
    const engine = createEngineFromSettings(settings, { iterator, retry: { attempts: 3, baseDelayMs: 1 } });
    await engine.run();
    assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 1, FETCH_EXCEPTION: 1 });
    const gets = s3.requests.filter((request) => request.method === "GET" && request.url.endsWith("/a.txt")).length;
    assert.equal(gets, 2, "one 503 and the retry");
    const missing = s3.requests.filter((request) => request.url.endsWith("/missing.txt")).length;
    assert.equal(missing, 1, "NoSuchKey is not tried again");
  });
});

// ---- credentials ---------------------------------------------------------------------------------------------------

test("profileCredentials reads the shared credentials file, the config file as a fallback, and a session token", async () => {
  const home = mkdtempSync(join(tmpdir(), "ripstream-aws-"));
  try {
    const credentials = join(home, "credentials");
    const config = join(home, "config");
    writeFileSync(
      credentials,
      "# a comment\n[default]\naws_access_key_id = DEFAULTKEY\naws_secret_access_key = DEFAULTSECRET\n\n[work]\naws_access_key_id=WORKKEY\naws_secret_access_key=WORKSECRET\naws_session_token = WORKTOKEN\n",
    );
    writeFileSync(config, "[default]\nregion = us-west-2\n\n[profile onlyconfig]\naws_access_key_id = CFGKEY\naws_secret_access_key = CFGSECRET\n\n[profile role]\nrole_arn = arn:aws:iam::1:role/x\nsource_profile = work\n");
    const env = { AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_CONFIG_FILE: config };
    assert.deepEqual(await profileCredentials("work", { env })(), { accessKeyId: "WORKKEY", secretAccessKey: "WORKSECRET", sessionToken: "WORKTOKEN" });
    assert.deepEqual(await profileCredentials("default", { env })(), { accessKeyId: "DEFAULTKEY", secretAccessKey: "DEFAULTSECRET" });
    assert.deepEqual(await profileCredentials("onlyconfig", { env })(), { accessKeyId: "CFGKEY", secretAccessKey: "CFGSECRET" });
    await assert.rejects(profileCredentials("role", { env })(), /uses role_arn, which ripstream does not read/);
    await assert.rejects(profileCredentials("absent", { env })(), /has no aws_access_key_id and aws_secret_access_key/);
    await assert.rejects(profileCredentials("work", { env: { AWS_SHARED_CREDENTIALS_FILE: join(home, "nope"), AWS_CONFIG_FILE: join(home, "nope2") } })(), /has no aws_access_key_id/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("instanceCredentials asks IMDSv2 for a token, the role, and its credentials, keeps them until near expiry, and shares a refresh", async () => {
  const calls: string[] = [];
  let clock = new Date("2026-01-01T00:00:00Z");
  let issued = 0;
  const imds = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method ?? "GET"} ${path}`);
    const headers = init.headers as Record<string, string> | undefined;
    if (path === "/latest/api/token") return new Response("TOKEN-1", { status: 200 });
    if (headers?.["x-aws-ec2-metadata-token"] !== "TOKEN-1") return new Response("", { status: 401 });
    if (path === "/latest/meta-data/iam/security-credentials/") return new Response("my-role\n", { status: 200 });
    issued++;
    return new Response(
      JSON.stringify({ AccessKeyId: `AK${issued}`, SecretAccessKey: `SK${issued}`, Token: `TK${issued}`, Expiration: "2026-01-01T06:00:00Z" }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const provider = instanceCredentials({ fetchImpl: imds, now: () => clock, endpoint: "http://imds.test" });
  const [first, second] = await Promise.all([provider(), provider()]);
  assert.deepEqual(first, { accessKeyId: "AK1", secretAccessKey: "SK1", sessionToken: "TK1" });
  assert.equal(second, first, "two callers at once share one refresh");
  assert.deepEqual(calls, ["PUT /latest/api/token", "GET /latest/meta-data/iam/security-credentials/", "GET /latest/meta-data/iam/security-credentials/my-role"]);
  clock = new Date("2026-01-01T05:00:00Z");
  assert.equal((await provider()).accessKeyId, "AK1", "five hours in, an hour left: kept");
  clock = new Date("2026-01-01T05:56:00Z");
  assert.equal((await provider()).accessKeyId, "AK2", "within five minutes of expiry: replaced");
});

test("instanceCredentials says what failed: no role, or a refusal from the service", async () => {
  const none = (async (url: string) => (new URL(url).pathname === "/latest/api/token" ? new Response("T") : new Response("", { status: 200 }))) as unknown as typeof fetch;
  await assert.rejects(instanceCredentials({ fetchImpl: none, endpoint: "http://imds.test" })(), /no IAM role/);
  const refused = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(instanceCredentials({ fetchImpl: refused, endpoint: "http://imds.test" })(), /answered 403 for \/latest\/api\/token/);
});
