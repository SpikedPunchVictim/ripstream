import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_PAYLOAD_SHA256, canonicalQuery, sha256Hex, signV4, uriEncode } from "../src/s3/sigv4.ts";

/*
 * The examples AWS publishes in "Signature Calculations for the Authorization Header: Transferring Payload in a Single
 * Chunk" (Amazon S3 API reference). Each pins the signature for exact inputs, so a mistake in the canonical request, the
 * string to sign or the key derivation fails here and not against a bucket.
 */

const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const now = new Date("2013-05-24T00:00:00Z");

test("GET Object with a Range header signs to AWS's published signature", () => {
  const signed = signV4({
    method: "GET",
    encodedPath: "/test.txt",
    headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9" },
    payloadSha256: EMPTY_PAYLOAD_SHA256,
    region: "us-east-1",
    credentials,
    now,
  });
  assert.equal(signed.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(
    signed.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("PUT Object with a body, a Date header and a storage class signs to AWS's published signature", () => {
  const body = "Welcome to Amazon S3.";
  assert.equal(sha256Hex(body), "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  const signed = signV4({
    method: "PUT",
    encodedPath: `/${uriEncode("test$file.text")}`,
    headers: {
      host: "examplebucket.s3.amazonaws.com",
      date: "Fri, 24 May 2013 00:00:00 GMT",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    },
    payloadSha256: sha256Hex(body),
    region: "us-east-1",
    credentials,
    now,
  });
  assert.equal(signed.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  assert.match(signed.headers.authorization ?? "", /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,/);
});

test("a listing with a query signs to AWS's published signature", () => {
  const signed = signV4({
    method: "GET",
    encodedPath: "/",
    query: [
      ["prefix", "J"],
      ["max-keys", "2"],
    ],
    headers: { host: "examplebucket.s3.amazonaws.com" },
    payloadSha256: EMPTY_PAYLOAD_SHA256,
    region: "us-east-1",
    credentials,
    now,
  });
  assert.equal(signed.signature, "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

test("temporary credentials add x-amz-security-token to what is signed and sent", () => {
  const signed = signV4({
    method: "GET",
    encodedPath: "/k",
    headers: { host: "b.s3.amazonaws.com" },
    payloadSha256: EMPTY_PAYLOAD_SHA256,
    region: "us-east-1",
    credentials: { ...credentials, sessionToken: "TOKEN" },
    now,
  });
  assert.equal(signed.headers["x-amz-security-token"], "TOKEN");
  assert.match(signed.headers.authorization ?? "", /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
});

test("a request with no host is refused", () => {
  assert.throws(
    () => signV4({ method: "GET", encodedPath: "/", headers: {}, payloadSha256: EMPTY_PAYLOAD_SHA256, region: "r", credentials, now }),
    /host header/,
  );
});

test("uriEncode leaves unreserved characters, encodes the rest as UTF-8 bytes, and keeps `/` only when asked", () => {
  assert.equal(uriEncode("a-b_c.d~e"), "a-b_c.d~e");
  assert.equal(uriEncode("a b/c"), "a%20b%2Fc");
  assert.equal(uriEncode("a b/c", true), "a%20b/c");
  assert.equal(uriEncode("é€"), "%C3%A9%E2%82%AC");
  assert.equal(uriEncode("a+b=c&d"), "a%2Bb%3Dc%26d");
});

test("the canonical query is sorted by encoded key, then value, and encodes both", () => {
  assert.equal(
    canonicalQuery([
      ["prefix", "a b"],
      ["list-type", "2"],
      ["continuation-token", "x/y="],
    ]),
    "continuation-token=x%2Fy%3D&list-type=2&prefix=a%20b",
  );
  assert.equal(canonicalQuery(), "");
});
