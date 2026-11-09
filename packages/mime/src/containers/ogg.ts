import { MediaType } from "@spikedpunch/ripstream-core";

type Kind = "audio" | "video" | "metadata" | "other";

interface StreamType {
  readonly mime: MediaType;
  readonly kind: Kind;
}

function streamType(mime: string, kind: Kind): StreamType {
  return { mime: MediaType.parse(mime) as MediaType, kind };
}

const OGG_GENERAL = MediaType.parse("application/ogg") as MediaType;
const OGG_AUDIO = MediaType.parse("audio/ogg") as MediaType;
const OGG_VIDEO = MediaType.parse("video/ogg") as MediaType;

const UNKNOWN = streamType("application/ogg", "other");
const KATE = streamType("application/kate", "metadata");

/**
 * What a stream's first packet starts with, and the shortest such packet that counts. The identification is the
 * `vorbis-java` library's, which is not in the Tika tree: the signatures come from the Ogg mapping specs and the
 * minimum lengths from probing Tika 4.2.0 (a `\x01vorbis` packet of 7 bytes is not Vorbis, of 30 is).
 */
const SIGNATURES: readonly { readonly bytes: string; readonly minLength: number; readonly type: StreamType }[] = [
  { bytes: "\x01vorbis", minLength: 30, type: streamType("audio/vorbis", "audio") },
  { bytes: "OpusHead", minLength: 19, type: streamType("audio/opus", "audio") },
  { bytes: "Speex   ", minLength: 80, type: streamType("audio/speex", "audio") },
  { bytes: "\x7fFLAC", minLength: 51, type: streamType("audio/x-oggflac", "audio") },
  { bytes: "PCM     ", minLength: 28, type: streamType("audio/x-oggpcm", "audio") },
  { bytes: "\x80theora", minLength: 30, type: streamType("video/theora", "video") },
  { bytes: "\x80daala", minLength: 30, type: streamType("video/daala", "video") },
  { bytes: "UVS ", minLength: 28, type: streamType("video/x-ogguvs", "video") },
  { bytes: "\x01YUV", minLength: 28, type: streamType("video/x-oggyuv", "video") },
  { bytes: "BBCD", minLength: 28, type: streamType("video/x-dirac", "video") },
  { bytes: "\x80kate\0\0\0\0", minLength: 30, type: KATE },
  { bytes: "CMML\0\0\0\0", minLength: 30, type: streamType("text/x-cmml", "metadata") },
  { bytes: "fishead\0", minLength: 30, type: streamType("application/ogg", "metadata") },
];

/** Whole pages are scanned inside the sniffing prefix; a multiplexed file starts all its streams together. */
const MAX_PAGES = 1000;
const PAGE_HEADER_BYTES = 27;
const BEGINNING_OF_STREAM = 0x02;

/**
 * Port of Tika 4.2.0's `OggDetector` over the beginning-of-stream pages in the sniffing prefix: identify each stream
 * from its first packet, then name the file after its single stream, its one non-metadata stream, its one video
 * stream, or the audio or video family. Null when the bytes are not Ogg.
 */
export function detectOgg(prefix: Uint8Array): MediaType | null {
  if (prefix.length < 4 || String.fromCharCode(prefix[0]!, prefix[1]!, prefix[2]!, prefix[3]!) !== "OggS") return null;

  const counts = new Map<StreamType, number>();
  let total = 0;
  let position = 0;
  for (let page = 0; page < MAX_PAGES && position + PAGE_HEADER_BYTES <= prefix.length; page++) {
    if (!startsWithOggS(prefix, position)) break;
    const segments = prefix[position + 26]!;
    const payloadStart = position + PAGE_HEADER_BYTES + segments;
    if (payloadStart > prefix.length) break;

    let payloadLength = 0;
    let firstPacketLength = -1;
    for (let index = 0; index < segments; index++) {
      const lacing = prefix[position + PAGE_HEADER_BYTES + index]!;
      payloadLength += lacing;
      if (firstPacketLength === -1 && lacing < 255) firstPacketLength = payloadLength;
    }
    if (payloadStart + payloadLength > prefix.length) break;

    if ((prefix[position + 5]! & BEGINNING_OF_STREAM) !== 0) {
      total++;
      const type = identify(prefix.subarray(payloadStart, payloadStart + (firstPacketLength === -1 ? payloadLength : firstPacketLength)));
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    position = payloadStart + payloadLength;
  }

  return name(counts, total);
}

function startsWithOggS(data: Uint8Array, position: number): boolean {
  return data[position] === 0x4f && data[position + 1] === 0x67 && data[position + 2] === 0x67 && data[position + 3] === 0x53;
}

function identify(packet: Uint8Array): StreamType {
  for (const { bytes, minLength, type } of SIGNATURES) {
    if (packet.length < minLength) continue;
    let matches = true;
    for (let index = 0; index < bytes.length; index++) {
      if (packet[index] !== bytes.charCodeAt(index)) matches = false;
    }
    if (matches) return type;
  }
  return UNKNOWN;
}

function name(counts: ReadonlyMap<StreamType, number>, total: number): MediaType {
  if (total === 1) return [...counts.keys()][0]!.mime;

  let nonMetadata = 0;
  let videoCount = 0;
  let audioCount = 0;
  let kateCount = 0;
  const audioTypes = new Set<StreamType>();
  const videoTypes = new Set<StreamType>();
  for (const [type, count] of counts) {
    if (type.kind !== "metadata") nonMetadata += count;
    if (type.kind === "video") {
      videoCount += count;
      videoTypes.add(type);
    } else if (type.kind === "audio") {
      audioCount += count;
      audioTypes.add(type);
    } else if (type === KATE) {
      kateCount++;
    }
  }

  if (nonMetadata === 0) return OGG_GENERAL;
  if (nonMetadata === 1) {
    for (const type of counts.keys()) if (type.kind !== "metadata") return type.mime;
  }
  if (videoCount === 1) return [...videoTypes][0]!.mime;
  if (videoCount === 0 && audioCount > 1) return audioTypes.size === 1 ? [...audioTypes][0]!.mime : OGG_AUDIO;
  if (videoCount > 1) return videoTypes.size === 1 ? [...videoTypes][0]!.mime : OGG_VIDEO;
  if (kateCount > 0) return KATE.mime;
  return OGG_GENERAL;
}
