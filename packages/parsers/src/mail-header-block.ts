import { displayString, parseAddressList } from "./mail-address.ts";
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
 * The header block of a message as xberg writes it into the content (xberg 1.4.0, `extractors/email.rs`):
 * `Name: value` lines in the order Subject, From, To, CC, BCC, Reply-To, Date, Message-ID, In-Reply-To, References,
 * List-Id, List-Unsubscribe, with no trailing line inside the block. A header with nothing in it has no line.
 *
 * From is one sender as `Name <address>` (or the address); To, CC and BCC are the bare addresses; the message-id headers
 * lose their angle brackets and References is the ids joined with ", ". Everything else is the header unfolded, with
 * RFC 2047 words decoded.
 */
export function mailHeaderBlock(headers: readonly HeaderField[], decodeWords: (text: string) => string): string {
  const lines: string[] = [];
  const all = (name: string): string[] => headers.filter((header) => header.name === name).map((header) => header.value);
  const last = (name: string): string | undefined => all(name).at(-1);
  const add = (label: string, value: string | undefined): void => {
    if (value === undefined) return;
    const text = oneLine(value);
    if (text.length > 0) lines.push(`${label}: ${text}`);
  };
  const decoded = (value: string): string => oneLine(decodeWords(value));

  const addresses = (name: string, sender: boolean): string | undefined => {
    const values = all(name);
    if (values.length === 0) return undefined;
    const parts: string[] = [];
    for (const raw of values) {
      const mailboxes = parseAddressList(raw);
      if (mailboxes === null) {
        parts.push(oneLine(raw));
        continue;
      }
      if (sender) {
        const mailbox = mailboxes[0];
        if (mailbox !== undefined) parts.push(displayString(mailbox, decodeWords));
        break;
      }
      for (const mailbox of mailboxes) parts.push(mailbox.address);
    }
    const text = parts.filter((part) => part.length > 0).join(", ");
    return text.length > 0 ? text : undefined;
  };

  const messageId = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    return [...value.matchAll(/<([^>]*)>/g)].map((match) => match[1]!).filter((id) => id.length > 0).join(", ") || value;
  };

  add("Subject", last("subject") === undefined ? undefined : decoded(last("subject")!));
  add("From", addresses("from", true));
  add("To", addresses("to", false));
  add("CC", addresses("cc", false));
  add("BCC", addresses("bcc", false));
  add("Reply-To", addresses("reply-to", false));
  add("Date", last("date") === undefined ? undefined : decoded(last("date")!));
  add("Message-ID", messageId(last("message-id")));
  add("In-Reply-To", messageId(last("in-reply-to")));
  {
    const references = all("references").flatMap((value) => messageId(value)?.split(", ") ?? []);
    add("References", references.length > 0 ? references.join(", ") : undefined);
  }
  add("List-Id", last("list-id"));
  add("List-Unsubscribe", last("list-unsubscribe"));
  return lines.join("\n");
}
