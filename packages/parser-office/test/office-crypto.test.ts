import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptOoxmlPackage } from "../src/office-crypto.ts";
import { standardEncrypted } from "./office-crypto-builder.ts";

const b64 = (text: string): string => Buffer.from(text).toString("base64");

/** An agile EncryptionInfo stream with the given encryptedKey/keyData attributes. */
function agileInfo(extra: string, keyBits = 128): Uint8Array {
  const xml =
    `<encryption><keyData saltValue="${b64("saltsaltsaltsalt")}" keyBits="${keyBits}" blockSize="16" hashAlgorithm="SHA512"/>` +
    `<keyEncryptors><keyEncryptor><p:encryptedKey xmlns:p="x" ${extra} saltValue="${b64("saltsaltsaltsalt")}" ` +
    `encryptedKeyValue="${b64("0123456789abcdef")}" encryptedVerifierHashInput="${b64("0123456789abcdef")}" ` +
    `encryptedVerifierHashValue="${b64("0123456789abcdef0123456789abcdef")}"/></keyEncryptor></keyEncryptors></encryption>`;
  return new Uint8Array([4, 0, 4, 0, 0x40, 0, 0, 0, ...Buffer.from(xml)]);
}

// tikajs-ybtt: spinCount is attacker-controlled and drives a synchronous hash loop before any password check.
test("agile encryption with a spinCount past the MS-OFFCRYPTO maximum is refused without hashing", () => {
  const started = performance.now();
  assert.equal(decryptOoxmlPackage(agileInfo('spinCount="4000000000"'), new Uint8Array(64), ["pw"]), null);
  assert.equal(decryptOoxmlPackage(agileInfo('spinCount="-1"'), new Uint8Array(64), ["pw"]), null);
  assert.equal(decryptOoxmlPackage(agileInfo('spinCount="NaN"'), new Uint8Array(64), ["pw"]), null);
  assert.ok(performance.now() - started < 1000);
});

test("agile encryption with an unsupported key size is refused", () => {
  assert.equal(decryptOoxmlPackage(agileInfo('spinCount="1"', 100), new Uint8Array(64), ["pw"]), null);
});

test("agile encryption with a small spinCount still reaches the password check", () => {
  assert.equal(decryptOoxmlPackage(agileInfo('spinCount="10" hashSize="64"'), new Uint8Array(64), ["pw"]), null);
});

// B22 (bughunt): the cipher was picked by comparing the key size in BYTES with 256 and 192, so a standard AES-256 or AES-192 package
// was read with aes-128 and a 32-byte key, which node refuses, and every such package read as a wrong password. Oracle: not available,
// Tika has no password for these; the reader is checked against a package written from the specification.
for (const keyBits of [128, 192, 256]) {
  test(`a standard encrypted package with a ${keyBits}-bit key is decrypted`, () => {
    const plain = new TextEncoder().encode("PK-package-bytes-that-are-longer-than-a-block");
    const { info, encrypted } = standardEncrypted(plain, "secret", keyBits);
    assert.deepEqual(decryptOoxmlPackage(info, encrypted, ["wrong", "secret"]), plain);
    assert.equal(decryptOoxmlPackage(info, encrypted, ["wrong"]), null);
  });
}
