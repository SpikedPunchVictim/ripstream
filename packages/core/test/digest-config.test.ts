import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, validateConfig } from "../src/index.ts";

/*
 * The digester factories of a `parse-context` section (tikajs-68os.9.1), by the shapes Tika's own configurations use
 * (tika-parsers-standard-integration-tests: tika-config-digests.json, -skip-container.json, -bc-digests-*.json) and by
 * what Tika's CommonsDigester and Jackson refuse.
 */

const commons = (config: unknown) => ({ "parse-context": { "commons-digester-factory": config } });
const bouncy = (config: unknown) => ({ "parse-context": { "bouncy-castle-digester-factory": config } });
const issues = (config: unknown): string[] => validateConfig(config);

test("Tika's tika-config-digests.json: SHA256 as base32 and MD5", () => {
  const config = loadConfig(commons({ digests: [{ algorithm: "SHA256", encoding: "BASE32" }, { algorithm: "MD5" }] }));
  assert.deepEqual(config.digest, {
    digests: [{ algorithm: "SHA256", encoding: "BASE32" }, { algorithm: "MD5", encoding: "HEX" }],
    skipContainerDocumentDigest: false,
  });
});

test("Tika's tika-config-digests-skip-container.json", () => {
  const config = loadConfig(commons({ digests: [{ algorithm: "MD5" }], skipContainerDocumentDigest: true }));
  assert.equal(config.digest?.skipContainerDocumentDigest, true);
});

test("Tika's tika-config-bc-digests-multiple.json: the BouncyCastle factory has SHA3", () => {
  const config = loadConfig(bouncy({ digests: [{ algorithm: "MD5" }, { algorithm: "SHA256" }, { algorithm: "SHA3_512" }] }));
  assert.deepEqual(config.digest?.digests.map((def) => def.algorithm), ["MD5", "SHA256", "SHA3_512"]);
});

test("an empty factory is MD5 in hex, as Tika's factory is until it is told otherwise", () => {
  assert.deepEqual(loadConfig(commons({})).digest, { digests: [{ algorithm: "MD5", encoding: "HEX" }], skipContainerDocumentDigest: false });
  assert.deepEqual(loadConfig(bouncy({})).digest?.digests, [{ algorithm: "MD5", encoding: "HEX" }]);
});

test("no digester factory is no digest", () => {
  assert.equal(loadConfig({ "parse-context": { "embedded-limits": { maxDepth: 3, throwOnMaxDepth: true } } }).digest, null);
  assert.equal(loadConfig({}).digest, null);
});

test("an empty digests list is accepted: it makes none", () => {
  assert.deepEqual(loadConfig(commons({ digests: [] })).digest?.digests, []);
});

test("an enum is read in any case, as Tika's mapper reads it", () => {
  assert.deepEqual(loadConfig(commons({ digests: [{ algorithm: "sha256", encoding: "base64" }] })).digest?.digests, [{ algorithm: "SHA256", encoding: "BASE64" }]);
});

test("two entries for one key keep one", () => {
  const digests = loadConfig(commons({ digests: [{ algorithm: "MD5" }, { algorithm: "SHA1" }, { algorithm: "md5", encoding: "HEX" }, { algorithm: "MD5", encoding: "BASE64" }] })).digest?.digests;
  assert.deepEqual(digests, [
    { algorithm: "MD5", encoding: "HEX" },
    { algorithm: "SHA1", encoding: "HEX" },
    { algorithm: "MD5", encoding: "BASE64" },
  ]);
});

test("the Commons factory refuses SHA3 as Tika's CommonsDigester does, and says where to go", () => {
  for (const algorithm of ["SHA3_256", "SHA3_384", "SHA3_512"]) {
    assert.match(issues(commons({ digests: [{ algorithm }] }))[0] ?? "", /not an algorithm of commons-digester-factory.*use bouncy-castle-digester-factory/);
  }
});

test("an algorithm is named as the configuration names it, not as the key does", () => {
  assert.match(issues(commons({ digests: [{ algorithm: "SHA-256" }] }))[0] ?? "", /algorithm "SHA-256" is not one of MD2, MD5, SHA1, SHA256.*SHA256, not SHA-256/);
  assert.match(issues(commons({ digests: [{ encoding: "HEX" }] }))[0] ?? "", /digests\[0\]: algorithm is required/);
  assert.match(issues(commons({ digests: [{ algorithm: "MD5", encoding: "BASE16" }] }))[0] ?? "", /encoding "BASE16" is not one of HEX, BASE32, BASE64/);
});

test("an unknown setting is refused, as Tika's mapper refuses it", () => {
  assert.match(issues(commons({ digest: [] }))[0] ?? "", /unknown setting "digest" \(it reads digests and skipContainerDocumentDigest\)/);
  assert.match(issues(commons({ digests: [{ algorithm: "MD5", bits: 128 }] }))[0] ?? "", /digests\[0\]: unknown setting "bits" \(it reads algorithm and encoding\)/);
});

test("the shapes are checked", () => {
  assert.match(issues(commons(null))[0] ?? "", /commons-digester-factory must be an object/);
  assert.match(issues(commons({ digests: "MD5" }))[0] ?? "", /digests must be an array/);
  assert.match(issues(commons({ digests: null }))[0] ?? "", /digests must be an array/);
  assert.match(issues(commons({ digests: ["MD5"] }))[0] ?? "", /digests\[0\] must be an object/);
  assert.match(issues(commons({ skipContainerDocumentDigest: "yes" }))[0] ?? "", /skipContainerDocumentDigest must be a boolean/);
});

test("both factories at once are refused: a parse has one", () => {
  const config = { "parse-context": { "commons-digester-factory": {}, "bouncy-castle-digester-factory": {} } };
  assert.match(issues(config).join(";"), /both set the digester factory, and a parse has one/);
});

test("the factory sits beside the limits", () => {
  const config = loadConfig({
    "parse-context": {
      "embedded-limits": { maxDepth: 2, throwOnMaxDepth: true },
      "commons-digester-factory": { digests: [{ algorithm: "SHA1" }] },
    },
  });
  assert.equal(config.limits?.maxNodeDepth, 2);
  assert.equal(config.digest?.digests[0]?.algorithm, "SHA1");
});
