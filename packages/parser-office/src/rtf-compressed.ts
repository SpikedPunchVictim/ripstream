import { LimitExceededError } from "@spikedpunch/ripstream-core";

// PR_RTF_COMPRESSED (MS-OXRTFCP): a 16-byte header (compressed size, raw size, type, CRC), then raw bytes ("MELA") or LZ77 ("LZFu").

const LZFU = 0x75465a4c;
const MELA = 0x414c454d;
const HEADER_BYTES = 16;
const WINDOW = 4096;

const PREFIX =
  "{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tx";

/** The RTF a PR_RTF_COMPRESSED value holds, or undefined when it is not one. A raw size over `maxBytes` is a LimitExceededError. */
export function decompressRtf(bytes: Uint8Array, maxBytes: number): Uint8Array | undefined {
  if (bytes.byteLength < HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawSize = view.getUint32(4, true);
  const type = view.getUint32(8, true);
  if (type !== LZFU && type !== MELA) return undefined;
  if (rawSize > maxBytes) {
    throw new LimitExceededError(`Compressed RTF of ${rawSize} bytes exceeds ${maxBytes}`);
  }
  if (type === MELA) return bytes.slice(HEADER_BYTES, HEADER_BYTES + rawSize);

  const window = new Uint8Array(WINDOW);
  for (let index = 0; index < PREFIX.length; index++) window[index] = PREFIX.charCodeAt(index);
  let write = PREFIX.length;
  // The header's size is a claim; a token gives at most 17 bytes for 2, so the input bounds what it can really produce.
  const capacity = Math.min(rawSize, bytes.byteLength * 9);
  const out = new Uint8Array(capacity);
  let produced = 0;
  let position = HEADER_BYTES;

  const emit = (byte: number): void => {
    out[produced++] = byte;
    window[write] = byte;
    write = (write + 1) % WINDOW;
  };

  while (position < bytes.byteLength && produced < capacity) {
    const control = bytes[position++]!;
    for (let bit = 0; bit < 8 && position < bytes.byteLength && produced < capacity; bit++) {
      if ((control & (1 << bit)) === 0) {
        emit(bytes[position++]!);
        continue;
      }
      if (position + 1 >= bytes.byteLength) return out.subarray(0, produced);
      const high = bytes[position++]!;
      const low = bytes[position++]!;
      let from = (high << 4) | (low >> 4);
      // A reference to the write position ends the stream.
      if (from === write) return out.subarray(0, produced);
      const length = (low & 0x0f) + 2;
      for (let copied = 0; copied < length && produced < capacity; copied++) {
        emit(window[from]!);
        from = (from + 1) % WINDOW;
      }
    }
  }
  return out.subarray(0, produced);
}
