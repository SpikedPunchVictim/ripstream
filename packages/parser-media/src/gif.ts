/** What a walk over the blocks of a GIF finds. */
export interface GifImages {
  /** Image descriptors whose nine bytes are all present. */
  readonly count: number;
  /** Size of the first image, from its image descriptor. Zero when `count` is zero. */
  readonly firstWidth: number;
  readonly firstHeight: number;
  /**
   * The walk met a block that begins with a zero byte. javax.imageio's GIF reader fails on that while counting
   * images ("Unexpected block type 0!"), which Tika's ImageParser knowingly ignores (TIKA-619), so it writes
   * nothing from the reader for such a file.
   */
  readonly blockTypeZero: boolean;
}

const EXTENSION_INTRODUCER = 0x21;
const IMAGE_SEPARATOR = 0x2c;
const TRAILER = 0x3b;

/** Bytes of a colour table whose size field (the low three bits of a packed byte) is `sizeField`. */
function colorTableBytes(packed: number): number {
  return (packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1);
}

/**
 * Walks the blocks of a GIF the way javax.imageio's reader does to answer `getNumImages(true)`, to count the
 * images and size the first. Tika's ImageParser takes both from that reader (ImageParser.extractMetadata,
 * read from Tika source). The size of image 0 is the image descriptor's, not the logical screen's.
 *
 * The walk ends at the trailer, at the end of the data, or at a block it does not know. ImageIO throws at the last
 * two, and Tika turns that into a failed parse; this reads what is there instead, as the rest of this parser does.
 * Every step consumes at least one byte, so the walk is linear in the data.
 */
export function readGifImages(data: Uint8Array): GifImages {
  let count = 0;
  let firstWidth = 0;
  let firstHeight = 0;
  let blockTypeZero = false;
  // Header (6), logical screen descriptor (7), then the global colour table.
  if (data.length < 13) return { count, firstWidth, firstHeight, blockTypeZero };
  let offset = 13 + colorTableBytes(data[10]!);

  /** Steps over a run of data sub-blocks and its terminating zero-length block. */
  const skipSubBlocks = (): void => {
    while (offset < data.length) {
      const size = data[offset++]!;
      if (size === 0) return;
      offset += size;
    }
  };

  walk: while (offset < data.length) {
    const block = data[offset++]!;
    switch (block) {
      case TRAILER:
        break walk;
      case EXTENSION_INTRODUCER:
        offset++; // the extension label
        skipSubBlocks();
        break;
      case IMAGE_SEPARATOR: {
        // left, top, width, height (u16 each, little endian), then a packed byte.
        if (offset + 9 > data.length) break walk;
        if (count === 0) {
          firstWidth = data[offset + 4]! | (data[offset + 5]! << 8);
          firstHeight = data[offset + 6]! | (data[offset + 7]! << 8);
        }
        count++;
        const packed = data[offset + 8]!;
        offset += 9 + colorTableBytes(packed);
        offset++; // the LZW minimum code size
        skipSubBlocks();
        break;
      }
      case 0:
        blockTypeZero = true;
        break walk;
      default:
        break walk;
    }
  }
  return { count, firstWidth, firstHeight, blockTypeZero };
}
