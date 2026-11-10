import { createHash } from "node:crypto";
import type { Metadata } from "./metadata.ts";
import { CONTEXT_KEYS, type ParseContext } from "./parse-context.ts";
import type { RipstreamInputStream } from "./ripstream-input-stream.ts";
import { CONTENT_LENGTH } from "./tika-keys.ts";

/*
 * Tika's digesters (tika-core 4.2.0: DigestDef, InputStreamDigester, CompositeDigester, DigestHelper; the Commons and
 * BouncyCastle factories of tika-parser-digest-commons): a digest of the whole document under `tk:digest:<ALGORITHM>`,
 * with the encoding appended when it is not hex.
 *
 * Tika digests in AutoDetectParser.parse, before it detects the type, for the container and for every embedded document
 * (which enters the same method). Ripstream does the same in AutoDetectParser. Reading the whole document is not a
 * parser's read: the stream keeps what it read (in memory, then in a temporary file) and is put back where it was.
 */

/** The names a configuration gives algorithms (Tika's DigestDef.Algorithm). */
export const DIGEST_ALGORITHMS = ["MD2", "MD5", "SHA1", "SHA256", "SHA384", "SHA512", "SHA3_256", "SHA3_384", "SHA3_512"] as const;
export type DigestAlgorithm = (typeof DIGEST_ALGORITHMS)[number];

export const DIGEST_ENCODINGS = ["HEX", "BASE32", "BASE64"] as const;
export type DigestEncoding = (typeof DIGEST_ENCODINGS)[number];

export interface DigestDef {
  readonly algorithm: DigestAlgorithm;
  readonly encoding: DigestEncoding;
}

export interface DigestSettings {
  /** Tika's default, when a factory names none, is MD5 in hex. */
  readonly digests: readonly DigestDef[];
  /** Digest the embedded documents only: a document at depth 0, the container, is left alone. */
  readonly skipContainerDocumentDigest: boolean;
}

/** The algorithm's Java Security name, which is what the metadata key carries (`SHA-256`, `SHA3-512`). */
const JAVA_NAMES: Readonly<Record<DigestAlgorithm, string>> = {
  MD2: "MD2",
  MD5: "MD5",
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA384: "SHA-384",
  SHA512: "SHA-512",
  SHA3_256: "SHA3-256",
  SHA3_384: "SHA3-384",
  SHA3_512: "SHA3-512",
};

/** `tk:digest:MD5` for hex, `tk:digest:SHA-256:BASE32` for the others (DigestDef.metadataKey). */
export function digestKey(def: DigestDef): string {
  return `tk:digest:${JAVA_NAMES[def.algorithm]}${def.encoding === "HEX" ? "" : `:${def.encoding}`}`;
}

export interface Hasher {
  update(chunk: Uint8Array): void;
  digest(): Uint8Array;
}

/** What OpenSSL calls the algorithms node:crypto computes. */
const OPENSSL_NAMES: Readonly<Record<Exclude<DigestAlgorithm, "MD2">, string>> = {
  MD5: "md5",
  SHA1: "sha1",
  SHA256: "sha256",
  SHA384: "sha384",
  SHA512: "sha512",
  SHA3_256: "sha3-256",
  SHA3_384: "sha3-384",
  SHA3_512: "sha3-512",
};

/** Node's OpenSSL has no MD2, so it is computed here; the others are node:crypto's. */
export function createHasher(algorithm: DigestAlgorithm): Hasher {
  if (algorithm === "MD2") return new Md2();
  const hash = createHash(OPENSSL_NAMES[algorithm]);
  return { update: (chunk) => void hash.update(chunk), digest: () => new Uint8Array(hash.digest()) };
}

/** RFC 1319's substitution table: the digits of pi, shuffled. */
const MD2_S = Uint8Array.from([
  41, 46, 67, 201, 162, 216, 124, 1, 61, 54, 84, 161, 236, 240, 6, 19, 98, 167, 5, 243, 192, 199, 115, 140, 152, 147, 43, 217, 188, 76, 130, 202, 30,
  155, 87, 60, 253, 212, 224, 22, 103, 66, 111, 24, 138, 23, 229, 18, 190, 78, 196, 214, 218, 158, 222, 73, 160, 251, 245, 142, 187, 47, 238, 122, 169,
  104, 121, 145, 21, 178, 7, 63, 148, 194, 16, 137, 11, 34, 95, 33, 128, 127, 93, 154, 90, 144, 50, 39, 53, 62, 204, 231, 191, 247, 151, 3, 255, 25, 48,
  179, 72, 165, 181, 209, 215, 94, 146, 42, 172, 86, 170, 198, 79, 184, 56, 210, 150, 164, 125, 182, 118, 252, 107, 226, 156, 116, 4, 241, 69, 157, 112,
  89, 100, 113, 135, 32, 134, 91, 207, 101, 230, 45, 168, 2, 27, 96, 37, 173, 174, 176, 185, 246, 28, 70, 97, 105, 52, 64, 126, 15, 85, 71, 163, 35, 221,
  81, 175, 58, 195, 92, 249, 206, 186, 197, 234, 38, 44, 83, 13, 110, 133, 40, 132, 9, 211, 223, 205, 244, 65, 129, 77, 82, 106, 220, 55, 200, 108, 193,
  171, 250, 36, 225, 123, 8, 12, 189, 177, 74, 120, 136, 149, 139, 227, 99, 232, 109, 233, 203, 213, 254, 59, 0, 29, 57, 242, 239, 183, 14, 102, 88, 208,
  228, 166, 119, 114, 248, 235, 117, 75, 10, 49, 68, 80, 180, 143, 237, 31, 26, 219, 153, 141, 51, 159, 17, 131, 20,
]);

/** MD2 (RFC 1319), which java.security's SUN provider has and OpenSSL 3 does not. Tika's digests of `MD2` are these. */
class Md2 implements Hasher {
  readonly #state = new Uint8Array(48);
  readonly #checksum = new Uint8Array(16);
  readonly #buffer = new Uint8Array(16);
  #filled = 0;

  update(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length) {
      const take = Math.min(16 - this.#filled, chunk.length - at);
      this.#buffer.set(chunk.subarray(at, at + take), this.#filled);
      this.#filled += take;
      at += take;
      if (this.#filled === 16) {
        this.#block(this.#buffer);
        this.#filled = 0;
      }
    }
  }

  digest(): Uint8Array {
    const padding = 16 - this.#filled;
    this.update(new Uint8Array(padding).fill(padding));
    // The checksum is fed as a block while the block's own pass changes it: it is the value before that pass.
    this.update(this.#checksum.slice());
    return this.#state.slice(0, 16);
  }

  #block(block: Uint8Array): void {
    const x = this.#state;
    for (let i = 0; i < 16; i++) {
      x[16 + i] = block[i]!;
      x[32 + i] = x[16 + i]! ^ x[i]!;
    }
    let t = 0;
    for (let round = 0; round < 18; round++) {
      for (let k = 0; k < 48; k++) {
        x[k] = x[k]! ^ MD2_S[t]!;
        t = x[k]!;
      }
      t = (t + round) & 0xff;
    }
    const c = this.#checksum;
    t = c[15]!;
    for (let i = 0; i < 16; i++) {
      c[i] = c[i]! ^ MD2_S[block[i]! ^ t]!;
      t = c[i]!;
    }
  }
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 with padding, as commons-codec's Base32 writes it. */
function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out + "=".repeat((8 - (out.length % 8)) % 8);
}

export function encodeDigest(bytes: Uint8Array, encoding: DigestEncoding): string {
  if (encoding === "BASE32") return base32(bytes);
  return Buffer.from(bytes).toString(encoding === "BASE64" ? "base64" : "hex");
}

/**
 * The digests of `defs` over everything from the stream's position to its end, and the number of bytes that is. One
 * pass feeds every algorithm; the stream is left where it was.
 */
export async function digestStream(
  stream: RipstreamInputStream,
  defs: readonly DigestDef[],
  ctx: ParseContext,
): Promise<{ readonly values: ReadonlyArray<readonly [string, string]>; readonly length: number }> {
  const hashers = new Map<DigestAlgorithm, Hasher>();
  for (const { algorithm } of defs) if (!hashers.has(algorithm)) hashers.set(algorithm, createHasher(algorithm));
  const start = stream.position;
  let length = 0;
  try {
    for (;;) {
      ctx.throwIfAborted();
      const chunk = await stream.read();
      if (chunk === null) break;
      length += chunk.length;
      for (const hasher of hashers.values()) hasher.update(chunk);
    }
  } finally {
    await stream.seek(start);
  }
  return { values: finish(hashers, defs), length };
}

function finish(hashers: ReadonlyMap<DigestAlgorithm, Hasher>, defs: readonly DigestDef[]): ReadonlyArray<readonly [string, string]> {
  const done = new Map<DigestAlgorithm, Uint8Array>();
  for (const [algorithm, hasher] of hashers) done.set(algorithm, hasher.digest());
  return defs.map((def) => [digestKey(def), encodeDigest(done.get(def.algorithm)!, def.encoding)] as const);
}

/**
 * The digests of a document that is in memory, for a caller that has no stream to give: pipes' NO_PARSE, which digests
 * and detects without parsing. The same entries `maybeDigest` would write, in the same order. Nothing is skipped here:
 * whether the container is digested at all (`skipContainerDocumentDigest`) is the caller's to say.
 */
export async function digestBytes(
  bytes: Uint8Array,
  defs: readonly DigestDef[],
  signal?: AbortSignal,
): Promise<ReadonlyArray<readonly [string, string]>> {
  const hashers = new Map<DigestAlgorithm, Hasher>();
  for (const { algorithm } of defs) if (!hashers.has(algorithm)) hashers.set(algorithm, createHasher(algorithm));
  // MD2 is about 5 MiB/s here (MD5 600, SHA-256 2,400): a large document is hashed a slice at a time, so that the event
  // loop is free between slices and an abort is heard.
  for (let at = 0; at < bytes.length; at += SLICE_BYTES) {
    signal?.throwIfAborted();
    const slice = bytes.subarray(at, at + SLICE_BYTES);
    for (const hasher of hashers.values()) hasher.update(slice);
    if (at + SLICE_BYTES < bytes.length) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return finish(hashers, defs);
}

const SLICE_BYTES = 256 * 1024;

/**
 * Tika's DigestHelper.maybeDigest: when the context carries digest settings, digest the document and note the digests,
 * and the length (Content-Length) where nothing has said it. `skipContainerDocumentDigest` leaves the container,
 * which is depth 0, undigested. A document with no digests to make is not read at all.
 */
export async function maybeDigest(stream: RipstreamInputStream, metadata: Metadata, ctx: ParseContext): Promise<void> {
  const settings = ctx.get(CONTEXT_KEYS.DIGESTS);
  if (settings === undefined || settings.digests.length === 0) return;
  if (settings.skipContainerDocumentDigest && (ctx.get(CONTEXT_KEYS.EMBEDDED_DEPTH) ?? 0) === 0) return;
  const { values, length } = await digestStream(stream, settings.digests, ctx);
  const known = metadata.get(CONTENT_LENGTH);
  if (known === null || known.trim() === "") metadata.set(CONTENT_LENGTH, String(length));
  for (const [key, value] of values) metadata.set(key, value);
}
