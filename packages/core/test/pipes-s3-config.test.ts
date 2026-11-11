import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, validateConfig, type S3EmitterSettings, type S3FetcherSettings, type S3IteratorSettings } from "../src/index.ts";

/*
 * Tika's s3-fetcher, s3-emitter and s3-pipes-iterator (tika-pipes-s3 4.2.0), as a configuration gives them
 * (tikajs-68os.6.6). The rules are those of S3FetcherConfig, S3EmitterConfig.validate() and S3PipesIterator's constructor.
 */

const KEYS = { region: "us-east-1", bucket: "b", credentialsProvider: "key_secret", accessKey: "AK", secretKey: "SK" };
const fetcher = (config: Record<string, unknown>) => ({ fetchers: { s: { "s3-fetcher": config } } });
const emitter = (config: Record<string, unknown>) => ({ emitters: { e: { "s3-emitter": config } } });
const iterator = (config: Record<string, unknown>) => ({
  fetchers: { f: { "s3-fetcher": KEYS } },
  emitters: { e: { "s3-emitter": KEYS } },
  "pipes-iterator": { "s3-pipes-iterator": { fetcherId: "f", emitterId: "e", ...config } },
});
const issues = (config: unknown): string[] => validateConfig(config);

test("an s3-fetcher with the minimum Tika needs: region and bucket, the instance role by default", () => {
  const settings = loadConfig(fetcher({ region: "eu-west-1", bucket: "docs" })).pipes?.fetchers[0] as S3FetcherSettings;
  assert.deepEqual(settings, { id: "s", type: "s3-fetcher", s3: { region: "eu-west-1", bucket: "docs", credentialsProvider: "instance", pathStyle: false } });
});

test("every setting of an s3-fetcher that ripstream applies is read", () => {
  const settings = loadConfig(
    fetcher({
      region: "us-east-1",
      bucket: "b",
      credentialsProvider: "profile",
      profile: "work",
      prefix: "in/",
      maxLength: 1000,
      endpointConfigurationService: "http://localhost:9000",
      pathStyleAccessEnabled: true,
    }),
  ).pipes?.fetchers[0] as S3FetcherSettings;
  assert.deepEqual(settings.s3, { region: "us-east-1", bucket: "b", credentialsProvider: "profile", profile: "work", endpoint: "http://localhost:9000", pathStyle: true });
  assert.equal(settings.prefix, "in/");
  assert.equal(settings.maxLength, 1000);
});

test("key_secret needs both keys, and profile needs a profile, as Tika says", () => {
  assert.deepEqual(issues(fetcher({ region: "r", bucket: "b", credentialsProvider: "key_secret", accessKey: "AK" })), [
    "fetchers.s.s3-fetcher.secretKey must be set when credentialsProvider is 'key_secret'",
  ]);
  assert.deepEqual(issues(fetcher({ region: "r", bucket: "b", credentialsProvider: "profile" })), [
    "fetchers.s.s3-fetcher.profile must be set when credentialsProvider is 'profile'",
  ]);
  assert.deepEqual(issues(fetcher({ region: "r", bucket: "b", credentialsProvider: "magic" })), [
    "fetchers.s.s3-fetcher.credentialsProvider must be 'profile', 'instance' or 'key_secret'",
  ]);
});

test("region and bucket are required", () => {
  assert.deepEqual(issues(fetcher({})), [
    "fetchers.s.s3-fetcher.bucket is required and must be a non-empty string",
    "fetchers.s.s3-fetcher.region is required and must be a non-empty string",
  ]);
  assert.match(issues(fetcher({ region: "r", bucket: "  " }))[0] ?? "", /bucket is required/);
});

test("an s3-emitter must name its credentialsProvider (Tika's validate()), and fileExtension is json unless set", () => {
  assert.deepEqual(issues(emitter({ region: "r", bucket: "b" })), ["emitters.e.s3-emitter.credentialsProvider must be set to 'profile', 'instance' or 'key_secret'"]);
  const defaults = loadConfig(emitter({ ...KEYS })).pipes?.emitters[0] as S3EmitterSettings;
  assert.equal(defaults.fileExtension, "json");
  assert.equal((loadConfig(emitter({ ...KEYS, fileExtension: "" })).pipes?.emitters[0] as S3EmitterSettings).fileExtension, undefined, "a blank extension is none");
  assert.equal((loadConfig(emitter({ ...KEYS, fileExtension: "ndjson" })).pipes?.emitters[0] as S3EmitterSettings).fileExtension, "ndjson");
});

test("an s3-emitter prefix loses one trailing slash, as normalizedPrefix does", () => {
  assert.equal((loadConfig(emitter({ ...KEYS, prefix: "out/" })).pipes?.emitters[0] as S3EmitterSettings).prefix, "out");
  assert.equal((loadConfig(emitter({ ...KEYS, prefix: "out" })).pipes?.emitters[0] as S3EmitterSettings).prefix, "out");
  assert.equal((loadConfig(emitter({ ...KEYS, prefix: "a//" })).pipes?.emitters[0] as S3EmitterSettings).prefix, "a/");
  assert.equal((loadConfig(emitter({ ...KEYS, prefix: "" })).pipes?.emitters[0] as S3EmitterSettings).prefix, undefined);
});

test("an s3-pipes-iterator names its fetcher and emitter, a prefix and a file name pattern", () => {
  const settings = loadConfig(iterator({ region: "r", bucket: "b", prefix: "in/", fileNamePattern: "\\.pdf$" })).pipes?.iterator as S3IteratorSettings;
  assert.equal(settings.type, "s3-pipes-iterator");
  assert.equal(settings.prefix, "in/");
  assert.equal(settings.fileNamePattern, "\\.pdf$");
  assert.equal(settings.fetcherId, "f");
  assert.equal(settings.emitterId, "e");
});

test("an s3-pipes-iterator's fetcher and emitter must be configured, and a pattern must compile", () => {
  assert.deepEqual(issues({ ...iterator({ region: "r", bucket: "b", fetcherId: "nope" }) }), ['pipes-iterator.s3-pipes-iterator.fetcherId "nope" is not in fetchers']);
  assert.deepEqual(issues(iterator({ region: "r", bucket: "b", fileNamePattern: "(" })), ["pipes-iterator.s3-pipes-iterator.fileNamePattern is not a regular expression ripstream can read"]);
  assert.match(issues(iterator({ region: "r", bucket: "b", fetcherId: "" }))[0] ?? "", /fetcherId is required/);
});

test("the endpoint must be an http or https URL", () => {
  for (const bad of ["not a url", "ftp://host", "s3://bucket", 5]) {
    assert.deepEqual(issues(fetcher({ region: "r", bucket: "b", endpointConfigurationService: bad })), ["fetchers.s.s3-fetcher.endpointConfigurationService must be an http or https URL"], String(bad));
  }
  assert.equal((loadConfig(fetcher({ region: "r", bucket: "b", endpointConfigurationService: "" })).pipes?.fetchers[0] as S3FetcherSettings).s3.endpoint, undefined, "blank is none, as Tika's isBlank");
});

test("a setting that changes nothing here is accepted and said so", () => {
  const config = loadConfig({
    ...fetcher({ region: "r", bucket: "b", maxConnections: 10, spoolToTemp: false, extractUserMetadata: true }),
    ...emitter({ ...KEYS, spoolToTemp: false }),
  });
  assert.equal(config.notices.length, 4, config.notices.join("\n"));
  assert.ok(config.notices.some((notice) => notice.includes("maxConnections") && notice.includes("changes nothing")));
  assert.ok(config.notices.some((notice) => notice.includes("extractUserMetadata") && notice.includes("no field is added")));
  assert.equal(config.notices.filter((notice) => notice.includes("spoolToTemp")).length, 2);
});

test("throttleSeconds is refused with where to go instead, and an unknown key is named", () => {
  assert.match(issues(fetcher({ region: "r", bucket: "b", throttleSeconds: [1, 2] }))[0] ?? "", /throttleSeconds sleeps between Tika's own retries.*--retry-attempts/);
  assert.match(issues(fetcher({ region: "r", bucket: "b", bogus: 1 }))[0] ?? "", /fetchers\.s\.s3-fetcher\.bogus is not a setting ripstream has/);
  assert.match(issues(emitter({ ...KEYS, prefixx: "x" }))[0] ?? "", /s3-emitter\.prefixx is not a setting/);
});

test("maxLength is -1 or more; the secret is never in a message", () => {
  assert.deepEqual(issues(fetcher({ region: "r", bucket: "b", maxLength: -2 })), ["fetchers.s.s3-fetcher.maxLength must be an integer, -1 (no limit) or more"]);
  assert.equal((loadConfig(fetcher({ region: "r", bucket: "b", maxLength: -1 })).pipes?.fetchers[0] as S3FetcherSettings).maxLength, undefined);
  const messages = issues(fetcher({ region: "r", bucket: "", credentialsProvider: "key_secret", accessKey: "AKIASECRETVALUE", secretKey: 5 })).join("\n");
  assert.ok(!messages.includes("AKIASECRETVALUE"));
});

test("components ripstream still lacks are named with what it has", () => {
  const messages = issues({ fetchers: { g: { "google-drive-fetcher": { bucket: "b" } } } });
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /google-drive-fetcher is not a fetcher ripstream has: .*file-system, http, S3, GCS and Azure Blob fetchers/);
});
