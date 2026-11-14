import assert from "node:assert/strict";
import { test } from "node:test";
import { createCipheriv, createHash } from "node:crypto";
import { decryptOoxmlPackage } from "../src/office-crypto.ts";

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

/**
 * A standard (ECMA-376 version 3.2) encrypted package of `plain`, written from MS-OFFCRYPTO 2.3.4.7 and 2.3.6.2 with only node:crypto,
 * so the reader's key derivation is checked against the spec and not against itself.
 */
function standardEncrypted(plain: Uint8Array, password: string, keyBits: number): { info: Uint8Array; encrypted: Uint8Array } {
  const sha1 = (...parts: Buffer[]): Buffer => parts.reduce((digest, part) => digest.update(part), createHash("sha1")).digest();
  const le32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
  };
  const salt = Buffer.from("0123456789abcdef");
  let current = sha1(salt, Buffer.from(password, "utf16le"));
  for (let index = 0; index < 50_000; index++) current = sha1(le32(index), current);
  const finalHash = sha1(current, le32(0));
  const fill = (byte: number): Buffer => {
    const out = Buffer.alloc(64, byte);
    finalHash.forEach((value, index) => (out[index] = out[index]! ^ value));
    return out;
  };
  const key = Buffer.concat([sha1(fill(0x36)), sha1(fill(0x5c))]).subarray(0, keyBits / 8);
  const cipher = `aes-${keyBits}-ecb`;
  const encrypt = (data: Buffer): Buffer => {
    const encryptor = createCipheriv(cipher, key, null);
    encryptor.setAutoPadding(false);
    return Buffer.concat([encryptor.update(data), encryptor.final()]);
  };
  const verifier = Buffer.from("verifier-bytes!!");
  const verifierHash = Buffer.concat([sha1(verifier), Buffer.alloc(12)]);
  const algorithm = keyBits === 128 ? 0x660e : keyBits === 192 ? 0x660f : 0x6610;
  const csp = Buffer.from("Microsoft Enhanced RSA and AES Cryptographic Provider\0", "utf16le");
  const header = Buffer.concat([le32(0x24), le32(0), le32(algorithm), le32(0x8004), le32(keyBits), le32(0x18), le32(0), le32(0), csp]);
  const info = Buffer.concat([
    Buffer.from([3, 0, 2, 0]), le32(0x24), le32(header.length), header,
    le32(16), salt, encrypt(verifier), le32(20), encrypt(verifierHash),
  ]);
  const padded = Buffer.alloc(Math.ceil(plain.length / 16) * 16);
  Buffer.from(plain).copy(padded);
  const length = Buffer.alloc(8);
  length.writeUInt32LE(plain.length);
  return { info, encrypted: Buffer.concat([length, encrypt(padded)]) };
}

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
