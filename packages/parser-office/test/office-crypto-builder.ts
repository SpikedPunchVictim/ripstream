import { createCipheriv, createHash } from "node:crypto";

/**
 * A standard (ECMA-376 version 3.2) encrypted package of `plain`, written from MS-OFFCRYPTO 2.3.4.7 and 2.3.6.2 with only node:crypto,
 * so the reader's key derivation is checked against the spec and not against itself.
 */
export function standardEncrypted(plain: Uint8Array, password: string, keyBits: number): { info: Uint8Array; encrypted: Uint8Array } {
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
