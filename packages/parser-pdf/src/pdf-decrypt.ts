import { createDecipheriv, createCipheriv, createHash } from "node:crypto";
import { dictEntries, parseName, parseReference, parseString } from "./pdf-syntax.ts";

/**
 * The standard security handler (ISO 32000-2 7.6.4), read-only and for the user password only: enough to decrypt a
 * stream so the structural checks can look inside an encrypted file the way pdf.js will. RC4 and AES-128 (revisions
 * 2-4) and AES-256 (revisions 5-6).
 */

/** Decrypts one stream's raw data; null when it does not decrypt. */
export type StreamDecryptor = (num: number, gen: number, data: string) => string | null;

const PADDING = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");

/**
 * A decryptor for the file's streams, or null when the file is not encrypted with the standard handler or the password
 * (empty by default) is not its user password.
 */
export function streamDecryptor(text: string, password = ""): StreamDecryptor | null {
  const encrypt = encryptDictionary(text);
  if (encrypt === null || parseName(encrypt.get("Filter")) !== "Standard") return null;
  const version = Number(encrypt.get("V") ?? 0);
  const revision = Number(encrypt.get("R"));
  const owner = Buffer.from(parseString(encrypt.get("O")) ?? "", "latin1");
  const user = Buffer.from(parseString(encrypt.get("U")) ?? "", "latin1");
  const method = cryptMethod(encrypt, version);
  if (method === null) return null;
  if (method === "Identity") return (_num, _gen, data) => data;

  if (revision >= 5) {
    const key = aes256FileKey(revision, password, user, Buffer.from(parseString(encrypt.get("UE")) ?? "", "latin1"));
    return key === null ? null : (_num, _gen, data) => aesDecrypt("aes-256-cbc", key, data);
  }

  const id = fileId(text);
  const length = revision === 2 ? 5 : Math.min(16, Math.max(5, Math.floor(Number(encrypt.get("Length") ?? 40) / 8)));
  const permissions = Number(encrypt.get("P"));
  if (!Number.isInteger(permissions) || owner.length < 32) return null;
  const encryptMetadata = encrypt.get("EncryptMetadata")?.trim() !== "false";
  const key = rc4FileKey(password, owner, permissions, Buffer.from(id, "latin1"), revision, length, encryptMetadata);
  if (!userPasswordMatches(key, revision, user, Buffer.from(id, "latin1"))) return null;
  return (num, gen, data) => {
    const salt = method === "AESV2" ? Buffer.from("sAlT", "latin1") : Buffer.alloc(0);
    const objectKey = createHash("md5")
      .update(key)
      .update(Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]))
      .update(salt)
      .digest()
      .subarray(0, Math.min(16, length + 5));
    if (method === "AESV2") return aesDecrypt("aes-128-cbc", objectKey, data);
    return rc4(objectKey, Buffer.from(data, "latin1")).toString("latin1");
  };
}

function fileId(text: string): string {
  return parseString(/\/ID\s*\[\s*((?:<[^>]*>|\((?:[^()\\]|\\[\s\S])*\)))/.exec(text.slice(-65536))?.[1] ?? "") ?? "";
}

/**
 * Whether `password` is the file's owner password (algorithm 7 for revisions 2-4, 2.A for 5 and 6). PDFBox, and so Tika,
 * grants every permission to the owner whatever /P says. False for a file that is not encrypted with the standard handler.
 */
export function ownerPasswordMatches(text: string, password = ""): boolean {
  const encrypt = encryptDictionary(text);
  if (encrypt === null || parseName(encrypt.get("Filter")) !== "Standard") return false;
  const revision = Number(encrypt.get("R"));
  const owner = Buffer.from(parseString(encrypt.get("O")) ?? "", "latin1");
  const user = Buffer.from(parseString(encrypt.get("U")) ?? "", "latin1");
  if (revision >= 5) {
    if (owner.length < 48 || user.length < 48) return false;
    const secret = Buffer.from(password, "utf8").subarray(0, 127);
    const userData = user.subarray(0, 48);
    const hash = revision === 5 ? createHash("sha256").update(secret).update(owner.subarray(32, 40)).update(userData).digest() : hash2B(secret, owner.subarray(32, 40), userData);
    return hash.equals(owner.subarray(0, 32));
  }
  if (owner.length < 32 || !Number.isInteger(Number(encrypt.get("P")))) return false;
  const length = revision === 2 ? 5 : Math.min(16, Math.max(5, Math.floor(Number(encrypt.get("Length") ?? 40) / 8)));
  const padded = Buffer.concat([Buffer.from(password, "latin1").subarray(0, 32), PADDING]).subarray(0, 32);
  let ownerKey = createHash("md5").update(padded).digest();
  if (revision >= 3) for (let i = 0; i < 50; i++) ownerKey = createHash("md5").update(ownerKey).digest();
  ownerKey = ownerKey.subarray(0, length);
  let userPassword: Buffer = owner.subarray(0, 32);
  if (revision === 2) userPassword = rc4(ownerKey, userPassword);
  else for (let i = 19; i >= 0; i--) userPassword = rc4(Buffer.from(ownerKey.map((byte) => byte ^ i)), userPassword);
  const id = Buffer.from(fileId(text), "latin1");
  const encryptMetadata = encrypt.get("EncryptMetadata")?.trim() !== "false";
  const key = rc4FileKey(userPassword.toString("latin1"), owner, Number(encrypt.get("P")), id, revision, length, encryptMetadata);
  return userPasswordMatches(key, revision, user, id);
}

/** The trailer's /Encrypt dictionary entries, direct or by reference, or null. */
function encryptDictionary(text: string): Map<string, string> | null {
  const at = text.lastIndexOf("/Encrypt");
  if (at === -1) return null;
  const after = text.slice(at + "/Encrypt".length, at + "/Encrypt".length + 32);
  if (/^\s*<</.test(after)) return dictEntries(text, at);
  const ref = parseReference(/^\s*(\d+\s+\d+\s+R)/.exec(after)?.[1]);
  if (ref === null) return null;
  const header = new RegExp(`(?<![0-9])${ref.num}\\s+${ref.gen}\\s+obj\\b`, "g");
  let last = -1;
  for (const match of text.matchAll(header)) last = match.index + match[0].length;
  return last === -1 ? null : dictEntries(text, last, Math.min(text.length, last + 4096));
}

type CryptMethod = "RC4" | "AESV2" | "AESV3" | "Identity";

function cryptMethod(encrypt: ReadonlyMap<string, string>, version: number): CryptMethod | null {
  if (version === 1 || version === 2) return "RC4";
  if (version !== 4 && version !== 5) return null;
  const filter = parseName(encrypt.get("StmF")) ?? "Identity";
  if (filter === "Identity") return "Identity";
  const filters = dictEntries(encrypt.get("CF") ?? "");
  const method = parseName(dictEntries(filters.get(filter) ?? "").get("CFM")) ?? "None";
  if (method === "V2") return "RC4";
  if (method === "AESV2" || method === "AESV3") return method;
  if (method === "None") return "Identity";
  return null;
}

/** Algorithm 2: the RC4/AES-128 file key from the user password. */
function rc4FileKey(
  password: string,
  owner: Buffer,
  permissions: number,
  id: Buffer,
  revision: number,
  length: number,
  encryptMetadata: boolean,
): Buffer {
  const padded = Buffer.concat([Buffer.from(password, "latin1").subarray(0, 32), PADDING]).subarray(0, 32);
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions | 0);
  const hash = createHash("md5").update(padded).update(owner.subarray(0, 32)).update(p).update(id);
  if (revision >= 4 && !encryptMetadata) hash.update(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  let key = hash.digest().subarray(0, length);
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) key = createHash("md5").update(key).digest().subarray(0, length);
  }
  return key;
}

/** Algorithms 4 and 5: does the key decrypt /U to what the empty-padding user password gives? */
function userPasswordMatches(key: Buffer, revision: number, user: Buffer, id: Buffer): boolean {
  if (revision === 2) return rc4(key, PADDING).equals(user.subarray(0, 32));
  let value: Buffer = createHash("md5").update(PADDING).update(id).digest();
  for (let i = 0; i < 20; i++) {
    value = rc4(Buffer.from(key.map((byte) => byte ^ i)), value);
  }
  return value.equals(user.subarray(0, 16));
}

/** Algorithms 2.A and 2.B: the AES-256 file key from the user password and /UE, or null when the password is wrong. */
function aes256FileKey(revision: number, password: string, user: Buffer, userKey: Buffer): Buffer | null {
  if (user.length < 48 || userKey.length < 32) return null;
  const secret = Buffer.from(password, "utf8").subarray(0, 127);
  const hash = (salt: Buffer): Buffer => (revision === 5 ? createHash("sha256").update(secret).update(salt).digest() : hash2B(secret, salt));
  if (!hash(user.subarray(32, 40)).equals(user.subarray(0, 32))) return null;
  const decipher = createDecipheriv("aes-256-cbc", hash(user.subarray(40, 48)), Buffer.alloc(16));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(userKey.subarray(0, 32)), decipher.final()]);
}

/** Algorithm 2.B (revision 6); `userData` is the 48 bytes of /U when the password is tried as the owner password. */
function hash2B(password: Buffer, salt: Buffer, userData: Buffer = Buffer.alloc(0)): Buffer {
  let key = createHash("sha256").update(password).update(salt).update(userData).digest();
  for (let round = 0; ; round++) {
    const block = Buffer.concat([password, key, userData]);
    const repeated = Buffer.concat(Array.from({ length: 64 }, () => block));
    const cipher = createCipheriv("aes-128-cbc", key.subarray(0, 16), key.subarray(16, 32));
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(repeated), cipher.final()]);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += encrypted[i]!;
    const algorithm = ["sha256", "sha384", "sha512"][sum % 3]!;
    key = createHash(algorithm).update(encrypted).digest();
    if (round >= 63 && encrypted[encrypted.length - 1]! <= round - 31) break;
  }
  return key.subarray(0, 32);
}

function aesDecrypt(algorithm: "aes-128-cbc" | "aes-256-cbc", key: Buffer, data: string): string | null {
  const bytes = Buffer.from(data, "latin1");
  const blocks = Math.floor((bytes.length - 16) / 16);
  if (blocks < 1) return "";
  try {
    const decipher = createDecipheriv(algorithm, key, bytes.subarray(0, 16));
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(bytes.subarray(16, 16 + blocks * 16)), decipher.final()]);
    const pad = plain[plain.length - 1]!;
    return plain.subarray(0, pad >= 1 && pad <= 16 ? plain.length - pad : plain.length).toString("latin1");
  } catch {
    return null;
  }
}

function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + state[i]! + key[i % key.length]!) & 0xff;
    [state[i], state[j]] = [state[j]!, state[i]!];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + state[i]!) & 0xff;
    [state[i], state[j]] = [state[j]!, state[i]!];
    out[n] = data[n]! ^ state[(state[i]! + state[j]!) & 0xff]!;
  }
  return out;
}
