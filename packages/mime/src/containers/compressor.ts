import { MediaType } from "@spikedpunch/ripstream-core";

/** `DefaultZipContainerDetector` hands commons-compress the first 1024 bytes. */
const PREFIX_BYTES = 1024;

interface Signature {
  readonly type: MediaType;
  /** The leading bytes commons-compress's `matches` requires; a list is the set of values one byte may take. */
  readonly bytes: readonly (number | readonly number[])[];
}

function signature(type: string, bytes: readonly (number | readonly number[])[]): Signature {
  return { type: MediaType.parse(type) as MediaType, bytes };
}

/**
 * In the order `CompressorStreamFactory.detect` tries them, with the types `CompressorConstants` gives them (which is
 * why framed Snappy is `application/x-snappy` here and `application/x-snappy-framed` in the registry).
 */
const SIGNATURES: readonly Signature[] = [
  signature("application/x-bzip2", [0x42, 0x5a, 0x68]),
  signature("application/gzip", [0x1f, 0x8b]),
  signature("application/x-java-pack200", [0xca, 0xfe, 0xd0, 0x0d]),
  signature("application/x-snappy", [0xff, 0x06, 0x00, 0x00, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59]),
  signature("application/x-compress", [0x1f, 0x9d]),
  signature("application/zlib", [0x78, [0x01, 0x5e, 0x9c, 0xda]]),
  signature("application/x-xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
  signature("application/x-lzma", [0x5d, 0x00, 0x00]),
  signature("application/x-lz4", [0x04, 0x22, 0x4d, 0x18]),
  signature("application/zstd", [0x28, 0xb5, 0x2f, 0xfd]),
  // A skippable frame: any first byte 0x50-0x5f.
  signature("application/zstd", [[0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f], 0x2a, 0x4d, 0x18]),
];

/**
 * Port of the compressor half of Tika 4.2.0's `DefaultZipContainerDetector`: commons-compress's signature check over
 * the first 1024 bytes. Null when no compressor signature matches.
 */
export function detectCompressor(prefix: Uint8Array): MediaType | null {
  const head = prefix.subarray(0, PREFIX_BYTES);
  for (const { type, bytes } of SIGNATURES) {
    if (head.length < bytes.length) continue;
    const matches = bytes.every((expected, index) =>
      typeof expected === "number" ? head[index] === expected : expected.includes(head[index]!),
    );
    if (matches) return type;
  }
  return null;
}
