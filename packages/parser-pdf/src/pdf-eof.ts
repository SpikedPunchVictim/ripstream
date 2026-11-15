/**
 * Where each revision of a PDF ends, as Tika 4.2.0 reports it in `pdf:eof-offsets` (checked against a running server).
 * Every `startxref` with a non-zero offset (0 marks the first-page section of a linearized file) is followed by whitespace
 * and, normally, `%%EOF`: the offset is the end of that marker plus one end-of-line character if one follows it
 * immediately. When something else follows the startxref (or the file ends), the offset is where the marker was expected.
 * A file with a revision per `startxref` has `offsets.length - 1` incremental updates.
 */

/** Offsets reported for one file at most; a file with more revisions than this is not a document anyone edited. */
const MAX_OFFSETS = 1000;

const STARTXREF = Buffer.from("startxref", "latin1");
const EOF_MARKER = Buffer.from("%%EOF", "latin1");

const isWhitespace = (byte: number | undefined): boolean =>
  byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
const isDigit = (byte: number | undefined): boolean => byte !== undefined && byte >= 48 && byte <= 57;

export function eofOffsets(data: Uint8Array): number[] {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const offsets: number[] = [];
  for (let at = bytes.indexOf(STARTXREF); at !== -1 && offsets.length < MAX_OFFSETS; at = bytes.indexOf(STARTXREF, at + STARTXREF.length)) {
    let cursor = at + STARTXREF.length;
    while (isWhitespace(bytes[cursor])) cursor++;
    const digits = cursor;
    let nonZero = false;
    while (isDigit(bytes[cursor])) {
      if (bytes[cursor] !== 48) nonZero = true;
      cursor++;
    }
    if (cursor === digits || !nonZero) continue;
    while (isWhitespace(bytes[cursor])) cursor++;
    if (bytes.subarray(cursor, cursor + EOF_MARKER.length).equals(EOF_MARKER)) {
      cursor += EOF_MARKER.length;
      if (bytes[cursor] === 10 || bytes[cursor] === 13) cursor++;
    }
    offsets.push(cursor);
  }
  return offsets;
}
