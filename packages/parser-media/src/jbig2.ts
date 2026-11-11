import {
  LimitExceededError,
  MalformedDocumentError,
  type Metadata,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { INT32_MAX, setImageReaderMetadata } from "./imageio-metadata.ts";

const SIGNATURE = [0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a];
/** How far into the file the first page information segment is looked for. Not in Tika. */
const SCAN_WINDOW = 16 * 1024 * 1024;
/** How many segment headers are walked before the first page information. A real file has it first or after the global segments. Not in Tika. */
const MAX_SEGMENTS = 1024;
const PAGE_INFORMATION = 48;
const END_OF_FILE = 51;
const UNKNOWN_LENGTH = 0xffffffff;
const UNKNOWN_HEIGHT = 0xffffffff;

interface SegmentHeader {
  readonly type: number;
  readonly dataLength: number;
  /** Where the header ends: in the sequential organisation the data starts here. */
  readonly next: number;
}

/**
 * JBIG2 (ITU T.88) as a file: the 8 byte signature, a flags byte, a page count if the flags give one, then the
 * segments. The size is the width and height in the first page information segment (type 48), found by walking the
 * segment headers and skipping each segment's data by its declared length, in either file organisation. Tika's
 * ImageParser gives `image/x-jbig2` to the jbig2-imageio reader of PDFBox; its source is not in Tika's tree, so this
 * follows the T.88 segment layout and was checked against Tika's own test file for the size it expects (328 x 78).
 * It writes the keys ImageParser writes for the first image (see `setImageReaderMetadata`), with `tk:num-images` only
 * when the file header declares the number of pages. The reader's own IIOMetadata attributes are not written.
 *
 * Not done: a page whose height is 0xFFFFFFFF (striped, the height known only from the end-of-stripe segments) is
 * typed and not measured; a segment of unknown length (0xFFFFFFFF) ahead of the page information cannot be skipped and
 * is refused; a file with no page information in the first 16 MiB or the first 1024 segments is refused.
 */
export async function readJbig2(stream: RipstreamInputStream, metadata: Metadata): Promise<void> {
  const file = await stream.peek(SCAN_WINDOW);
  if (file.length < 9 || SIGNATURE.some((byte, index) => file[index] !== byte)) {
    throw new MalformedDocumentError("Not a JBIG2 file: the file header signature is missing");
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const flags = file[8]!;
  const sequential = (flags & 0x01) !== 0;
  let pages: number | null = null;
  let position = 9;
  if ((flags & 0x02) === 0) {
    if (file.length < 13) throw new MalformedDocumentError("Truncated JBIG2 file header");
    pages = view.getUint32(9);
    position = 13;
  }

  const page = sequential ? findSequential(file, view, position) : findRandomAccess(file, view, position);
  if (page.height === UNKNOWN_HEIGHT && page.width <= INT32_MAX) return;
  if (page.width === 0 || page.height === 0 || page.width > INT32_MAX || page.height > INT32_MAX) {
    throw new MalformedDocumentError(`JBIG2 page size ${page.width}x${page.height} is not a size`);
  }
  setImageReaderMetadata(metadata, page.width, page.height, pages);
}

/** A segment header: number, flags, the count of referred-to segments and their numbers, page association, length. */
function readSegmentHeader(file: Uint8Array, view: DataView, position: number): SegmentHeader | null {
  if (position + 6 > file.length) return null;
  const number = view.getUint32(position);
  const flags = file[position + 4]!;
  let next = position + 5;
  const countByte = file[next]!;
  let referred: number;
  if (countByte >> 5 === 7) {
    // The long form: a 4 byte count (low 29 bits), then one retain bit per referred segment and one more, in whole bytes.
    if (next + 4 > file.length) return null;
    referred = view.getUint32(next) & 0x1fffffff;
    next += 4 + Math.ceil((referred + 1) / 8);
  } else if (countByte >> 5 > 4) {
    throw new MalformedDocumentError("JBIG2 segment header has a reserved referred-to segment count");
  } else {
    referred = countByte >> 5;
    next += 1;
  }
  // Each referred-to segment number is 1, 2 or 4 bytes, by the size of this segment's own number.
  next += referred * (number <= 256 ? 1 : number <= 65536 ? 2 : 4);
  next += (flags & 0x40) !== 0 ? 4 : 1;
  if (next + 4 > file.length) return null;
  return { type: flags & 0x3f, dataLength: view.getUint32(next), next: next + 4 };
}

interface PageSize {
  readonly width: number;
  readonly height: number;
}

function pageSizeAt(file: Uint8Array, view: DataView, offset: number, dataLength: number): PageSize {
  if (dataLength < 8 || offset + 8 > file.length) {
    throw new MalformedDocumentError("Truncated JBIG2 page information segment");
  }
  return { width: view.getUint32(offset), height: view.getUint32(offset + 4) };
}

function noPageInformation(): MalformedDocumentError {
  return new MalformedDocumentError("JBIG2 file has no page information segment in the part that is read");
}

/** Each segment's header is followed by its data. */
function findSequential(file: Uint8Array, view: DataView, start: number): PageSize {
  let position = start;
  for (let walked = 0; ; walked++) {
    if (walked >= MAX_SEGMENTS) throw new LimitExceededError(`JBIG2 has no page information in its first ${MAX_SEGMENTS} segments`);
    const header = readSegmentHeader(file, view, position);
    if (header === null || header.type === END_OF_FILE) throw noPageInformation();
    if (header.type === PAGE_INFORMATION) return pageSizeAt(file, view, header.next, header.dataLength);
    if (header.dataLength === UNKNOWN_LENGTH) {
      throw new MalformedDocumentError("JBIG2 segment of unknown length ahead of the page information");
    }
    // May point past the end of the file: the next header then does not fit and the walk ends.
    position = header.next + header.dataLength;
  }
}

/** Every header comes first, up to the end-of-file segment, then every segment's data in the same order. */
function findRandomAccess(file: Uint8Array, view: DataView, start: number): PageSize {
  const headers: SegmentHeader[] = [];
  let position = start;
  for (;;) {
    if (headers.length >= MAX_SEGMENTS) throw new LimitExceededError(`JBIG2 has more than ${MAX_SEGMENTS} segments`);
    const header = readSegmentHeader(file, view, position);
    if (header === null) throw new MalformedDocumentError("Truncated JBIG2 segment headers");
    headers.push(header);
    position = header.next;
    if (header.type === END_OF_FILE) break;
  }
  let dataStart = position;
  for (const header of headers) {
    if (header.type === PAGE_INFORMATION) return pageSizeAt(file, view, dataStart, header.dataLength);
    if (header.dataLength === UNKNOWN_LENGTH) {
      throw new MalformedDocumentError("JBIG2 segment of unknown length ahead of the page information");
    }
    dataStart += header.dataLength;
  }
  throw noPageInformation();
}
