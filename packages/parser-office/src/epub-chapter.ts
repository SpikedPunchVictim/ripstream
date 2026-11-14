/*
 * An EPUB chapter is XML, so its bytes are decoded the way an XML parser does (tikajs-reyp): the byte-order mark, then the
 * XML declaration's encoding, else UTF-8.
 */

/** Decodes a chapter by its byte-order mark, else the XML declaration's encoding, else UTF-8. */
export function decodeChapter(bytes: Uint8Array): string {
  try {
    return new TextDecoder(chapterEncoding(bytes), { fatal: false }).decode(bytes);
  } catch {
    // A label the runtime does not know ("x-unknown"): the chapter is read as UTF-8 rather than refused.
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function chapterEncoding(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  // No mark: UTF-16 text starts "<" beside a NUL.
  if (bytes[0] === 0x3c && bytes[1] === 0x00) return "utf-16le";
  if (bytes[0] === 0x00 && bytes[1] === 0x3c) return "utf-16be";
  let head = "";
  for (let index = 0; index < Math.min(bytes.length, 256); index++) head += String.fromCharCode(bytes[index]!);
  const declared = /^\s*<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(head)?.[1];
  // A declaration that names UTF-16 over bytes that read as ASCII is wrong about itself: read them as UTF-8.
  if (declared === undefined || /^(utf-?16|ucs-?2|iso-10646-ucs-2)/i.test(declared)) return "utf-8";
  return declared;
}
