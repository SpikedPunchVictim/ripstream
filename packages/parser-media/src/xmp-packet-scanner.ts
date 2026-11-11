import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";

/*
 * Port of Tika 4.2.0's XMPPacketScanner (tika-parser-xmp-commons), read from that source; not run against a Tika.
 * It finds the first `<?xpacket begin=` in the stream, skips to the `?>` that ends that header and returns what lies
 * from there to the next `<?xpacket`, header and trailer excluded. The `begin` attribute is not inspected, as in Tika.
 *
 * The matcher is Tika's skipAfter, byte for byte: when a partial match fails, the failing byte is not tried as the
 * start of a new match, so `<<?xpacket begin=` is not a header. That is a quirk of the Java, kept for parity.
 */

/** XMPPacketScanner.MAX_PACKET: the most a packet may hold before the scan refuses it. */
export const MAX_XMP_PACKET_BYTES = 64 * 1024 * 1024;

const HEADER = ascii("<?xpacket begin=");
const HEADER_END = ascii("?>");
const TRAILER = ascii("<?xpacket");
const INITIAL_CAPTURE_BYTES = 4096;

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

/** The bytes written between the header and the trailer, up to the cap. */
class Capture {
  private bytes = new Uint8Array(INITIAL_CAPTURE_BYTES);
  private length = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** The `matched` bytes of a partial match that failed, then the byte that failed it. */
  writeFailedMatch(match: Uint8Array, matched: number, byte: number): void {
    for (let index = 0; index < matched; index++) this.append(match[index]!);
    this.append(byte);
    if (this.length > this.max) {
      throw new LimitExceededError(`XMP packet exceeds ${this.max} bytes`);
    }
  }

  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }

  private append(byte: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = byte;
  }
}

/**
 * The first XMP packet in the stream, or null when it has no packet header. A header with no `?>` after it, or a packet
 * with no trailer, is a MalformedDocumentError (Tika's IOException); a packet over `maxPacketBytes`, a
 * LimitExceededError. Only the packet is held: the rest of the stream is read and dropped.
 */
export async function scanXmpPacket(
  source: AsyncIterable<Uint8Array>,
  maxPacketBytes = MAX_XMP_PACKET_BYTES,
): Promise<Uint8Array | null> {
  const phases = [HEADER, HEADER_END, TRAILER];
  const capture = new Capture(maxPacketBytes);
  let phase = 0;
  let matched = 0;
  for await (const chunk of source) {
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index]!;
      const match = phases[phase]!;
      if (byte === match[matched]) {
        matched++;
        if (matched === match.length) {
          if (phase === phases.length - 1) return capture.result();
          phase++;
          matched = 0;
        }
      } else {
        if (phase === phases.length - 1) capture.writeFailedMatch(match, matched, byte);
        matched = 0;
      }
    }
  }
  if (phase === 0) return null;
  throw new MalformedDocumentError(phase === 1 ? "Invalid XMP packet header!" : "XMP packet not properly terminated!");
}
