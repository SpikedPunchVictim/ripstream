import type { HeaderField } from "./mail-metadata.ts";

/** A line break of any kind, or a vertical tab / form feed: a value must stay on its own line of the block. */
const LINE_BREAKS = /[\r\n\v\f\x85\p{Zl}\p{Zp}]+/gu;

/**
 * A value on one line, its runs of blanks (a folded header leaves two) made one. An RFC 2047 word can decode to a line
 * break, and a forged `From:` line is not a header.
 */
function oneLine(value: string): string {
  return value.replace(LINE_BREAKS, " ").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * The header block of a message as text, for `ParseOptions.emailHeaders`: `Name: value` lines in the order Subject, From,
 * To, CC, BCC, Date, then a blank line; empty when the message has none of them.
 *
 * Each value is the header as the message wrote it, unfolded, with RFC 2047 words decoded (`decodeWords`): the address
 * lists keep their quoting, so a name with a comma stays one address, and the Date is the sender's string, not the
 * normalised `dcterms:created`, which is also absent when no date can be read. A header that occurs more than once gives
 * the last for Subject and Date (the one the metadata keeps) and all of them, joined with ", ", for the address lists.
 * A header with nothing in it has no line.
 */
export function mailHeaderBlock(headers: readonly HeaderField[], decodeWords: (text: string) => string): string {
  const lines: string[] = [];
  const add = (label: string, values: readonly string[]): void => {
    const text = values.map((value) => oneLine(decodeWords(value))).filter((value) => value.length > 0).join(", ");
    if (text.length > 0) lines.push(`${label}: ${text}`);
  };
  const all = (name: string): string[] => headers.filter((header) => header.name === name).map((header) => header.value);
  const last = (name: string): string[] => all(name).slice(-1);

  add("Subject", last("subject"));
  add("From", all("from"));
  add("To", all("to"));
  add("CC", all("cc"));
  add("BCC", all("bcc"));
  add("Date", last("date"));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n\n`;
}
