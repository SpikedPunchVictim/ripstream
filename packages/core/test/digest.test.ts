import assert from "node:assert/strict";
import { test } from "node:test";
import { createHasher, digestBytes, digestKey, digestStream, encodeDigest, maybeDigest } from "../src/digest.ts";
import { DIGEST_ALGORITHMS, DIGEST_ENCODINGS, Metadata, ParseContext, CONTEXT_KEYS, RipstreamInputStream, metadataKeyDefinition, type DigestAlgorithm, type DigestSettings } from "../src/index.ts";

/*
 * Tika's digesters (tikajs-68os.9.1). The expected values are not computed by the code under test: the NIST/RFC answers
 * and the output of Python's hashlib stand for the algorithms, RFC 1319 and RFC 4648 for MD2 and the encodings, and the
 * metadata schema Tika's own TikaCoreProperties generated for the keys.
 */

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const hex = (algorithm: DigestAlgorithm, data: Uint8Array): string => {
  const hasher = createHasher(algorithm);
  hasher.update(data);
  return encodeDigest(hasher.digest(), "HEX");
};

test("MD2 gives the answers of RFC 1319's test suite", () => {
  const suite: ReadonlyArray<readonly [string, string]> = [
    ["", "8350e5a3e24c153df2275c9f80692773"],
    ["a", "32ec01ec4a6dac72c0ab96fb34c0b5d1"],
    ["abc", "da853b0d3f88d99b30283a69e6ded6bb"],
    ["message digest", "ab4f496bfb2a530b219ff33031fe06b0"],
    ["abcdefghijklmnopqrstuvwxyz", "4e8ddff3650292ab5a4108c3aa47940b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "da33def2a42df13975352846c30338cd"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "d5976f79d83d3a0dc9806c3c66f3efd8"],
  ];
  for (const [input, expected] of suite) assert.equal(hex("MD2", text(input)), expected, JSON.stringify(input));
});

test("MD2 does not depend on how its input is cut into updates", () => {
  const data = Uint8Array.from({ length: 1000 }, (_, index) => (index * 31 + 7) & 0xff);
  const whole = hex("MD2", data);
  let seed = 12345;
  const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let trial = 0; trial < 50; trial++) {
    const hasher = createHasher("MD2");
    for (let at = 0; at < data.length; ) {
      const take = 1 + (next() % 40);
      hasher.update(data.subarray(at, at + take));
      at += take;
    }
    assert.equal(encodeDigest(hasher.digest(), "HEX"), whole);
  }
});

test("every other algorithm answers the known values for the empty input and for abc", () => {
  const known: Record<Exclude<DigestAlgorithm, "MD2">, readonly [string, string]> = {
    MD5: ["d41d8cd98f00b204e9800998ecf8427e", "900150983cd24fb0d6963f7d28e17f72"],
    SHA1: ["da39a3ee5e6b4b0d3255bfef95601890afd80709", "a9993e364706816aba3e25717850c26c9cd0d89d"],
    SHA256: ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    SHA384: [
      "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b",
      "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
    ],
    SHA512: [
      "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    ],
    SHA3_256: ["a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a", "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532"],
    SHA3_384: [
      "0c63a75b845e4f7d01107d852e4c2485c51a50aaaa94fc61995e71bbee983a2ac3713831264adb47fb6bd1e058d5f004",
      "ec01498288516fc926459f58e2c6ad8df9b473cb0fc08c2596da7cf0e49be4b298d88cea927ac7f539f1edf228376d25",
    ],
    SHA3_512: [
      "a69f73cca23a9ac5c8b567dc185a756e97c982164fe25859e0d1dcc1475c80a615b2123af1f5f94c11e3e9402c3ac558f500199d95b6d3e301758586281dcd26",
      "b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0",
    ],
  };
  for (const algorithm of DIGEST_ALGORITHMS) {
    if (algorithm === "MD2") continue;
    const [empty, abc] = known[algorithm];
    assert.equal(hex(algorithm, text("")), empty, `${algorithm} of nothing`);
    assert.equal(hex(algorithm, text("abc")), abc, `${algorithm} of abc`);
  }
});

test("the encodings are RFC 4648's, with padding, and hex is lower case", () => {
  const base32 = ["", "MY======", "MZXQ====", "MZXW6===", "MZXW6YQ=", "MZXW6YTB", "MZXW6YTBOI======"];
  const base64 = ["", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", "Zm9vYmE=", "Zm9vYmFy"];
  "foobar".split("").reduce((prefix, letter, index) => {
    assert.equal(encodeDigest(text(prefix), "BASE32"), base32[index], `base32 of ${JSON.stringify(prefix)}`);
    assert.equal(encodeDigest(text(prefix), "BASE64"), base64[index], `base64 of ${JSON.stringify(prefix)}`);
    return prefix + letter;
  }, "");
  assert.equal(encodeDigest(text("foobar"), "BASE32"), base32[6]);
  assert.equal(encodeDigest(text("foobar"), "BASE64"), base64[6]);
  assert.equal(encodeDigest(Uint8Array.from([0xab, 0xcd, 0x01]), "HEX"), "abcd01");
  // A 16-byte MD5 is 26 characters and six of padding; a 20-byte SHA-1 fits whole.
  assert.equal(encodeDigest(createHasher("MD5").digest(), "BASE32"), "2QOYZWMPACZAJ2MABGMOZ6CCPY======");
});

test("the metadata key is Tika's: hex bare, the others with the encoding, and every one is in Tika's schema", () => {
  assert.equal(digestKey({ algorithm: "MD5", encoding: "HEX" }), "tk:digest:MD5");
  assert.equal(digestKey({ algorithm: "SHA256", encoding: "BASE32" }), "tk:digest:SHA-256:BASE32");
  assert.equal(digestKey({ algorithm: "SHA3_512", encoding: "BASE64" }), "tk:digest:SHA3-512:BASE64");
  let count = 0;
  for (const algorithm of DIGEST_ALGORITHMS) {
    for (const encoding of DIGEST_ENCODINGS) {
      const key = digestKey({ algorithm, encoding });
      assert.ok(metadataKeyDefinition(key) !== undefined, `${key} is a TikaCoreProperties key`);
      count++;
    }
  }
  assert.equal(count, 27);
});

async function streamOf(parts: readonly Uint8Array[], spoolThreshold = 1024 * 1024): Promise<RipstreamInputStream> {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (const part of parts) yield part;
  }
  return RipstreamInputStream.from(chunks(), { spoolThreshold });
}

test("digestStream feeds every algorithm in one pass, whatever the chunks, and leaves the stream where it was", async () => {
  const parts = [text("a"), text("b"), text("c")];
  const stream = await streamOf(parts);
  try {
    const first = await digestStream(stream, [{ algorithm: "SHA256", encoding: "HEX" }, { algorithm: "MD5", encoding: "BASE64" }, { algorithm: "SHA256", encoding: "BASE32" }], new ParseContext());
    assert.equal(first.length, 3);
    assert.deepEqual(first.values.map(([key]) => key), ["tk:digest:SHA-256", "tk:digest:MD5:BASE64", "tk:digest:SHA-256:BASE32"]);
    assert.equal(first.values[0]![1], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(first.values[1]![1], Buffer.from("900150983cd24fb0d6963f7d28e17f72", "hex").toString("base64"));
    assert.equal(stream.position, 0);
    // Still all there for whoever reads next.
    assert.equal(Buffer.from((await stream.readFully(10))).toString(), "abc");
    // From a position that is not the start, it is the rest that is digested and the position that comes back.
    await stream.seek(1);
    const rest = await digestStream(stream, [{ algorithm: "MD5", encoding: "HEX" }], new ParseContext());
    assert.equal(rest.length, 2);
    assert.equal(rest.values[0]![1], hex("MD5", text("bc")));
    assert.equal(stream.position, 1);
  } finally {
    await stream.close();
  }
});

test("a document held in a temporary file is digested the same", async () => {
  const data = Uint8Array.from({ length: 5000 }, (_, index) => index & 0xff);
  const stream = await streamOf([data.subarray(0, 1234), data.subarray(1234)], 100);
  try {
    const { values, length } = await digestStream(stream, [{ algorithm: "SHA512", encoding: "HEX" }], new ParseContext());
    assert.equal(length, 5000);
    assert.equal(values[0]![1], hex("SHA512", data));
    assert.equal(stream.hasFile, true);
  } finally {
    await stream.close();
  }
});

function contextWith(settings: DigestSettings | undefined, depth?: number): ParseContext {
  const ctx = new ParseContext();
  if (settings !== undefined) ctx.set(CONTEXT_KEYS.DIGESTS, settings);
  if (depth !== undefined) ctx.set(CONTEXT_KEYS.EMBEDDED_DEPTH, depth);
  return ctx;
}

const MD5_ONLY: DigestSettings = { digests: [{ algorithm: "MD5", encoding: "HEX" }], skipContainerDocumentDigest: false };

test("maybeDigest notes the digests and, where nothing has, the length", async () => {
  const stream = await streamOf([text("abc")]);
  try {
    const metadata = new Metadata();
    await maybeDigest(stream, metadata, contextWith(MD5_ONLY));
    assert.equal(metadata.get("tk:digest:MD5"), "900150983cd24fb0d6963f7d28e17f72");
    assert.equal(metadata.get("Content-Length"), "3");
  } finally {
    await stream.close();
  }
});

test("a Content-Length that is already there stays; a blank one is replaced", async () => {
  for (const [given, expected] of [["99", "99"], ["  ", "3"]] as const) {
    const stream = await streamOf([text("abc")]);
    try {
      const metadata = new Metadata();
      metadata.set("Content-Length", given);
      await maybeDigest(stream, metadata, contextWith(MD5_ONLY));
      assert.equal(metadata.get("Content-Length"), expected);
    } finally {
      await stream.close();
    }
  }
});

test("without settings, or with no digests to make, nothing is read or written", async () => {
  for (const settings of [undefined, { digests: [], skipContainerDocumentDigest: false }] as const) {
    const stream = await streamOf([text("abc")]);
    try {
      const metadata = new Metadata();
      await maybeDigest(stream, metadata, contextWith(settings));
      assert.deepEqual([...metadata], []);
      // Not read: a stream's length is known only once it was read to its end.
      assert.equal(stream.length, null);
    } finally {
      await stream.close();
    }
  }
});

test("skipContainerDocumentDigest leaves the container (depth 0) alone and digests what is embedded", async () => {
  const skipping: DigestSettings = { ...MD5_ONLY, skipContainerDocumentDigest: true };
  for (const [depth, digested] of [[undefined, false], [0, false], [1, true], [3, true]] as const) {
    const stream = await streamOf([text("abc")]);
    try {
      const metadata = new Metadata();
      await maybeDigest(stream, metadata, contextWith(skipping, depth));
      assert.equal(metadata.get("tk:digest:MD5") !== null, digested, `depth ${String(depth)}`);
      assert.equal(metadata.get("Content-Length") !== null, digested, `depth ${String(depth)}`);
    } finally {
      await stream.close();
    }
  }
});

test("without skipContainerDocumentDigest the container is digested too", async () => {
  const stream = await streamOf([text("abc")]);
  try {
    const metadata = new Metadata();
    await maybeDigest(stream, metadata, contextWith(MD5_ONLY, 0));
    assert.equal(metadata.get("tk:digest:MD5"), "900150983cd24fb0d6963f7d28e17f72");
  } finally {
    await stream.close();
  }
});

test("a parse that was aborted stops the digest", async () => {
  const stream = await streamOf([text("abc")]);
  try {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await assert.rejects(() => digestStream(stream, MD5_ONLY.digests, new ParseContext({ signal: controller.signal })), /stop/);
    assert.equal(stream.position, 0);
  } finally {
    await stream.close();
  }
});

test("digestBytes gives what digestStream gives, for a document of many slices, and one of none", async () => {
  // Past the slice (256 KiB) twice and a bit, so the hashers are fed in three updates with the loop freed between them.
  const big = new Uint8Array(600 * 1024).map((_, index) => (index * 7 + 3) & 255);
  const defs = [{ algorithm: "MD2", encoding: "HEX" }, { algorithm: "SHA256", encoding: "BASE32" }, { algorithm: "SHA3_512", encoding: "BASE64" }] as const;
  const stream = await streamOf([big.subarray(0, 100_000), big.subarray(100_000)]);
  try {
    assert.deepEqual(await digestBytes(big, defs), (await digestStream(stream, defs, new ParseContext())).values);
  } finally {
    await stream.close();
  }
  assert.equal((await digestBytes(new Uint8Array(0), [{ algorithm: "MD5", encoding: "HEX" }]))[0]![1], "d41d8cd98f00b204e9800998ecf8427e");
});

test("digestBytes stops at an abort, between slices", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(() => digestBytes(new Uint8Array(10), [{ algorithm: "MD5", encoding: "HEX" }], controller.signal), /stop/);
});
