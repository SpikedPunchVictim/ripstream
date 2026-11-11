/*
 * Builds small Ogg files for the tests: pages, codec headers and comment blocks. The CRC field is left zero, as the
 * parsers do not check it. The layouts are the Ogg framing (RFC 3533) and the codec mappings, not read from a file.
 */

export const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

export interface PageSpec {
  readonly sid: number;
  readonly packets: readonly Uint8Array[];
  /** Granule position; -1 (the default) says that no packet ends on the page. */
  readonly granule?: bigint;
  readonly bos?: boolean;
  readonly eos?: boolean;
  /** The first packet continues one that began on the previous page. */
  readonly continued?: boolean;
  /** The last packet goes on in the next page: its lacing has no closing value below 255. */
  readonly open?: boolean;
}

export function laceOf(length: number, open: boolean): number[] {
  const values = new Array<number>(Math.floor(length / 255)).fill(255);
  if (!open) values.push(length % 255);
  return values;
}

export function oggPage(spec: PageSpec): Uint8Array {
  const lacing: number[] = [];
  spec.packets.forEach((packet, index) => {
    const open = spec.open === true && index === spec.packets.length - 1;
    // Without a closing value the lacing can only describe a whole number of 255 byte segments.
    if (open && packet.length % 255 !== 0) throw new Error("an open packet must be a multiple of 255 bytes");
    lacing.push(...laceOf(packet.length, open));
  });
  if (lacing.length > 255) throw new Error("too many segments for one page");
  const header = new Uint8Array(27 + lacing.length);
  header.set(enc("OggS"), 0);
  header[5] = (spec.continued ? 1 : 0) | (spec.bos ? 2 : 0) | (spec.eos ? 4 : 0);
  new DataView(header.buffer).setBigInt64(6, spec.granule ?? -1n, true);
  header.set(u32le(spec.sid), 14);
  header[26] = lacing.length;
  header.set(lacing, 27);
  return concat(header, ...spec.packets);
}

/** A Vorbis comment block: vendor and comments, each with a 32 bit little endian length. */
export function commentBlock(vendor: string, comments: readonly (string | Uint8Array)[], prefix = new Uint8Array(0)): Uint8Array {
  const vendorBytes = enc(vendor);
  const parts: Uint8Array[] = [prefix, u32le(vendorBytes.length), vendorBytes, u32le(comments.length)];
  for (const comment of comments) {
    const bytes = typeof comment === "string" ? enc(comment) : comment;
    parts.push(u32le(bytes.length), bytes);
  }
  return concat(...parts);
}

export interface VorbisIdent {
  readonly channels?: number;
  readonly rate?: number;
  readonly upper?: number;
  readonly nominal?: number;
  readonly lower?: number;
}

export function vorbisIdent(spec: VorbisIdent = {}): Uint8Array {
  const out = new Uint8Array(30);
  out.set([1, ...enc("vorbis")], 0);
  out[11] = spec.channels ?? 2;
  out.set(u32le(spec.rate ?? 44100), 12);
  out.set(u32le(spec.upper ?? 0), 16);
  out.set(u32le(spec.nominal ?? 0), 20);
  out.set(u32le(spec.lower ?? 0), 24);
  out[29] = 1;
  return out;
}

export const VORBIS_COMMENT_PREFIX = Uint8Array.of(3, ...enc("vorbis"));
export const OPUS_TAGS_PREFIX = enc("OpusTags");
export const THEORA_COMMENT_PREFIX = Uint8Array.of(0x81, ...enc("theora"));

export function opusHead(spec: { channels?: number; preSkip?: number; rate?: number; version?: number } = {}): Uint8Array {
  const out = new Uint8Array(19);
  out.set(enc("OpusHead"), 0);
  out[8] = spec.version ?? 1;
  out[9] = spec.channels ?? 2;
  new DataView(out.buffer).setUint16(10, spec.preSkip ?? 312, true);
  out.set(u32le(spec.rate ?? 44100), 12);
  return out;
}

export function speexHeader(spec: { versionString?: string; versionId?: number; rate?: number; channels?: number } = {}): Uint8Array {
  const out = new Uint8Array(80);
  out.set(enc("Speex   "), 0);
  out.set(enc(spec.versionString ?? "1.2rc1"), 8);
  out.set(u32le(spec.versionId ?? 1), 28);
  out.set(u32le(80), 32);
  out.set(u32le(spec.rate ?? 16000), 36);
  out.set(u32le(spec.channels ?? 1), 48);
  return out;
}

export function theoraIdent(spec: { major?: number; minor?: number; revision?: number } = {}): Uint8Array {
  const out = new Uint8Array(42);
  out.set([0x80, ...enc("theora")], 0);
  out[7] = spec.major ?? 3;
  out[8] = spec.minor ?? 2;
  out[9] = spec.revision ?? 1;
  return out;
}

/** The first packet of an Ogg FLAC stream: the mapping header, then a STREAMINFO block (RFC 9639 section 8.2). */
export function oggFlacFirst(spec: { rate?: number; channels?: number; bitsPerSample?: number; samples?: number; major?: number; minor?: number } = {}): Uint8Array {
  const out = new Uint8Array(51);
  out.set([0x7f, ...enc("FLAC")], 0);
  out[5] = spec.major ?? 1;
  out[6] = spec.minor ?? 0;
  out.set([0, 1], 7); // one more header packet
  out.set(enc("fLaC"), 9);
  out[13] = 0; // STREAMINFO, not the last block
  out.set([0, 0, 34], 14);
  const rate = spec.rate ?? 44100;
  const channels = (spec.channels ?? 2) - 1;
  const bits = (spec.bitsPerSample ?? 16) - 1;
  const samples = spec.samples ?? 0;
  out[27] = rate >>> 12;
  out[28] = (rate >>> 4) & 0xff;
  out[29] = ((rate & 0xf) << 4) | (channels << 1) | (bits >>> 4);
  out[30] = ((bits & 0xf) << 4) | (Math.floor(samples / 2 ** 32) & 0xf);
  out.set(u32be(samples % 2 ** 32), 31);
  return out;
}

/** A FLAC VORBIS_COMMENT metadata block as one Ogg packet: a 4 byte block header, then the comments. */
export function flacTagsPacket(vendor: string, comments: readonly (string | Uint8Array)[], last = true): Uint8Array {
  const body = commentBlock(vendor, comments);
  return concat(Uint8Array.of((last ? 0x80 : 0) | 4, body.length >>> 16, (body.length >>> 8) & 0xff, body.length & 0xff), body);
}

/** An Ogg Vorbis file: identification and comment pages, one audio page ending at `lastGranule`. */
export function vorbisFile(spec: {
  sid?: number;
  ident?: VorbisIdent;
  vendor?: string;
  comments?: readonly (string | Uint8Array)[];
  lastGranule?: bigint;
} = {}): Uint8Array {
  const sid = spec.sid ?? 1;
  const comments = commentBlock(spec.vendor ?? "Test Vendor", spec.comments ?? [], VORBIS_COMMENT_PREFIX);
  return concat(
    oggPage({ sid, bos: true, packets: [vorbisIdent(spec.ident)], granule: 0n }),
    oggPage({ sid, packets: [concat(comments, Uint8Array.of(1)), Uint8Array.of(5, ...enc("vorbis"), 0, 0)], granule: 0n }),
    oggPage({ sid, eos: true, packets: [new Uint8Array(40)], granule: spec.lastGranule ?? 44100n }),
  );
}

export function opusFile(spec: { sid?: number; head?: Parameters<typeof opusHead>[0]; comments?: readonly (string | Uint8Array)[]; lastGranule?: bigint } = {}): Uint8Array {
  const sid = spec.sid ?? 2;
  return concat(
    oggPage({ sid, bos: true, packets: [opusHead(spec.head)], granule: 0n }),
    oggPage({ sid, packets: [commentBlock("libopus", spec.comments ?? [], OPUS_TAGS_PREFIX)], granule: 0n }),
    oggPage({ sid, eos: true, packets: [new Uint8Array(40)], granule: spec.lastGranule ?? 48312n }),
  );
}

export async function* chunked(bytes: Uint8Array, size: number, limit = 10_000_000): AsyncGenerator<Uint8Array> {
  let yielded = 0;
  for (let offset = 0; offset < bytes.length; offset += size) {
    if (++yielded > limit) throw new Error("test stream read too many chunks: a loop has stopped ending");
    yield bytes.subarray(offset, offset + size);
  }
}
