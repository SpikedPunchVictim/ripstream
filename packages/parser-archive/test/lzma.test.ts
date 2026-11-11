import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CONTEXT_KEYS, LimitExceededError, MalformedDocumentError, Metadata, ParseContext } from "@spikedpunch/ripstream-core";
import { LzmaParser } from "../src/index.ts";
import {
  boundedContext,
  capturingContext,
  capturingParser,
  fromBase64,
  runParser,
  type Captured,
} from "./stream-helpers.ts";

// Every stream below is a real LZMA-alone file written by liblzma (Python's lzma.compress(format=FORMAT_ALONE)), not by
// the decoder under test. They carry an unknown size (all ones) and end with the end-of-payload marker.
const HELLO = fromBase64("XQAAAQD//////////wA0GUnujekUimql1d5wKZ///ZlAAA==");
// 2589 bytes of text (random words and numbers), written with three property combinations (lc/lp/pb).
const BODY_SHA256 = "714744bff21b2bf63a39b6672fb6c413f35b8dbbc42ebe9be001a5ff76248188";
const BODY_LC3_LP0_PB2 = fromBase64("XQAAEAD//////////wA9GUrulbFsZk94M7oFzl2BlEH7vbI+YNW22hDhiYD8b1X+MzDeP4zVY8U1yG8Y7p34zmf1+F9LXEDrICp9ibwpEoXKvkNVqFxrJPHZqNrmvVXk77GJ+wVX0uBc8FtP7yNwMBJn4mlOG329KmfGotUcINZV6K5bqAdSkse4mRLCJR8SpNphijBv5i22sWajc88lH68r+9VppqGbKCiLiG92fSWq6jaznkdZye4d6EIwjnJfq50K5Z9tsWQXSbBCOj/8rWUQ4tOaXLndqZnJSm9dXCtlsKsuXVk1FCnJqPxyzWmrMJePoCulss3KBFUDfCXsKs+DatR5CXYAr9KH7VJwnXsrhFcbsFU2eYFvt4jMY0DoaILn5A/9SZr+xUqP2gPDWV2tbxN50ouXy3pLDb151pxsMoHssr4GNhBLr4tMckiK991JgSlg2qwbd+ion/W8TsmYVrzkqUixE7LtkumxkPpVhTuWnuCCPPn77L3u56lCeNTYKlaqwr4AznHxlPs1v8Qpx9RT8fKrE0efgp+RqihUeXYCpvBfMt0DSCyKV2ePSB3nwHHd4821+lBnDetn2sY8pVtfFdqhpgIEE0yD6cMkBh/owdEpLOf3CCXuUKSoVLXv6r98f44YvQbDhGsPhZGGCVE1bCZtCbvwyxHNBq8C17hd+P5gBeihjNX4rEwD+rNIHv96Y5jzmia+6CmgZbxIf52ZWejkFm2ScI/caEJIvzXxFCkdhJ4CG0ZjlX9WVQLsSc5bYYOsz4epKPixh+IlqWg0hNsk3UelmF3a/h4bX5g945rsfWJt/Fl8GnU5bpn8qtM5nPhAzRqQkFT53G5AxXW4gijOXuNXt1p7OKZJ99dek1sWTxvkjZ351GSJ0OF9HxGjAJ7S3HNKQ47mPkYPnX8yC2N70ADYEc88O9vzjHbkKflT544A0YqvFzbcfgc2O5G27HZoAwmtof8B+rry+QjWcfjwBfHOmVrQSckeZcU0XtHIgxHIXiOHNiGCIQTHki8RhkL70NAlG6H39tb7YMtZi5wNlsUf74G/RHmm8Yt3NA4PVF7ZQbgLiNJ0em2FoC6Y8IkA1YycGMYAYY/dyTAAdPy76rIE5I68i/zMKSmSUGt7nWoPKV+qPfK2x4JN+4q4M8Fk65a8VI8eiQCEyR3fmTnYD1vSLRNfMv//SaPuAA==");
const BODY_LC0_LP2_PB0 = fromBase64("EgAAEAD//////////wA9GhXmv7ETPaSvkxRhSgU46Cs0EMJ8ojRkCgnkXptv4iD5nIdfjvR8qOwabaB6e7WIgK/ttjEq0Tg7pNmx6XZ2wvQoLx/pvMkvit8FgHDuFOLcoqW/hUD8azQiFKiduWEiTmAU6vS+d2vMFQP8/B3OtN6Ekg0hDgFP9HV/UhxZaTuqfIibLyG4mwZv0MkjzgUwHdQ70HKYoYbDtLqomjTCP3DPnKL7BDD8nS0Yr6of5T8HTCMGnrd5HS5C8kWbpWbfsFCkjfqvNN+hokIUMBgu4d4UKh7d96GqTEXbCIGWy9CRtJPd+P+WuG9aZEgKIkldgOZ0y1l75wMT5d8zQqvTLytgHczB/zHhiwMAEinunoP/9RX2c+EQ1vcnhYz5p/L+exK1829lU4iQ6EBZDjQp3arqOAUNGf7v5UAcz8vIntp0qHoi8K3zFNQdtgyV0HqFzK3dWN4dvhVVipt+XvRK0VQ2/mStWTrn6e5uIvCORKS1MCll8pLaFisvPk/PMFgqGIkUyteXZ3c5zm6zaXLTI+sP90ZDt9p0b31/brxTQ4Pk4d0EIDZpd+PGCXVFtCixxafwO3gwbz+qQatb2GTe4Hsa78M7nU+V43hPdFcBVf/w5VHwUetWQN9He0pHGFoBUgL/lG7rGNklr4QQ3lI5gIEh/NhPwe+2NJ8KSGlU1t0L+NmR0Nrxf/l2wRZc8wkMF8W5QN3LmeO8YXyzvTQ+vhRVxcff9yEEtyKXwl7el8HtT7Hi7ug8oYVZF3iP0A0W/TOTnVLMuvCZW+xFiTIAeMhLP2S69bvEgH+Ss4NJXU6U2qjuWh2LoxQ+ymRQ9KAXF52PsEFtbmD10gglsHviEYacGY8cu7LS23WVkxxkR6MKP6Jjgb5GtB093PKIwakRD/gBnAZk5GParT3Bq1oHlPTNkTOj2Emdw2S8WcvO1b71c7qBkq/jcDb94/xE/B6lD2TlZWOk7vP290nxPnUOlIj7+Phon7IbySZCgGClakw+NMWtbbvbV39MpbwDNc+Jh86O3u8mZk/AzPZ6TAKQBK9NUHoX0KF0FqXU2Ktz1HtqQVfu/L9XO26omgGqEaTWbOb36i9WcCtUffigeTcFLMBojNRRFEL5AO26eQ52qZct1rtv9wyAwGsqtflgYAzE+U9aePp4TKewjvjJaDisRS0jNbmyFaRsiLAdiC67LxeoaicpTPgatlAkVfcg5rnd5KTOzg1+baBtur3ccd2M/1g+mwA=");
const BODY_LC4_LP0_PB4 = fromBase64("uAAAEAD//////////wA9GUqGIpMYPzMjHOwPjM1ujWTt5EroDTP094lRU8Qjd8je0G3RjdciwXz2n/HR8rQ+afEq7I+04faigNZzHZV5vYxbaJjPIT5OVduiaALqi4F0S6T5eHjUpJeKvPHyuf2KLICbN4TEG5aMK/4hg0T5gt9G6pNwIa5EuWdcH8gBgyi9GgGvuuNf+Ig+QbGCHYK6jNS1E/v481EC1D8LOgdYiSFcuoOLub1ZGaDWLOb+i1JTi1bjStfmDrgp2AeEICw349jAhGTGbqCmKRczy4NAaHfeKzXdUpmg5MFuxMJKGhYnM68FggY7oOJw2wC4IpdUJxecWAugH0hkIYYeAP3XcwQ+lljDfqIiV7lqLEM19A3QnWrhYfYQhtCetnTTEvJX8QaLk/KPe2st1Mimwx5E/15DgyNP4/sK6ar3i1DrE+/ZDMIBLZzuQ5oc4mSPFrzR25KIFSmbexq91+VK6LpkbiaV0KPcHNscVGAObIgc+1Ik6bXH3nFYlXXGfd+S2wVqraiTqGjSq+T3u5iQ9KFqXwAhedxIKTmSlRxM/cv6pXYeaPGXJoaRUBIY4L5VQnaTe0XBzJjMl75BvvlvoNn7IE9Kb94hVPIAzD7w6VAkYEoCfd7nhEO+WB7UjnWiEGR2fPQAPDus4WH99Ar+SplyKILD+bCMkeP8CSojNSao3sXd4VoOwbbKDn9L2bxX3LSxkevxf5BbWUcps2cDoLoy2xKtSlZYScoapWahdt5O9FKa5r+FPhLJq5ZMc52+5nuv3kzJSnN3XahXs/HWclei6FVNxRSncoLCP7HBUocU0W3ZshTjcMs1wMGQOw9UD/3kL6hQXwWwMeQiqm9tPB1rQfdQGFo2OeETTlC9QAUM3wq/uKruR76zyVrxyh8vj4pJQ+XdjeMmoL+MEue1YkuYErfrn5j89aGAfxdQnbafrlsrmfcCQbGyGboPSfjbv3JvzcT+XFawNoocElR7rxad0Lo0+/GZqTm5p7vlUyJe6kkN8AiSoeZpLuRxLUl2l0fu2soFKfnLguYt4zn0Hv0lMzJoVpqapvGJ+NZgQ1cgiZfKvY6fFOmqDz/s/gBE6qeHFxXlnm5Tl503gTVw/cyPDexX8vPW7BcHKJ0dAkPG9s4lBdH4krU4aYCK/ghaM00YIgFs9Q5y/si1J6mOKtalev/qxr51sIeBTbGUB+y//lRmMA==");
// 600 pseudo-random bytes: almost all literals, so the matched-literal path is not the only one exercised.
const RANDOM_SHA256 = "c87c0ed19a5f6e0f71c748ca9c93053186635cb7be62780ba5b00984807c626b";
const RANDOM = fromBase64("XQAAAQD//////////wBzu5iYotUAnC4AWX5TTjV2lNdEAc0Fi8MXs5LbrS5q53ELYxZPMiVbr5lP/YeKxtCeps9cCr5FkNIH+7WF0DeY0dX8/C1LKV40f1tjvtyudNHYzAVgtJ7K2UXmnfMgfTtMD3EL5PApzNaPSGhg0XjsF2wYfFuwyjr8lwhEgcJDk+2oJDVgq8ARu2TQ1kyCzzXGHN48yxYNgm+Olwdj1f47nlvs6vIQEhtZ4oExD7uKLt1WAXYpyp7m/oMgXwBtYBAv6Sj66bMIzzrTktD+NnCfC7BS5uK9tA0FmLyHvSXygBiS//MmA6DYvJm6i0f7wOBPKb6OX5SibsAHbcmgDxUFNBVDfCyvwjYlgI66j3N8967VBl6EU6rN59DsUa33BnYOLlMD4Gk5CpqSMPN7mk3HscEtnAuDFWLZpI3skajyw7WJPMKbdSmZFGLGQDRSXszOb6OmJgFRW+8jtsEz2Cxewf19kD8PRsdgo44DnLgU3sVr+W0StiAg0xC6y0AMM5zCOx8YZZeby4R8kGHbko8dx6BqSVb9Aw+7H8IgYj1RShi1uaDu/hYCKvkih9AoWJhssL5CBcatIqBGY+2yp299cvRxsNF1bWgkX6fXXRtSssa4e4Iq+RozeY0kgEr1bjwnPclHmvwJtddEL1lxQOeuLqIOMkVgpfy2OneHVvBut5NTnJ6aNtBtliNWFM+AqYHVvZQbWjBZxRlr61h1+5RjhU8rif3fWDz77Rt/VMGQGe+w0DV2TYcTERmiptWGX/JZnqA/jq2qxW/R0HaRcP8JUnFaMZwSwg59vbgffYAWlOU4UGAO5RS9C6AN2K///0GIAAA=");
// 229 bytes that inflate to 1,000,000 zeros.
const ZEROS = fromBase64("XQAAEAD//////////wAAb/3//6O3/0c+SBVyOWFRuJIo5qOGB/nu5B6C0y/FOjwBS7F+yYqKTS+jDdl/puOMIxFT4FkYxXWK4nf4tpR/DGrA3nRJZOLpXFOyBNj3RAyrXw1tRunlw3aIt5ZXrLZN4Wkdb/tLiBBsQsuIP1wAj9BOryYolHEfPY8k4XCepyNf7CjLhdGVmIp+KpHyJ3X3GcAGmE2Y/div1ZAPxCVT+PWRNjEFpbDub8FwTUcM0ZERqq1gHbrOsScYXFmG6WZSWL7pdqxZ5OVbBQj5lKs+////KMAAAA==");
// Tika's tika-parser-pkg-module/src/test/resources/test-documents/testLZMA_oom: a 19-byte stream whose header asks for a
// dictionary of about 1.8 GiB. CompressParserTest.testLZMAOOM expects TikaMemoryLimitException.
const TIKA_LZMA_OOM = fromBase64("XQAAAHQAcgB1AGUAAAAAAAAAAA==");

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function decode(bytes: Uint8Array, name?: string): Promise<Uint8Array> {
  const captured: Captured[] = [];
  const metadata = new Metadata();
  if (name !== undefined) metadata.set("tk:resource-name", name);
  await runParser(new LzmaParser(), bytes, capturingContext(captured), metadata);
  assert.equal(captured.length, 1);
  return captured[0]!.bytes;
}

test("LzmaParser claims application/x-lzma, the type Tika's CompressorParser claims", () => {
  const types = [...new LzmaParser().getSupportedTypes()].map((type) => type.toString());
  assert.deepEqual(types, ["application/x-lzma"]);
});

test("decodes a small LZMA-alone stream", async () => {
  assert.equal(new TextDecoder().decode(await decode(HELLO)), "hello lzma\n");
});

test("decodes text written with lc=3 lp=0 pb=2", async () => {
  assert.equal(sha256(await decode(BODY_LC3_LP0_PB2)), BODY_SHA256);
});

test("decodes text written with lc=0 lp=2 pb=0", async () => {
  assert.equal(sha256(await decode(BODY_LC0_LP2_PB0)), BODY_SHA256);
});

test("decodes text written with lc=4 lp=0 pb=4", async () => {
  assert.equal(sha256(await decode(BODY_LC4_LP0_PB4)), BODY_SHA256);
});

test("decodes incompressible data", async () => {
  assert.equal(sha256(await decode(RANDOM)), RANDOM_SHA256);
});

test("a stream with a declared size stops at that size, end marker or not", async () => {
  const sized = BODY_LC3_LP0_PB2.slice();
  new DataView(sized.buffer).setBigUint64(5, 2589n, true);
  assert.equal(sha256(await decode(sized)), BODY_SHA256);
});

test("a declared size larger than the data is refused as malformed", async () => {
  const sized = HELLO.slice();
  new DataView(sized.buffer).setBigUint64(5, 5000n, true);
  await assert.rejects(decode(sized), MalformedDocumentError);
});

test("the container name is kept: Tika's setName does not strip .lzma", async () => {
  const captured: Captured[] = [];
  const metadata = new Metadata();
  metadata.set("tk:resource-name", "notes.txt.lzma");
  await runParser(new LzmaParser(), HELLO, capturingContext(captured), metadata);
  assert.equal(captured[0]!.name, "notes.txt.lzma");
});

test("every strict prefix of a stream is refused as malformed", async () => {
  for (let length = 0; length < HELLO.byteLength; length++) {
    await assert.rejects(decode(HELLO.subarray(0, length)), MalformedDocumentError, `prefix of ${length} bytes`);
  }
});

test("every strict prefix of a longer stream is refused as malformed", { timeout: 60_000 }, async () => {
  for (let length = 0; length < BODY_LC3_LP0_PB2.byteLength; length += 7) {
    await assert.rejects(decode(BODY_LC3_LP0_PB2.subarray(0, length)), MalformedDocumentError, `prefix of ${length} bytes`);
  }
});

test("a flipped byte anywhere parses or is refused as malformed, never anything else", { timeout: 60_000 }, async () => {
  for (let position = 0; position < HELLO.byteLength; position++) {
    const damaged = HELLO.slice();
    damaged[position] = damaged[position]! ^ 0xff;
    try {
      await decode(damaged);
    } catch (error) {
      assert.ok(
        error instanceof MalformedDocumentError || error instanceof LimitExceededError,
        `byte ${position}: ${String(error)}`,
      );
    }
  }
});

test("a flipped byte anywhere in a longer stream parses or is refused, within the output cap", { timeout: 60_000 }, async () => {
  for (let position = 0; position < BODY_LC0_LP2_PB0.byteLength; position++) {
    const damaged = BODY_LC0_LP2_PB0.slice();
    damaged[position] = damaged[position]! ^ 0x5a;
    try {
      await runParser(new LzmaParser(), damaged, boundedContext());
    } catch (error) {
      assert.ok(
        error instanceof MalformedDocumentError || error instanceof LimitExceededError,
        `byte ${position}: ${String(error)}`,
      );
    }
  }
});

test("a match pointing before the start of the output is refused as malformed", async () => {
  // Header, then a range-coder stream whose first decoded symbol is a match: nothing precedes it.
  const first = Uint8Array.from([0x5d, 0, 0, 1, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  await assert.rejects(decode(first), MalformedDocumentError);
});

test("the properties byte must be a valid lc/lp/pb combination", async () => {
  const bad = HELLO.slice();
  bad[0] = 225;
  // CompressorParser wraps the decoder's failure; the reason is on the cause.
  await assert.rejects(
    decode(bad),
    (error: unknown) => error instanceof MalformedDocumentError && /properties byte/.test(String((error as Error).cause)),
  );
});

test("a stream that does not start with a zero range-coder byte is refused as malformed", async () => {
  const bad = HELLO.slice();
  bad[13] = 1;
  await assert.rejects(decode(bad), MalformedDocumentError);
});

test("an LZMA bomb fails with LimitExceededError at the output cap", async () => {
  await assert.rejects(runParser(new LzmaParser(), ZEROS, boundedContext()), LimitExceededError);
});

test("a declared size above the output cap is refused before any decoding", async () => {
  const huge = HELLO.slice();
  new DataView(huge.buffer).setBigUint64(5, 1n << 40n, true);
  await assert.rejects(runParser(new LzmaParser(), huge, boundedContext()), (error: unknown) => {
    return error instanceof LimitExceededError && /declared/.test(error.message);
  });
});

test("Tika's testLZMA_oom (a 1.8 GiB dictionary) is refused with LimitExceededError", async () => {
  await assert.rejects(decode(TIKA_LZMA_OOM), (error: unknown) => {
    return error instanceof LimitExceededError && /dictionary/.test(error.message);
  });
});

test("a dictionary just inside the 100000 KiB memory limit is accepted", async () => {
  const inside = HELLO.slice();
  // 99,000 KiB: the header's dictionary field is bytes 1..4, little endian.
  new DataView(inside.buffer).setUint32(1, 99_000 * 1024, true);
  assert.equal(new TextDecoder().decode(await decode(inside)), "hello lzma\n");
});

// Two more real liblzma streams (Python's lzma.compress(format=FORMAT_ALONE), unknown size, end marker).
// 5109 bytes: 5009 pseudo-random bytes, then the first 100 of them again, a match 5009 bytes back; written with a dictionary of 8192.
const FAR_SHA256 = "94a58d7f430bc6fc795bd9a91ae490c13c395426f7a56987b04a35f4695eb73a";
const FAR_MATCH = fromBase64("XQAgAAD//////////wBSk1VBgSh9Xg/d5fL5Ct9YBiEBxf1gYN9lXeeIZWQpY3EgCs/zULmFwefmLqI/5aqLpJnqeImp+EdEhhvj0qPa8VmsVM+rSGrbRL1PTIMOzuchPl5bZ09jYxshCdPJ0Z6eqXN7pI2FK3wiltmaQnjpUfBTZQOjSMZ4hv8mn48VkLpwMIqTvtaoX6AnidWKS9hzPzaAXDuriRcQvCVczgyEFQotcLaed8t0TK+75Kgb+KslbE7gRJV6Mzoc+L56wHcMWQUWBh1kOe/1d5LiSXNpMwhE0a6Dg1AKwQ4pJCdxUAbM7BjDaws+jI6xItMBhxJ/Rt7L7Q2aY257OCnYKPL3sG3GMyjSlD6PkQ8SztwoHLo6Xfm9t6lbV/+6Y+3xkJKE5E6VWpmadOms9Z6RHd5RLd+ylZY+oEItFdyXYJ3pPsoIXc9aBdCkkNMDdVKypYjZOpOgFx10jrqnWiK801XkxGa7a/mGE0XroBxuVXrbBfL8VjzLSlVgDTVQXbLTeZcuNNmIVStzpi37kIIgWxKXq0FbHHVnuQytmBfmXQuz6RTEoSLW3NP8K3J8UCSjqGZSUhG5zd7/GqC9uuZgLPE0s2XcGyWvLaU3b79pkjwj7PhyD1zxuhZq5XnpBR8Ygpr0WlqLDZcuR5o0iWCT7SSikYSkxuPbeVVODhbS4wKrewphWYFD7DO7lNPkQY0QJI8cMe8LRrfmNL2emYptRn9xem2wxezBGNSMsjv82JmgM+3JERu3lDX1Brat8uEs3wD15FVIySh2gceNNbV4Fax6O9pnu5iGTdQdZQIfM9wxnqwegNZ3ySWvlsZsKLuE6kGBHiuT08HaTyQC2l1XRJ2o1xOJ9DSiO0rvswhXKxby7vTAeEiqC6ObQIWzK9tcrFDgrdC+5AMU5O886uY6iEcAcEmaUltQ1VSr+9lfxXfOnOFLPI9k8i+uO5GlQ79vGAhJOXTC/sbJzm847lEJXT/oou3B2FE/ncVOhvILvV8ri7c9e+v8FHH/IKM+G2znPVQQqVGRsf3maoPWvw8GzcTL1/fTuxBwMhzj4s/ypVUmHkveuKn08H73CmAgLn5l4bx7kpnRwbw0PUuD5nh4PWtG9gINDJhI4xDiiAlDZDWtWMS+SE7jzuA6z8VRLm/XZRQO1RHE5UReRq4BcxVE6wzZyA4qACj4oQP+Oa79lKecDcEC5jCbICq4hdu4qT+FHtXgVckSrxRv9EfYfgr2lOFTukdXvz99QgzQkcXJxxsm94JMssvbF2Aifl6BThrPmt9syJmGXa9yqfGua7fTSfGN7p7kyRi780dU6dG8Ug/cCZp6eqfloELDLec+945vL2BR1ej20E1tL7RdjLv09v+hII6vls1lvkhR+9ok1Z/D9iamvHqWNa2gJkQzkDMNYyD3UzbiqG8RUwUFtVZ+Ku5hTYSvy4MCZGQAjff1Ksh883TJBKfsabiw/ly2mmZSBdokZn3pa1yFEY0WICKoBMy5wz/K6hed0oeQIUtzvE3ZA+wM93uH/HLV7RdZOLQaFPxbaKgpGs6Kp6NhTJC0neam1/bErK5ZjziZTmIb/U3T5hlbV9kSUEB7qngFUQLiH021uLjIA+NIeYPPELk1PuF9WWtXXDb6z1qqwFOZCJFfv7ap9IKqyTlasEVdiEtv2ub40O0ih4v+qNs+NxV4Lr7Z4+nnc65pQH5xLqx5InDFhFG50t8fIkdNsPZ2dQEYIBDn0m1/XA11TVvB5XodlNMHBl7dgjlsSBhwSpOkls3gBSA33kpSOxnmCTiyUl8DpM0f5cw/dF91RYLb/QwruI5Td0B3/y7e9vrr/dzczqwQBUMFTP+6TZLIcFOTwU9XKhEgQ1kvFuERfFqDPcQm9rY7Bpl8chDgrSLuzX5ibQ4++ZUqHSBMDs+PxE+OwvAOzcJU7xelWO6lvleDEUswY7Z3lU0lPt/Pz83efPtfCiCmcDsOi0VGg2nrTH+w9eNIKlS3A8OvXQUg3JyJ0zON0YlEihOCkXyImi/bGzQewqd7YsuhW1xPLKuwE4kmcO8a7qbc7nUq+YIiRYZdjc4QOiZAyXxMNee7Ai76y4Jn1T8e18CCOCMpw2DI8VbXUBGeb7ou0ViShKl/9fY8pQ6gWSFKaa+vN5r35mVsDma7PBB33P+fbXJYBT2qy4DI9yNSlLLP/AMl1I0V/EX3TtZD2TW2hK5Vt2TIpduSW7ZYYRTXHYMoD4ELDXJEA7UgqtBodk9h7rbu6GxnHtIp/qZwu7Q+JfJGo0T1+/Yd/iBnN/cngvoaCt4zpZSABBXKpxhnMU2zWGXXBaDQaUMyPHMcqBhVSk4u8h1GkXutuAZIzVTJ7fTCRjRFio6AjBytzfaPqQICQ6dFD7YqNHRdgohurPKgHZnjk9fbGv9IMi1LCEbNQQ7dwkKVHCL98qp42TxyFyI9tF4fscDLGmBrJsczqADtGpLmb4rklwpICKIbT6nIU0ldfsI0NSkdIaFJZ27Irr/eLKlc0PIVun1f2MAYzapr83soh2dwsPm0XCbM38edr4G+ubX/JaVA/wblKHwlDSEgxgWIaaOkifZIFk2uSZ4zsDgaHRX3TQ52Vig/i0QNpAi6OwyXmsDsplnCE1MfiA3AEidmrjwl21UaAn+Av/NV+JCkwSmFUdfCMlKimel4r9AXClkUZ07PIrSrvdLEPz8c7v+G6obsqTA+KFcJIgZVaoRmO++YFBYkZkP6j8jVUooqB2PsguTKInHt8ExOt4sPvaGHD3/HHRplvzY86zil6TffD6JfhtUAMinnA6edbxuYywM0V5U4j6T2KahcA6O3Pe9/ga2CvBrnELaIbPH3WYnS6L0MagE9lQiAoQfaRtFDLxZ+1VpyaGYVxoM5ufVJE5W4qrW7SXZNN1CL5ANplMXCgt7ggjp/8CWm/oTdAro7JfJOIKgzPzRixlowr0pDx35uperG9uMoB9j4dyf4DPR6SrTesqySIKs1zCU1CBVrxrlbMe7/Whejo/n0SGHt7LD4LMWVt86kBhqE+NCXa3/lUIXuqxK51oTPFCP0fkf0doKfjmgAjTY9sBUumNUunM/VbbYlyihhHaBPhN5mYjLpRLklMf+F3JVy0DMYeaM3TcD2Ofzct41PrUP1m3/e7w2rw544wd7QQAOARPgzR4UlSRtejyIqSelYMZaihNMJ5vMeMl/bjJK1VV6BvEaxIfaXbW1jL1yhYpIntBDugkc8v1nAsDNxe0ECXBsIthYcgsuL1Kcd1rldtF/eZd490g77F77Him/sox94K95b6c23HXpkI6DenTWbEnAp/QUBT/nkRtTzqq9QkSrg2bo7AlGHwfE2Cyzx+O3AcCKj9W8VO5Bu9oVgfAly+8KSMk1Euvkkgxvda/kNVQeNWN88JEpHHCduXfFKXzkctgscWG5MqbfGWPXPnEGK7CEKmjVU3fJWjjVxl0lCo9lLInm+FooWgvwwLhCni49eOmiSHVAcqHBp1c0Jz3QRy079pFr88OKkPvV0xojTw2eJJLjPGBTcHsmyXLmW1vqxTUNbZ87b/J2SbUPy9o/EK3EYhTc8MKFg9ZxdpBD+ifvQBpLJQaW1SErJQFLUS2OD1+G2F3XszNHfBats1dAL5OlFJP2uXd3zJeUCP2aMddzaKvWxCGc1rDu4oIc4ZlCSITxWpSo+XHd6+h/8xF611/EK+WuEqYWtvlxUX3OHrUMt296o74TlGYjwF20Mp95n02aiVCMjwWBgy9teCCUHFYu0PdzuEYuVSUGHpN1LI/VLQ69kMNU2DmSB0dyZ3anK7QOMr2W61LeCoXCLSjdHG3M1SW1MjcV0nrh89Up6gWVhG7TyRBS9z4o297xnWsBDMr9yA5VUeffJVya8e1f5MZQywa7CPGWaak202UuKS2wBkAJYbi67v0PQ4ziWKsVujST91lkXvRLQZYKOMv1/yxFMz4rpgic2sw8eHllh/njrpitcjXDXT9Ky8pzrXIKPp6lIOHeMM0EYFvxe3mbv5n422R6/lwSNsEr9wv1gIqcObCUQwV7ptKXr9l+Sk4I54wDaIrSIVjY65PpwurWnm5FibyXInG0V4KHICTHRxUsrdb8i99WDKBqoi+nECoLvz2tqgJccLf+izHbhLoccsqoOmbpsHsn5DnvqxuXWuf3b+MghpY7W6zjD84vqwvDEqMKsNpte361D/2LVXqB/WiqtSLLB2RKqmBZFSmGPj6mtYqTXXvxa+eH5ndnTae08cLX7S1kD0Oh4JjX9UiC+fqdPhhP6cHJq+RCxlhS0ITEk9idw0bUHTLSeVWOmudOzkXqvpA4eCSNw6u+rf7UahHSlO6jR4kJ4F5DS/isJqP662vIzSh/cDnU8/fc/lui8BPYf3+w7nH99N9oibscuerJwG1aVz71uuKaof8ZimjpgnYVnVtcx6/SHUwBe/vqHkXx+NwjbSSpNra1iYcfxLGe3T0hAMFHibqRWZ/ne6F9H4uEvvzDLdKcNEQO5LaBAKBQ+0kMmQDTJYKH9Seuz/wmQaNiN1bk7vXA04GyF8OPyLgTgfMlSnPGv17nYRZ472xr2YPo+CO6yxi0qoI+iNbnl/for4PJyMX7L1/QlqpTcR3rF1Nz5jTMzZovfe1bBRGrjuMzHfqr7Y1fahvZr59KJGlzzpQP4EG8lcr9J6t3JbvriLvewZMEuLAHnZamk6jtSR919TMNTjr6A740QC6lJSXlg0i3pEjWOZSFiIKekochx47NGKf1BQgcdDxxCgLX0qn6R/qKV06UBWGy6gEQkQBW/cTiO3sIHvGAM61TCoyhNccN24asebhCl/9vvFehQYdCyeW/Rckek03ZaDAl9KxENdtAqDNRZRTvIuZhm2+yPaRYjR4EgJaChFgMFnkAXQCAYhgcuH/SmVJ+sYcQAqKH4fiK7miAwoGJnl+VwtbMFRSCihCML2+QzxJ0Izn0eBT8EjtYJZ8mAlOpVO/qjyiNYQGYVf+FGJZ0wAFAE3nzcNuPGANf/qb9sH90Iadz9H+vEluGi/1PyS8yqtPuzYEYbCUPCxWEHXmPC2fz0gOcFK8B8D+nexVbfr/2dUm4cUzbBL36a1jpeUdGpVKyJP04lA9VLY/KxfB2myE9sq6ylxjW4eaw5toTWqsR7cAWfhmPOVVU/F7exB1gFaFhkgPay7lp5QRr9ec8gK3Wdxyi7EeP02J7IUw6LO78ytQQUMbYYX1N+7Yg7ZYS+4jh14OolQ/T6dFM0MKg2qhrHqJ1UnyF06E4bftTeiScF151PQUuxY3T9I3KtbvghXzh18iYph5LR4BHAdurhfn21G8bi0M1hU3jF1PMdm7eVu18CKW3xDx5Hu8WoVhu2H9kcOSDcCN0L8bxM96S45zTFgtlAoFUCRXurNlroFkNTfZ0zMdbjkNfIYuHAuHl54vy86nIOFXmviDaF1+quyMIIIhVCayn+5O75eFhOfiMfx2g4in+1m2MXBjhpZ3D551dIyFYmVnRHOQiPeO+GJ86GCn2eG2MIBzUjzLdmIsnqtRArqPsYR9Rk0YNfXB7acPAC5l+Uun68LGGBt+9u2roI0cHNJ8SGj2oUnLW6auKBYkGObyWrMB1LvkCsqgc+RaplqxRRAvFOjrwgzQ5IpCVwsq7+pKBb4K6wBYC/wWFvjY2m5z1gbG29x4ir+YDxRaZM9KbG2xjBw3j9BiPig5v2qT1a961aFZjcfwUaSjUPewcY/MiXlU9zVUEPgzM+ZUC2XS8ZELNmjVAKg9NkoY5EEBDUKmQPYV4CAUXwg3fuKy6k9EUzkGTPTMQDmZXfxnq8nsnOXnfT0Sx9/1YrqpuMmdLXtCxsXejUMgDns0tcXNuCwvVZ09g/GCfNTKF67uR89y9eU/qchkk6HRNFIqnV5El7721kZhd6oKbsMEc8fkDQYcGt3bsobCG79A7UUYLXdaErEjVOEwbHfUhvPSmafbw3jE/WZN2iTo2H2KsO2rorV+2nZTC0XK8VGN9+GeiKkmujxT8ac8IL30O1Y2sHndYZ2oz7/5zT5g8TqV/DnkNjqHVyUmU1/Diuk9b35oV8mg2mqNQDY0FqPUSD0sXcdQV/xIGKTOfi0juPSdvAVnlmjZpO9LAvh/+j2hWKstNtCNRoAClpn6ZY5XufQyX0cynim5J1KnPm2sVk9HwZzf3Po0mlrK9aK6weNS1bCF4rUKjzbV1LCd8hx/qrZt8UJwL47SIuErTI1oTMiTVMl9Or0rnTveYmaftpTv+RTnpI9Y6Zzd9Dokgq26lU4N1HDLZbudF8V5TnNOrW3yfqJSgzxJ8TGIeUvp0x5MVKK1W29nJDdmvMSnn43qDX2LIqAZuH4ZTc6nWQijtevTcTGoIY5FDPJuA1iSd9/WLI4hfXoeujGcLe3LA99jYQ5Yb3mI1wAgRRxczVTVCWp/HUjGLH8ceXyqAoRpB3ZW7jmTnHHJKhIg0vUSGj1SCYRdWXVv4c6jBJDthCogVgJMiJ5lC2wKzaUW2iXk7PEeWTNJH6xT/gVrKAY5rDotqeZGvgTXZwQNuu8gYpbZ6983hBDN6LKFqAa6ZLAVgI/xRTDgjt07tKlLBUOwhxFkeIoQ/oUmebkiNRJ+iwc8Q3UxZ4ca2k+nh7qtPBGtch04efy7Gi7paRuaIJRe/K/+FBENVd2pVPS0BUe72XAP5T+ogWF1XLa8FMrml5Vpr7GV2Wd7qIYjM0u1Hd1LkAE7dYc0k8VZbwoYMpbwrVhLiRc1mvQv3ysMyKZnoqt4LkbID6FbRmbBfNkpJZzZtxq//+/IcQ");
// 4008 bytes of copies with single changed bytes, so that a lone byte is often copied from the last distance after a match.
const SHORT_REPS_SHA256 = "94afc0028b5227fb2a92199b980ddc9bea9cb4a8394ec57f423113e483387670";
const SHORT_REPS = fromBase64("XQAAAQD//////////wBzu5iYotUAnC4AWX5TTjV2lNdEAc0Fi8MXs5LbrS5q53ELYxZPMiVbr5lP/YeKxtCeps9cCr5FkNIH+7WF0DeY0dX8/C1LKV40f1tjvtyudNHYzAVgtJ7K2UXmnfMgfTtMD3EL5PApzNaPSGhg0XjsF2wYfFuwyjr8lwhEgcJDk+2oJDVgq8ARu2TQ1kyCzzXGHN48yxYNgm+Olwdj1f47nlvs6vIQEhtZ4oExD7uKLt1WAXYpyp7m/oMgXwBtYBAv6Sj66bMIzzrTktD+NnCfC7BS89enbAuQatH5nNrXP73XZRpsYWOkwRD2yvQW3GJaK1uf45LNFHAmYP9o2D0ZdwmNLo2MAWKmu5oePhvQQBPmJltCYzVjacda68LMpzfUe1lJFcVUdlHKQx8UU1XpESjsIxWjACpaZqNSILYXkJrpBqZEuUstrKcKycYuKmrQI4mJ6BIl0M+ved/Aw2aMtkQhCCF/dwi4IvAj63maWsql5kPZrmR5jWdqwC3pArhlxWTldkxkdpyny4R+f7VWiEfAOpu2mHIPZktspC4xF07PtpEiAkETDeW4VYkd9Ww1LGBft5J881H2Bg/blgJEjna1Jk+RHuyFpJn/3UN1ahKh0LvtfUJmoIzykOmoKgR38rZ6DTNsAQ91OWnBX4vmcEPugembwzFEXMCdQT5tm6JnIIhFlOBFX32aeHVFcYhNbysD+GNjOhZeaRyj8kBl46ZHwGwykFTT5DYFQsbN1QGD7UirxGj72jZJIuIkIJOoFRERfdvHKx6wagU6E7IQhtikXAn++88MEKluUzM9/ghtq+IDZNzB0ETHYf4ErBMX26gsfXgVkKMqUz4/kPeFVxiCls2uqndnp096+NeTF2ZcO15cAIsuDFlLx4+4Tpgel4QHb4GcuWjcO0nad1VZRcVBYFPcm5VdamdSXp8WibiM60U55Q2RxyRLyUnNhjAoezgOP363sHKkW7rQQxyQLWbcCnZ/sXSklIYpPlA5GdKAR3fd8iVmOiYFda5SbuctHqn6yhetmzKTzm9D1z94j2PAsyKp/dvVJ3r4nBguGT3Bif8tLGdB//xhZuoSnh41B8bGhYtCCpjS1hdEtJ4q/drJ1vd91o3LatGRNXGiry5WwHa/Yudn9X8O66VMYlNpeZE8Ia8QOjsIB9ZJkblVo0cINEJ9DaMzl3IfA0gpTg7fVgP3Pi6CnNQkbRP//3435wA=");

const withDictionary = (stream: Uint8Array, bytes: number): Uint8Array => {
  const copy = stream.slice();
  new DataView(copy.buffer).setUint32(1, bytes, true);
  return copy;
};

test("decodes a stream with repeats of the last distance and lone bytes copied from it", async () => {
  assert.equal(sha256(await decode(SHORT_REPS)), SHORT_REPS_SHA256);
});

test("a match reaches back as far as the dictionary and no further", async () => {
  assert.equal(sha256(await decode(FAR_MATCH)), FAR_SHA256);
  // The match is 5009 back: a dictionary of 5009 is read as 5024 (a multiple of 16), which holds it.
  assert.equal(sha256(await decode(withDictionary(FAR_MATCH, 5009))), FAR_SHA256);
  // One of 5008 does not.
  await assert.rejects(decode(withDictionary(FAR_MATCH, 5008)), MalformedDocumentError);
});

test("a dictionary under 4 KiB is read as 4 KiB, as xz-java does", async () => {
  assert.equal(sha256(await decode(withDictionary(BODY_LC3_LP0_PB2, 0))), BODY_SHA256);
});

test("the memory limit is on the dictionary rounded up to 16 bytes, plus the literal tables", async () => {
  // lc=3, lp=0: 10 KiB, the dictionary, and 12 KiB of literal tables: 99,978 KiB of dictionary is exactly 100,000.
  const kib = 1024;
  assert.equal(new TextDecoder().decode(await decode(withDictionary(HELLO, 99_978 * kib))), "hello lzma\n");
  assert.equal(new TextDecoder().decode(await decode(withDictionary(HELLO, 99_978 * kib + 1))), "hello lzma\n");
  // Rounded up to 16, not 8: 9 to 15 bytes short of the next KiB still land on it.
  assert.equal(new TextDecoder().decode(await decode(withDictionary(HELLO, 99_979 * kib - 16))), "hello lzma\n");
  for (const bytes of [99_979 * kib - 15, 99_979 * kib - 9, 99_979 * kib - 1, 99_979 * kib]) {
    await assert.rejects(decode(withDictionary(HELLO, bytes)), LimitExceededError, String(bytes));
  }
});

test("a dictionary over what xz-java accepts is malformed; one at it is only over the memory limit", async () => {
  await assert.rejects(decode(withDictionary(HELLO, 0x7ffffff1)), MalformedDocumentError);
  await assert.rejects(decode(withDictionary(HELLO, 0x7ffffff0)), LimitExceededError);
});

test("the largest lc/lp/pb byte is a valid one, and the next is not", async () => {
  // CompressorParser wraps the decoder's failure; the reason is on the cause.
  const reason = (error: unknown): string => String((error as Error).cause ?? (error as Error).message);
  const largest = HELLO.slice();
  largest[0] = 224;
  // Whatever it decodes to, it is not refused for its properties.
  const outcome = await decode(largest).then(() => "", reason);
  assert.doesNotMatch(outcome, /properties/);
  const next = HELLO.slice();
  next[0] = 225;
  const refused = await decode(next).then(() => "", reason);
  assert.match(refused, /properties/);
});

test("a declared size with the top bit set is malformed, not a limit", async () => {
  const huge = HELLO.slice();
  const view = new DataView(huge.buffer);
  view.setUint32(5, 0, true);
  view.setUint32(9, 0x80000000, true);
  await assert.rejects(runParser(new LzmaParser(), huge, boundedContext()), MalformedDocumentError);
});

test("a declared size equal to the output cap is not over it", async () => {
  const sized = HELLO.slice();
  new DataView(sized.buffer).setBigUint64(5, 100_000n, true);
  // The cap is 100,000: this is not refused for its size, but for ending before it.
  await assert.rejects(runParser(new LzmaParser(), sized, boundedContext()), MalformedDocumentError);
});

test("a match that ends exactly at the declared size is whole, and one that passes it is malformed", async () => {
  const run = async (size: bigint): Promise<number> => {
    const stream = ZEROS.slice();
    new DataView(stream.buffer).setBigUint64(5, size, true);
    const captured: Captured[] = [];
    const context = new ParseContext({ limits: { maxDecompressionRatio: 1e9 } });
    context.set(CONTEXT_KEYS.PARSER, capturingParser(captured));
    await runParser(new LzmaParser(), stream, context);
    return captured[0]!.bytes.byteLength;
  };
  assert.equal(await run(1_000_000n), 1_000_000);
  await assert.rejects(run(999_999n), MalformedDocumentError);
});
