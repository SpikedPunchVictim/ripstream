import type { Metadata } from "@spikedpunch/ripstream-core";

/*
 * What Tika's AudioParser records for a Sun/NeXT .au file (audio/basic): it asks the JDK's javax.sound AuFileReader and
 * writes the format it reports. The reader is not in the Tika tree, so its rules here (the encodings it takes, and that
 * it refuses anything else) are from memory of the JDK, not read from source. A file it refuses is not an error to
 * Tika: it gets a warning and an empty document.
 */

/** Tika's UNSUPPORTED_AUDIO_FILE_EXCEPTION, word for word. */
const UNSUPPORTED_WARNING =
  "An UnsupportedAudioFileException was thrown.  This could mean that the underlying " +
  "parser hit an EndOfFileException or that the file is unsupported. ¯\\_(ツ)_/¯";

/** The bytes of the header the reader needs: the magic and five 32 bit big-endian fields. */
export const AU_HEADER_BYTES = 24;

// AU encoding to the name javax.sound gives it, and the sample size in bits.
const ENCODINGS = new Map<number, { readonly name: string; readonly bits: number }>([
  [1, { name: "ULAW", bits: 8 }],
  [2, { name: "PCM_SIGNED", bits: 8 }],
  [3, { name: "PCM_SIGNED", bits: 16 }],
  [4, { name: "PCM_SIGNED", bits: 24 }],
  [5, { name: "PCM_SIGNED", bits: 32 }],
  [27, { name: "ALAW", bits: 8 }],
]);

const SAMPLE_TYPES = new Map<number, string>([
  [8, "8Int"],
  [16, "16Int"],
  [32, "32Int"],
]);

/**
 * What Tika's `(int) audioFormat.getSampleRate()` gives for a rate that the reader read as an int: the AudioFormat holds it
 * as a float, which keeps 24 bits of mantissa, and the cast to int saturates at Integer.MAX_VALUE.
 */
function javaIntOfFloat(rate: number): number {
  return Math.min(Math.fround(rate), 2147483647);
}

/** Writes the audio format of an AU header into the metadata, or the warning Tika writes for a file the JDK refuses. */
export function applyAuHeader(head: Uint8Array, metadata: Metadata): void {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const known =
    head.length >= AU_HEADER_BYTES &&
    view.getUint32(0) === 0x2e736e64 &&
    // The header is at least its own fields long.
    view.getUint32(4) >= AU_HEADER_BYTES;
  const encoding = known ? ENCODINGS.get(view.getUint32(12)) : undefined;
  if (!known || encoding === undefined) {
    metadata.add("tk:exception:warn", UNSUPPORTED_WARNING);
    return;
  }

  metadata.set("Content-Type", "audio/basic");
  // javax.sound reads each field as a signed int; -1 is its "not specified".
  const channels = view.getInt32(20);
  if (channels !== -1) metadata.set("audio:channels", channels);
  const rate = view.getInt32(16);
  if (rate !== -1) metadata.set("xmpDM:audioSampleRate", String(javaIntOfFloat(rate)));
  metadata.set("audio:bits-per-sample", encoding.bits);
  const sampleType = SAMPLE_TYPES.get(encoding.bits);
  if (sampleType !== undefined) metadata.set("xmpDM:audioSampleType", sampleType);
  metadata.set("audio:encoding", encoding.name);
}
