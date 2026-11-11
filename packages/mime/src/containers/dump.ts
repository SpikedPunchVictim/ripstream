import { MediaType } from "@spikedpunch/ripstream-core";

const UNIX_DUMP = MediaType.parse("application/x-tika-unix-dump") as MediaType;

/** `DefaultZipContainerDetector` hands commons-compress the first 1024 bytes. */
const PREFIX_BYTES = 1024;
/** commons-compress's dump check wants at least this many bytes to see the magic. */
const MIN_BYTES = 32;
const MAGIC_OFFSET = 24;
/** commons-compress `DumpArchiveConstants.NFS_MAGIC`. */
const NFS_MAGIC = 60012;

/**
 * The dump half of the archive check in Tika 4.2.0's `DefaultZipContainerDetector` (`ArchiveStreamFactory.detect`, which
 * `PackageConstants.getMediaType` maps to `application/x-tika-unix-dump`): a little-endian NFS_MAGIC at offset 24 of
 * the first 1024 bytes, which must be at least 32. The rule is commons-compress's, not in the Tika tree. Null when it
 * does not match.
 */
export function detectUnixDump(prefix: Uint8Array): MediaType | null {
  const head = prefix.subarray(0, PREFIX_BYTES);
  if (head.length < MIN_BYTES) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return view.getUint32(MAGIC_OFFSET, true) === NFS_MAGIC ? UNIX_DUMP : null;
}
