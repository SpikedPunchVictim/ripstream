import { MalformedDocumentError } from "@spikedpunch/ripstream-core";

export interface ArcRecord {
  readonly url: string;
  readonly contentType: string;
  readonly body: Uint8Array;
}

/** An ARC record header is one line of space-separated fields; real ones are a few hundred bytes. */
const MAX_HEADER_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const FILEDESC_PREFIX = "filedesc://";

/** True when the bytes open with the ARC version-block record, which is how every ARC file starts. */
export function isArc(data: Uint8Array): boolean {
  return FILEDESC_PREFIX.split("").every((character, index) => data[index] === character.charCodeAt(0));
}

/**
 * Reads the records of an ARC file (the Internet Archive format, versions 1 and 2): a header line
 * `URL IP-address Archive-date Content-type [...] Archive-length`, `Archive-length` bytes of body, a newline.
 * The length is always the last field, so version 2's extra fields need no special case.
 *
 * Tika hands ARC to jwarc, whose source is not in the Tika tree; this follows the published ARC format. A body that
 * runs past the end of the data is clamped to the bytes present (the same leniency the WARC reader has), so a
 * declared length never allocates anything.
 */
export function* readArcRecords(data: Uint8Array): Generator<ArcRecord> {
  let offset = 0;
  while (offset < data.length) {
    // Records are separated by a newline; skip it and any stray blank lines.
    while (data[offset] === NEWLINE || data[offset] === CARRIAGE_RETURN) offset++;
    if (offset >= data.length) return;

    const window = data.subarray(offset, offset + MAX_HEADER_BYTES);
    const lineEnd = window.indexOf(NEWLINE);
    if (lineEnd === -1) throw new MalformedDocumentError("ARC record header has no end of line");
    const fields = new TextDecoder("latin1").decode(window.subarray(0, lineEnd)).trim().split(" ");
    const declared = fields.at(-1) ?? "";
    if (fields.length < 5 || !/^\d+$/.test(declared)) {
      throw new MalformedDocumentError(`Invalid ARC record header: ${fields.join(" ").slice(0, 80)}`);
    }
    const length = Number(declared);
    if (!Number.isSafeInteger(length)) throw new MalformedDocumentError(`Invalid ARC record length: ${declared}`);

    const bodyStart = offset + lineEnd + 1;
    yield { url: fields[0]!, contentType: fields[3]!, body: data.subarray(bodyStart, bodyStart + length) };
    offset = bodyStart + length;
  }
}

/**
 * The body of an HTTP response stored in an ARC record. ARC files written by old crawlers end header lines with a bare
 * newline (Tika's testARC.arc does), so the blank line that closes the headers is either `\n\n` or `\r\n\r\n`.
 */
export function arcHttpBody(payload: Uint8Array): Uint8Array {
  for (let index = 0; index + 1 < payload.length; index++) {
    if (payload[index] !== NEWLINE) continue;
    if (payload[index + 1] === NEWLINE) return payload.subarray(index + 2);
    if (payload[index + 1] === CARRIAGE_RETURN && payload[index + 2] === NEWLINE) return payload.subarray(index + 3);
  }
  return new Uint8Array(0);
}
