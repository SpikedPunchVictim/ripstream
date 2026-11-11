import type { Metadata, RipstreamInputStream } from "@spikedpunch/ripstream-core";

/** Reads the header of one image format from the stream and writes what it finds to `metadata`. */
export type HeaderReader = (stream: RipstreamInputStream, metadata: Metadata) => Promise<void>;

/** Java's `Integer.MAX_VALUE`: the largest width or height an `ImageReader` can return. */
export const INT32_MAX = 2_147_483_647;

/**
 * What Tika's ImageParser.extractMetadata writes for a format a javax.imageio reader opened, as far as ImageParser's
 * own code goes: the image count (`tk:num-images`, from `getNumImages`), the size of the first image under
 * `tiff:ImageWidth` / `tiff:ImageLength`, and the same size again under `img:height` / `img:width`. It then copies
 * every attribute of the reader's own IIOMetadata tree under `img:` keys, which is the part of a reader that is not
 * reproduced here.
 */
export function setImageReaderMetadata(
  metadata: Metadata,
  width: number,
  height: number,
  imageCount: number | null,
): void {
  if (imageCount !== null) metadata.set("tk:num-images", imageCount);
  metadata.set("tiff:ImageWidth", width);
  metadata.set("tiff:ImageLength", height);
  metadata.add("img:height", height);
  metadata.add("img:width", width);
}
