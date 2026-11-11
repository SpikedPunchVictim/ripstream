import { javaTrim } from "./java-compat.ts";

/** One mailbox of an address list: the display name (null when there is none) and the address. */
export interface Mailbox {
  readonly name: string | null;
  readonly address: string;
}

/**
 * The mailboxes of an address list header (To, Cc, Bcc, From), or null where the field is not one: an unterminated quote,
 * comment or angle address, or a group (`name: a, b;`), which Tika's MailContentHandler then reads by its fallback.
 *
 * This is written from memory of mime4j's lenient address parser (it is not in the Tika tree). It splits at commas that are
 * outside quotes, comments and angle brackets; takes a display name from before `<`, with its quotes removed and its comments
 * dropped; takes what is in the brackets as the address, or the whole piece when there are none; and skips an empty piece.
 * Where mime4j reads a malformed field some other way, the result differs.
 */
export function parseAddressList(value: string): Mailbox[] | null {
  const segments = splitTopLevel(value);
  if (segments === null) return null;
  const mailboxes: Mailbox[] = [];
  for (const segment of segments) {
    const mailbox = parseMailbox(segment);
    if (mailbox === null) return null;
    if (mailbox !== "empty") mailboxes.push(mailbox);
  }
  return mailboxes;
}

/** MailContentHandler.getDisplayString: the name decoded, then the address in angle brackets; the address alone without a name. */
export function displayString(mailbox: Mailbox, decodeWords: (text: string) => string): string {
  if (mailbox.name !== null && mailbox.name.length > 0) return `${decodeWords(mailbox.name)} <${mailbox.address}>`;
  return mailbox.address;
}

/** The pieces of the list between its commas that are outside quotes, comments and angle brackets; null for a group or an unfinished one. */
function splitTopLevel(value: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quoted = false;
  let commentDepth = 0;
  let angle = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (quoted) {
      current += char;
      if (char === "\\" && index + 1 < value.length) current += value[++index]!;
      else if (char === '"') quoted = false;
      continue;
    }
    if (commentDepth > 0) {
      current += char;
      if (char === "\\" && index + 1 < value.length) current += value[++index]!;
      else if (char === "(") commentDepth++;
      else if (char === ")") commentDepth--;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "(") commentDepth++;
    else if (char === "<" && !angle) angle = true;
    else if (char === ">" && angle) angle = false;
    else if (char === ":" && !angle) return null;
    if (char === "," && !angle) {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (quoted || commentDepth > 0 || angle) return null;
  segments.push(current);
  return segments;
}

function parseMailbox(segment: string): Mailbox | "empty" | null {
  const text = removeComments(segment);
  const open = indexOutsideQuotes(text, "<");
  if (open === -1) {
    const address = javaTrim(unquote(text));
    return address.length === 0 ? "empty" : { name: null, address };
  }
  const close = text.indexOf(">", open);
  if (close === -1) return null;
  const name = javaTrim(unquote(text.slice(0, open)));
  const address = javaTrim(text.slice(open + 1, close));
  if (address.length === 0 && name.length === 0) return "empty";
  return { name: name.length === 0 ? null : name, address };
}

/** Drops the (comments) outside quotes. */
function removeComments(text: string): string {
  let out = "";
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (depth > 0) {
      if (char === "\\") index++;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    } else if (quoted) {
      out += char;
      if (char === "\\" && index + 1 < text.length) out += text[++index]!;
      else if (char === '"') quoted = false;
    } else if (char === "(") {
      depth++;
    } else {
      if (char === '"') quoted = true;
      out += char;
    }
  }
  return out;
}

function indexOutsideQuotes(text: string, target: string): number {
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === target) {
      return index;
    }
  }
  return -1;
}

/** A phrase with its quote marks removed and its quoted-pairs resolved. */
function unquote(text: string): string {
  let out = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted && char === "\\" && index + 1 < text.length) out += text[++index]!;
    else if (char === '"') quoted = !quoted;
    else out += char;
  }
  return out;
}

// MailUtil.EMAIL: an address is a run with an @ in it, without a `<`, an `@` or a space.
const EMAIL = /([^<@ \t\n\v\f\r]+@[^@> ]+)/g;

/**
 * MailUtil.setPersonAndEmail: the person is what is left of the display string after its addresses are taken out (with `<`,
 * `>` and `"` turned to spaces and the ends trimmed), the address is the last one found. Neither is empty when it is returned;
 * "" stands for none. It does not decode encoded words: decode first.
 */
export function splitPersonAndEmail(display: string): { readonly person: string; readonly email: string } {
  let email = "";
  const rest = display.replace(EMAIL, (_match, found: string) => {
    email = found;
    return "";
  });
  return { person: javaTrim(rest.replace(/[<>"]/g, " ")), email };
}
