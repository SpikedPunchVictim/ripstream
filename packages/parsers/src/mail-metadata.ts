import { tikaDateMetadataString, type Metadata } from "@spikedpunch/ripstream-core";
import { javaSplit, javaTrim } from "./java-compat.ts";
import { parseStructured } from "./mail-structured.ts";
import { displayString, parseAddressList, splitPersonAndEmail, type Mailbox } from "./mail-address.ts";

/** One header of a message. `name` is lower case for lookup; `rawName` is as the message spells it; `raw` keeps its folding. */
export interface HeaderField {
  readonly name: string;
  readonly rawName: string;
  /** What follows the colon, its leading blanks removed and its folded lines left as they were (mime4j's `Field.getBody`). */
  readonly raw: string;
  /** `raw` unfolded (a line break before a blank is dropped, the blank is kept) and trimmed. */
  readonly value: string;
}

/** `Message.MESSAGE_RAW_HEADER_PREFIX`: Tika 4's name; the 3.x name `Message:Raw-Header:` is the migration filter's. */
const RAW_HEADER_PREFIX = "message:raw-header:";

/**
 * MailContentHandler.field for the headers of the message itself (the first block; the parts' are skipped): who it is from and
 * to, its subject and date, and every other header as `message:raw-header:<name>`. `decodeWords` is RFC 2047 decoding.
 *
 * Differences from Tika, read from its source (mime4j is not in the tree, so its address and date parsing is from memory):
 *  - An address list is read by {@link parseAddressList}, not mime4j's lenient parser. A list it rejects takes Tika's fallback,
 *    the text after `From:`, `To:`, `Cc:` or `Bcc:` split at its commas; an empty piece is not added (Tika adds it).
 *  - The raw value of a folded header keeps its line breaks, as `Field.getBody` is believed to.
 */
export function applyMailMetadata(metadata: Metadata, headers: readonly HeaderField[], decodeWords: (text: string) => string): void {
  for (const header of headers) writeHeader(metadata, header, decodeWords);
}

function writeHeader(metadata: Metadata, header: HeaderField, decodeWords: (text: string) => string): void {
  switch (header.name) {
    case "from":
      writeFrom(metadata, header, decodeWords);
      return;
    case "subject":
      writeSubject(metadata, decodeWords(header.value));
      return;
    case "to":
      writeRecipients(metadata, header, "message:to", decodeWords);
      return;
    case "cc":
      writeRecipients(metadata, header, "message:cc", decodeWords);
      return;
    case "bcc":
      writeRecipients(metadata, header, "message:bcc", decodeWords);
      return;
    case "content-type":
      writeContentType(metadata, header);
      return;
    case "date":
      writeDate(metadata, header);
      return;
    default:
      metadata.add(`${RAW_HEADER_PREFIX}${header.rawName}`, header.raw);
  }
}

function writeSubject(metadata: Metadata, subject: string): void {
  metadata.set("dc:title", subject);
  metadata.set("dc:subject", subject);
  metadata.set("tk:resource-name", `${subject}.eml`);
}

function writeFrom(metadata: Metadata, header: HeaderField, decodeWords: (text: string) => string): void {
  const mailboxes = parseAddressList(header.value);
  if (mailboxes === null) {
    writeFromFallback(metadata, header);
    return;
  }
  for (const mailbox of mailboxes) {
    const from = displayString(mailbox, decodeWords);
    setPersonAndEmail(metadata, from, "message:from-name", "message:from-email");
    metadata.add("message:from", from);
    metadata.add("dc:creator", from);
  }
}

/** The branch of MailContentHandler.field for a From that mime4j could not read: the text as written, without its outer brackets. */
function writeFromFallback(metadata: Metadata, header: HeaderField): void {
  let from = header.raw;
  setPersonAndEmail(metadata, from, "message:from-name", "message:from-email");
  if (from.startsWith("<")) from = from.slice(1);
  if (from.endsWith(">")) from = from.slice(0, -1);
  metadata.add("message:from", from);
  metadata.add("dc:creator", from);
}

function setPersonAndEmail(metadata: Metadata, display: string, personKey: string, emailKey: string): void {
  const { person, email } = splitPersonAndEmail(display);
  if (person.length > 0) metadata.set(personKey, person);
  if (email.length > 0) metadata.set(emailKey, email);
}

function writeRecipients(metadata: Metadata, header: HeaderField, key: string, decodeWords: (text: string) => string): void {
  const mailboxes: readonly Mailbox[] | null = parseAddressList(header.value);
  if (mailboxes !== null) {
    for (const mailbox of mailboxes) metadata.add(key, displayString(mailbox, decodeWords));
    return;
  }
  for (const piece of javaSplit(header.raw, ",")) {
    const recipient = javaTrim(piece);
    if (recipient.length > 0) metadata.add(key, recipient);
  }
}

function writeContentType(metadata: Metadata, header: HeaderField): void {
  const { type, parameters } = parseStructured(header.value);
  const slash = type.indexOf("/");
  if (slash <= 0) return;
  if (type.slice(0, slash) !== "multipart") {
    metadata.add(`${RAW_HEADER_PREFIX}${header.rawName}`, header.raw);
    return;
  }
  metadata.set("multipart:subtype", type.slice(slash + 1));
  const boundary = parameters.get("boundary");
  if (boundary !== undefined) metadata.set("multipart:boundary", boundary);
}

function writeDate(metadata: Metadata, header: HeaderField): void {
  const created = tikaDateMetadataString(header.value);
  if (created !== null) metadata.set("dcterms:created", created);
}
