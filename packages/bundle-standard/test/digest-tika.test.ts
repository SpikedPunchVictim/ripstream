import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRipstream, loadConfig } from "../src/index.ts";

/*
 * Tika's own DigestConfigTest (tika-parsers-standard-integration-tests), run against ripstream: the same document, the
 * same configurations, and the digests Tika's test hard-codes. The document is Tika's test_recursive_embedded.docx,
 * unmodified (fixtures/tika/README.txt). Tika computes with java.security and BouncyCastle; these are node:crypto's, and
 * MD2 (which OpenSSL 3 no longer has) ripstream's own. Tika's configuration files also carry an `auto-detect-parser` section,
 * which is not supported (CFG-014): the configurations here are their `parse-context` part. The record-level Content-Length
 * assertions below are also the recursive parse's own (recursive.ts sets it), so where digest.ts sets it is guarded by
 * packages/core/test/digest.test.ts.
 */

const DOCX = await readFile(fileURLToPath(new URL("./fixtures/tika/test_recursive_embedded.docx", import.meta.url)));
const P = "tk:digest:";

const EXPECTED = {
  MD2: "d768c8e27b0b52c6eaabfaa7122d1d4f",
  MD5: "59f626e09a8c16ab6dbc2800c685f772",
  SHA1: "7a1f001d163ac90d8ea54c050faf5a38079788a6",
  SHA256: "c4b7fab030a8b6a9d6691f6699ac8e6f82bc53764a0f1430d134ae3b70c32654",
  SHA384: "ebe368b9326fef44408290724d187553" + "8b8a6923fdf251ddab72c6e4b5d54160" + "9db917ba4260d1767995a844d8d654df",
  SHA512:
    "ee46d973ee1852c018580c242955974d" + "da4c21f36b54d7acd06fcf68e974663b" + "fed1d256875be58d22beacf178154cc3" + "a1178cb73443deaa53aa0840324708bb",
  SHA3_512:
    "04337f667a250348a1acb992863b3ddc" + "eab38365c206c18d356d2b31675ad669" + "5fb5497f4e79b11640aefbb8042a5dbb" + "7ec6c2c6c1b6e19210453591c52cb6eb",
  SHA1_BASE32: "PIPQAHIWHLEQ3DVFJQCQ7L22HADZPCFG",
} as const;

const digesting = (factory: string, settings: Record<string, unknown>) =>
  createRipstream({ config: loadConfig({ "parse-context": { [factory]: settings } }) });
const algorithms = (...names: string[]) => names.map((algorithm) => ({ algorithm }));
const BASIC = algorithms("MD2", "MD5", "SHA1", "SHA256", "SHA384", "SHA512");

for (const factory of ["commons-digester-factory", "bouncy-castle-digester-factory"]) {
  test(`${factory}: the container's MD2, MD5, SHA1, SHA256, SHA384 and SHA512 are Tika's`, async () => {
    const { metadata } = await digesting(factory, { digests: BASIC }).parse(DOCX, { filename: "test_recursive_embedded.docx" });
    assert.equal(metadata.get(`${P}MD2`), EXPECTED.MD2);
    assert.equal(metadata.get(`${P}MD5`), EXPECTED.MD5);
    assert.equal(metadata.get(`${P}SHA-1`), EXPECTED.SHA1);
    assert.equal(metadata.get(`${P}SHA-256`), EXPECTED.SHA256);
    assert.equal(metadata.get(`${P}SHA-384`), EXPECTED.SHA384);
    assert.equal(metadata.get(`${P}SHA-512`), EXPECTED.SHA512);
  });

  test(`${factory}: every record of a recursive parse has a Content-Length and a digest`, async () => {
    const records = await digesting(factory, { digests: algorithms("MD5") }).parseRecursive(DOCX, { filename: "test_recursive_embedded.docx" });
    assert.ok(records.length > 1, "the document has embedded documents");
    for (const record of records) {
      assert.notEqual(record.metadata.get("Content-Length"), null, `Content-Length of ${record.embeddedResourcePath || "the container"}`);
      assert.match(record.metadata.get(`${P}MD5`) ?? "", /^[0-9a-f]{32}$/, `MD5 of ${record.embeddedResourcePath || "the container"}`);
    }
    assert.equal(records[0]?.metadata.get(`${P}MD5`), EXPECTED.MD5);
    assert.equal(records[0]?.metadata.get("Content-Length"), String(DOCX.length));
  });

  test(`${factory}: skipContainerDocumentDigest leaves the container alone and digests what is embedded`, async () => {
    const records = await digesting(factory, { digests: algorithms("MD5"), skipContainerDocumentDigest: true }).parseRecursive(DOCX, {
      filename: "test_recursive_embedded.docx",
    });
    assert.equal(records[0]?.metadata.get(`${P}MD5`), null, "the container has no digest");
    for (const record of records.slice(1)) assert.match(record.metadata.get(`${P}MD5`) ?? "", /^[0-9a-f]{32}$/);
  });
}

test("the bouncy-castle factory's SHA3-512 is Tika's, and only the algorithms asked for are written", async () => {
  const { metadata } = await digesting("bouncy-castle-digester-factory", {
    digests: algorithms("MD5", "SHA256", "SHA384", "SHA512", "SHA3_512"),
  }).parse(DOCX, { filename: "test_recursive_embedded.docx" });
  assert.equal(metadata.get(`${P}MD5`), EXPECTED.MD5);
  assert.equal(metadata.get(`${P}SHA-256`), EXPECTED.SHA256);
  assert.equal(metadata.get(`${P}SHA-384`), EXPECTED.SHA384);
  assert.equal(metadata.get(`${P}SHA-512`), EXPECTED.SHA512);
  assert.equal(metadata.get(`${P}SHA3-512`), EXPECTED.SHA3_512);
  assert.equal(metadata.get(`${P}MD2`), null);
});

test("SHA1 in BASE32 is Tika's, under the key that carries the encoding", async () => {
  const { metadata } = await digesting("bouncy-castle-digester-factory", { digests: [{ algorithm: "SHA1", encoding: "BASE32" }] }).parse(DOCX, {
    filename: "test_recursive_embedded.docx",
  });
  assert.equal(metadata.get(`${P}SHA-1:BASE32`), EXPECTED.SHA1_BASE32);
  assert.equal(metadata.get(`${P}SHA-1`), null, "the hex key is not written");
});

test("the parse-context of Tika's tika-config-digests.json: SHA256 as BASE32 beside MD5 in hex", async () => {
  const { metadata } = await digesting("commons-digester-factory", {
    digests: [{ algorithm: "SHA256", encoding: "BASE32" }, { algorithm: "MD5" }],
  }).parse(DOCX, { filename: "test_recursive_embedded.docx" });
  assert.equal(metadata.get(`${P}MD5`), EXPECTED.MD5);
  const base32 = metadata.get(`${P}SHA-256:BASE32`);
  assert.equal(Buffer.from(EXPECTED.SHA256, "hex").length, 32);
  assert.match(base32 ?? "", /^[A-Z2-7]{52}=*$/);
});

test("without a digester factory no digest is written", async () => {
  const { metadata } = await createRipstream().parse(DOCX, { filename: "test_recursive_embedded.docx" });
  assert.deepEqual(metadata.names().filter((name) => name.startsWith(P)), []);
});
