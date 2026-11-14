import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";

/**
 * ECMA-376 package decryption (standard and agile), ported from POI's StandardDecryptor/AgileDecryptor. Only the parts
 * an OOXML package uses: AES in ECB (standard) or CBC (agile), SHA-1/SHA-256/SHA-512 password hashing, and the agile
 * per-segment IVs and HMAC integrity check. It returns the decrypted ZIP bytes, or null when the password is wrong.
 */

const DEFAULT_PASSWORD = "VelvetSweatshop";

type HashName = "sha1" | "sha256" | "sha512";

interface AgileParameters {
  readonly hashName: HashName;
  readonly hashSize: number;
  readonly cipher: string;
  readonly keyBytes: number;
  readonly blockSize: number;
  readonly spinCount: number;
  /** The verifier's salt (the encryptedKey element), used for the password-encrypted fields. */
  readonly salt: Buffer;
  /** KeyData.saltValue, the header key salt, used for the package segments and the HMAC. */
  readonly keySalt: Buffer;
  readonly encryptedVerifierInput: Buffer;
  readonly encryptedVerifierHash: Buffer;
  readonly encryptedKey: Buffer;
  readonly encryptedHmacKey: Buffer | null;
  readonly encryptedHmacValue: Buffer | null;
}

interface StandardParameters {
  readonly keyBytes: number;
  readonly salt: Buffer;
  readonly encryptedVerifier: Buffer;
  readonly encryptedVerifierHash: Buffer;
}

/** The package inside an OLE2 encrypted-package container, decrypted with one of the candidate passwords. */
export function decryptOoxmlPackage(
  info: Uint8Array,
  encryptedPackage: Uint8Array,
  passwords: readonly string[],
): Uint8Array | null {
  const versionMajor = readU16(info, 0)!;
  const versionMinor = readU16(info, 2)!;
  if (versionMajor === 4 && versionMinor === 4) {
    const parameters = agileParameters(info);
    if (parameters === null) return null;
    for (const password of passwords) {
      const result = decryptAgile(parameters, password, encryptedPackage);
      if (result !== null) return result;
    }
    return null;
  }
  if ((versionMajor === 3 || versionMajor === 4) && versionMinor === 2) {
    const parameters = standardParameters(info);
    if (parameters === null) return null;
    for (const password of passwords) {
      const result = decryptStandard(parameters, password, encryptedPackage);
      if (result !== null) return result;
    }
    return null;
  }
  return null;
}

export function defaultOfficePasswords(): string[] {
  return [DEFAULT_PASSWORD];
}

function agileParameters(info: Uint8Array): AgileParameters | null {
  // 2 version shorts + flags + reserved, then the XML descriptor.
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(info.subarray(8));
  const keyData = attributes(xml, "keyData");
  const encryptedKey = attributes(xml, "encryptedKey");
  if (keyData === null || encryptedKey === null) return null;
  const hashName = hashOf(encryptedKey.hashAlgorithm ?? keyData.hashAlgorithm ?? "SHA1");
  if (hashName === null) return null;
  const keyBits = Number(keyData.keyBits ?? encryptedKey.keyBits ?? "128");
  const blockSize = Number(keyData.blockSize ?? "16");
  const hashSize = Number(encryptedKey.hashSize ?? keyData.hashSize ?? String(hashLength(hashName)));
  const keySalt = base64(keyData.saltValue);
  const salt = base64(encryptedKey.saltValue ?? keyData.saltValue);
  const key = base64(encryptedKey.encryptedKeyValue);
  const input = base64(encryptedKey.encryptedVerifierHashInput);
  const hash = base64(encryptedKey.encryptedVerifierHashValue);
  if (keySalt === null || salt === null || key === null || input === null || hash === null) return null;
  const integrity = attributes(xml, "dataIntegrity");
  return {
    hashName,
    hashSize,
    cipher: keyBits === 256 ? "aes-256-cbc" : keyBits === 192 ? "aes-192-cbc" : "aes-128-cbc",
    keyBytes: keyBits / 8,
    blockSize,
    spinCount: Number(encryptedKey.spinCount ?? keyData.spinCount ?? "100000"),
    salt,
    keySalt,
    encryptedVerifierInput: input,
    encryptedVerifierHash: hash,
    encryptedKey: key,
    encryptedHmacKey: integrity === null ? null : base64(integrity.encryptedHmacKey),
    encryptedHmacValue: integrity === null ? null : base64(integrity.encryptedHmacValue),
  };
}

function decryptAgile(parameters: AgileParameters, password: string, encryptedPackage: Uint8Array): Uint8Array | null {
  const pwHash = hashPassword(password, parameters.hashName, parameters.salt, parameters.spinCount);
  const iv = generateIv(parameters.hashName, parameters.salt, null, parameters.blockSize);
  const input = decryptCbc(
    parameters.cipher,
    generateKey(pwHash, parameters.hashName, Buffer.from([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]), parameters.keyBytes),
    iv,
    padToBlock(parameters.encryptedVerifierInput, parameters.blockSize),
  );
  const verifierHash = hash(parameters.hashName, input);
  const decryptedHash = decryptCbc(
    parameters.cipher,
    generateKey(pwHash, parameters.hashName, Buffer.from([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]), parameters.keyBytes),
    iv,
    padToBlock(parameters.encryptedVerifierHash, parameters.blockSize),
  );
  if (!timingEqual(decryptedHash.subarray(0, parameters.hashSize), verifierHash.subarray(0, parameters.hashSize))) return null;

  const packageKey = decryptCbc(
    parameters.cipher,
    generateKey(pwHash, parameters.hashName, Buffer.from([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]), parameters.keyBytes),
    iv,
    padToBlock(parameters.encryptedKey, parameters.blockSize),
  ).subarray(0, parameters.keyBytes);

  if (parameters.encryptedHmacKey !== null && parameters.encryptedHmacValue !== null) {
    const hmacKey = decryptCbc(
      parameters.cipher,
      packageKey,
      generateIv(parameters.hashName, parameters.keySalt, Buffer.from([0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6]), parameters.blockSize),
      padToBlock(parameters.encryptedHmacKey, parameters.blockSize),
    ).subarray(0, parameters.hashSize);
    const hmacValue = decryptCbc(
      parameters.cipher,
      packageKey,
      generateIv(parameters.hashName, parameters.keySalt, Buffer.from([0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33]), parameters.blockSize),
      padToBlock(parameters.encryptedHmacValue, parameters.blockSize),
    ).subarray(0, parameters.hashSize);
    const mac = createHmac(algorithmHash(parameters.hashName), hmacKey).update(encryptedPackage).digest();
    if (!timingEqual(mac, hmacValue)) return null;
  }
  return decryptAgilePackage(parameters, packageKey, encryptedPackage);
}

function decryptAgilePackage(parameters: AgileParameters, key: Buffer, encryptedPackage: Uint8Array): Uint8Array | null {
  if (encryptedPackage.length < 8) return null;
  const length = Number(readU64(encryptedPackage, 0));
  if (!Number.isSafeInteger(length) || length < 0) return null;
  const data = encryptedPackage.subarray(8);
  const out = Buffer.alloc(length);
  let written = 0;
  let offset = 0;
  for (let segment = 0; offset < data.length; segment++) {
    const chunk = data.subarray(offset, offset + 4096);
    offset += 4096;
    const iv = generateIv(parameters.hashName, parameters.keySalt, int32Le(segment), parameters.blockSize);
    let plain = decryptCbc(parameters.cipher, key, iv, chunk);
    if (offset >= data.length) plain = stripPkcs7(plain, parameters.blockSize);
    const take = Math.min(plain.length, length - written);
    plain.copy(out, written, 0, take);
    written += take;
  }
  return written === length ? new Uint8Array(out) : null;
}

function standardParameters(info: Uint8Array): StandardParameters | null {
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
  if (info.length < 36) return null;
  let offset = 4; // version shorts
  offset += 4; // encryption flags
  offset += 4; // header size
  offset += 4; // header flags
  offset += 4; // size extra
  const algorithm = view.getUint32(offset, true);
  offset += 4;
  offset += 4; // hash algorithm id
  const keyBits = view.getUint32(offset, true);
  offset += 4;
  offset += 4; // provider type
  offset += 8; // reserved
  if (offset + 4 > info.length) return null;
  const check = view.getUint32(offset, true);
  if (check !== 16) {
    // CSP name: UTF-16LE up to and including a NUL code unit; when the next int is the salt size the name is omitted.
    while (offset + 2 <= info.length && (info[offset] !== 0 || info[offset + 1] !== 0)) offset += 2;
    offset += 2;
  }
  if (offset + 4 > info.length) return null;
  const saltSize = view.getUint32(offset, true);
  offset += 4;
  if (saltSize !== 16 || offset + 16 + 16 + 4 + 32 > info.length) return null;
  const salt = Buffer.from(info.subarray(offset, offset + 16));
  offset += 16;
  const encryptedVerifier = Buffer.from(info.subarray(offset, offset + 16));
  offset += 16;
  offset += 4; // verifier hash size: standard encryption is SHA-1, whose encrypted hash is 32 bytes with AES
  const encryptedVerifierHash = Buffer.from(info.subarray(offset, offset + 32));
  if (algorithm < 0x660e || algorithm > 0x6610 || (keyBits !== 128 && keyBits !== 192 && keyBits !== 256)) return null;
  return { keyBytes: keyBits / 8, salt, encryptedVerifier, encryptedVerifierHash };
}

function decryptStandard(parameters: StandardParameters, password: string, encryptedPackage: Uint8Array): Uint8Array | null {
  const pwHash = hashPassword(password, "sha1", parameters.salt, 50_000);
  const finalHash = generateKey(pwHash, "sha1", Buffer.alloc(4), 20);
  const x1 = hash("sha1", xorFill(finalHash, 0x36));
  const x2 = hash("sha1", xorFill(finalHash, 0x5c));
  const key = Buffer.concat([x1, x2]).subarray(0, parameters.keyBytes);
  const cipher = parameters.keyBytes === 256 ? "aes-256-ecb" : parameters.keyBytes === 192 ? "aes-192-ecb" : "aes-128-ecb";

  const verifier = decryptEcb(cipher, key, parameters.encryptedVerifier);
  const verifierHash = hash("sha1", verifier);
  const decrypted = decryptEcb(cipher, key, parameters.encryptedVerifierHash);
  if (!timingEqual(decrypted.subarray(0, verifierHash.length), verifierHash)) return null;

  if (encryptedPackage.length < 8) return null;
  const length = Number(readU64(encryptedPackage, 0));
  if (!Number.isSafeInteger(length) || length < 0) return null;
  const plain = decryptEcb(cipher, key, encryptedPackage.subarray(8, 8 + Math.ceil(length / 16) * 16));
  return plain.length >= length ? new Uint8Array(plain.subarray(0, length)) : null;
}

function attributes(xml: string, element: string): Record<string, string> | null {
  const match = new RegExp(`<(?:(?:\\w+):)?${element}\\b([^>]*)>`).exec(xml);
  if (match === null) return null;
  const values: Record<string, string> = {};
  for (const attribute of match[1]!.matchAll(/([A-Za-z]+)="([^"]*)"/g)) values[attribute[1]!] = attribute[2]!;
  return values;
}

function hashPassword(password: string, name: HashName, salt: Buffer, spinCount: number): Buffer {
  const initial = hash(name, salt, Buffer.from(password, "utf16le"));
  let current = initial;
  for (let index = 0; index < spinCount; index++) current = hash(name, int32Le(index), current);
  return current;
}

function generateKey(passwordHash: Buffer, name: HashName, blockKey: Buffer, size: number): Buffer {
  return pad36(hash(name, passwordHash, blockKey), size);
}

function generateIv(name: HashName, salt: Buffer, blockKey: Buffer | null, blockSize: number): Buffer {
  return blockKey === null ? pad36(salt, blockSize) : pad36(hash(name, salt, blockKey), blockSize);
}

function pad36(value: Buffer, size: number): Buffer {
  const out = Buffer.alloc(size, 0x36);
  value.copy(out, 0, 0, Math.min(value.length, size));
  return out;
}

function xorFill(value: Buffer, fill: number): Buffer {
  const out = Buffer.alloc(64, fill);
  for (let index = 0; index < value.length && index < out.length; index++) out[index] = out[index]! ^ value[index]!;
  return out;
}

function decryptCbc(cipher: string, key: Buffer, iv: Buffer, data: Uint8Array): Buffer {
  const decipher = createDecipheriv(cipher, key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function decryptEcb(cipher: string, key: Buffer, data: Uint8Array): Buffer {
  const padded = padToBlock(data, 16);
  const decipher = createDecipheriv(cipher, key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(padded), decipher.final()]);
}

function stripPkcs7(value: Buffer, blockSize: number): Buffer {
  if (value.length === 0) return value;
  const pad = value[value.length - 1]!;
  if (pad > 0 && pad <= blockSize && pad <= value.length) return value.subarray(0, value.length - pad);
  return value;
}

function padToBlock(value: Uint8Array, blockSize: number): Uint8Array {
  const size = Math.ceil(value.length / blockSize) * blockSize;
  if (size === value.length) return value;
  const out = Buffer.alloc(size);
  Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(out);
  return out;
}

function hash(name: HashName, ...parts: Buffer[]): Buffer {
  const digest = createHash(name);
  for (const part of parts) digest.update(part);
  return digest.digest();
}

function algorithmHash(name: HashName): string {
  return name === "sha1" ? "sha1" : name === "sha256" ? "sha256" : "sha512";
}

function hashOf(value: string): HashName | null {
  const name = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (name === "sha1") return "sha1";
  if (name === "sha256") return "sha256";
  if (name === "sha512") return "sha512";
  return null;
}

function hashLength(name: HashName): number {
  return name === "sha1" ? 20 : name === "sha256" ? 32 : 64;
}

function base64(value: string | undefined): Buffer | null {
  return value === undefined ? null : Buffer.from(value, "base64");
}

function int32Le(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function readU16(data: Uint8Array, offset: number): number | null {
  return offset + 2 <= data.length ? (data[offset]! | (data[offset + 1]! << 8)) : null;
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function timingEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && createHash("sha256").update(left).digest().equals(createHash("sha256").update(right).digest());
}
