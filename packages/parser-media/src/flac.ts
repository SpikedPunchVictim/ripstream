import { LimitExceededError, MalformedDocumentError, type RipstreamInputStream } from "@spikedpunch/ripstream-core";
import {
  parseComments,
  parsePictureBlock,
  readFlacStreamInfo,
  type FlacStreamInfo,
  type PictureBlock,
  type VorbisComments,
} from "./ogg-comments.ts";

/*
 * The metadata blocks of a native FLAC file, as Tika 4.2.0's FlacParser reads them: vorbis-java's FlacFile for the stream
 * info and the comments, and FlacParser.readNativePictures (a walk over the blocks that stops at the last-block flag, at
 * the end of the file, or at a block that declares more than is left) for the PICTURE blocks. Here it is one walk. What
 * FlacFile does with a file that is not well formed is not in the Tika tree: the errors below are from memory of it.
 */

/**
 * What the walk over the metadata blocks may cover: the sizes of the blocks it reads or skips, with their headers. The
 * audio frames after them are never read. A block holds at most 16 MiB (a 24 bit length), and a real file has a few
 * blocks and a cover or two, so a file that goes beyond this is padding or a lie.
 */
export const DEFAULT_MAX_FLAC_METADATA_BYTES = 64 * 1024 * 1024;

const STREAMINFO = 0;
const VORBIS_COMMENT = 4;
const PICTURE = 6;
const STREAMINFO_BYTES = 34;
const BLOCK_HEADER_BYTES = 4;

export interface NativeFlac {
  readonly streamInfo: FlacStreamInfo;
  /** Null when the file has no comment block. */
  readonly comments: VorbisComments | null;
  /** The PICTURE blocks in file order. */
  readonly pictures: PictureBlock[];
}

/** The next `count` bytes, or null when the stream ends first. */
async function take(stream: RipstreamInputStream, count: number): Promise<Uint8Array | null> {
  const bytes = await stream.peek(count);
  if (bytes.length < count) return null;
  await stream.seek(count, "current");
  return bytes;
}

/** Steps over `count` bytes; false when the stream ends first. */
async function skip(stream: RipstreamInputStream, count: number): Promise<boolean> {
  try {
    await stream.seek(count, "current");
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** Reads the blocks at the start of a native FLAC file; the stream is at its first byte. */
export async function readNativeFlac(stream: RipstreamInputStream, maxMetadataBytes: number): Promise<NativeFlac> {
  const magic = await take(stream, 4);
  if (magic === null || String.fromCharCode(...magic) !== "fLaC") throw new MalformedDocumentError("Not a FLAC file: it does not start with fLaC");

  // The stream info is the first block, and what the layout and the duration come from.
  const first = await take(stream, BLOCK_HEADER_BYTES);
  if (first === null) throw new MalformedDocumentError("The FLAC file ends before its stream info");
  if ((first[0]! & 0x7f) !== STREAMINFO || blockLength(first) < STREAMINFO_BYTES) {
    throw new MalformedDocumentError("The first metadata block of the FLAC file is not a stream info of 34 bytes");
  }
  let consumed = BLOCK_HEADER_BYTES + blockLength(first);
  if (consumed > maxMetadataBytes) throw tooMuch(maxMetadataBytes);
  const info = await take(stream, blockLength(first));
  if (info === null) throw new MalformedDocumentError("The FLAC file ends inside its stream info");
  const streamInfo = readFlacStreamInfo(info, 0);

  let comments: VorbisComments | null = null;
  const pictures: PictureBlock[] = [];
  let last = (first[0]! & 0x80) !== 0;
  while (!last) {
    // A file that ends here, or inside a block that is not read, keeps what was read: FlacParser.readNativePictures breaks.
    const header = await take(stream, BLOCK_HEADER_BYTES);
    if (header === null) break;
    last = (header[0]! & 0x80) !== 0;
    const type = header[0]! & 0x7f;
    const length = blockLength(header);
    consumed += BLOCK_HEADER_BYTES + length;
    if (consumed > maxMetadataBytes) throw tooMuch(maxMetadataBytes);

    if (type !== VORBIS_COMMENT && type !== PICTURE) {
      if (!(await skip(stream, length))) break;
      continue;
    }
    const body = await take(stream, length);
    if (body === null) {
      if (type === VORBIS_COMMENT) throw new MalformedDocumentError("The FLAC file ends inside its comment block");
      break;
    }
    if (type === VORBIS_COMMENT) {
      // vorbis-java keeps one tags block; the first is the one kept here.
      comments ??= parseComments(body, 0);
    } else {
      const picture = parsePictureBlock(body);
      if (picture !== null) pictures.push(picture);
    }
  }
  return { streamInfo, comments, pictures };
}

/** The 24 bit big-endian length of the block whose 4 byte header this is. */
function blockLength(header: Uint8Array): number {
  return (header[1]! << 16) | (header[2]! << 8) | header[3]!;
}

function tooMuch(limit: number): LimitExceededError {
  return new LimitExceededError(`The metadata blocks of the FLAC file are more than ${limit} bytes`);
}
