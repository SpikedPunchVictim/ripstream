import {
  BodyContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  RipstreamInputStream,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { MailParser } from "./mail.ts";

/** mbox/Maildir message-bundle parser built on the RFC822 parser. */
export class MboxParser implements Parser {
  readonly name = "MboxParser";
  readonly capabilities = { requiresRandomAccess: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["application/mbox", "application/x-mbox"].map(
        (type) => MediaType.parse(type)!,
      ),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    // The mailbox is read a chunk at a time and each message is parsed and written as soon as the next "From " line
    // (or the end of the input) closes it, so memory is bounded by one message and the output cap fires after the
    // messages that reach it (tikajs-kpkn: a 50 MB mailbox used to be buffered, as bytes and as lines, first). A message
    // is the unit MailParser takes whole, so its size is bounded by the embedded-resource limit.
    const maxMessageBytes = ctx.limits.maxEmbeddedResourceBytes;
    const xhtml = new XHTMLContentHandler(handler, metadata);
    let started = false;
    let count = 0;

    const writeMessage = async (message: string): Promise<void> => {
      // An input with no message at all is refused before any output, so the document starts with the first one.
      if (!started) {
        started = true;
        await xhtml.startDocument();
      }
      await this.#writeMessage(message, xhtml, ctx);
      count++;
    };

    // The lines of the message being read. A line that starts with "From " ends it and is itself dropped.
    let lines: string[] = [];
    let messageBytes = 0;
    /** Returns the finished message when `line` closes a non-blank one. `bytes` is the line with its line end. */
    const takeLine = (line: string, bytes: number): string | undefined => {
      if (/^From .+/.test(line)) {
        const message = lines.join("\n");
        lines = [];
        messageBytes = 0;
        return message.trim().length > 0 ? message : undefined;
      }
      messageBytes += bytes;
      if (messageBytes > maxMessageBytes) {
        throw new LimitExceededError(`mbox message exceeds ${maxMessageBytes} bytes`);
      }
      lines.push(line);
      return undefined;
    };

    // The text after the last line end is held until more input arrives, because a line (or a CRLF) can span chunks.
    // Decoded as true latin1 (1 byte <-> 1 char, lossless) so 8-bit bytes that are not valid UTF-8 survive the split and
    // each part's own charset can still be applied by the mail parser.
    let partial = "";
    for await (const chunk of stream) {
      const text = bytesToLatin1(chunk);
      const lastBreak = text.lastIndexOf("\n");
      if (lastBreak === -1) {
        partial += text;
        // The line may be a "From " line, which is dropped and not part of the message, so only its own size is bounded
        // here; takeLine counts it against the message once it is complete.
        if (partial.length > maxMessageBytes) {
          throw new LimitExceededError(`mbox message exceeds ${maxMessageBytes} bytes`);
        }
        continue;
      }
      // Up to and including the last "\n", so a "\r" before it is split off with it; the empty piece after it is dropped.
      const complete = (partial + text.slice(0, lastBreak + 1)).split("\n");
      complete.pop();
      partial = text.slice(lastBreak + 1);
      for (const raw of complete) {
        const message = takeLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw, raw.length + 1);
        if (message !== undefined) await writeMessage(message);
      }
    }
    // What follows the last line end is the last line. An input that ends in a line end has no further line.
    if (partial.length > 0) {
      const message = takeLine(partial, partial.length);
      if (message !== undefined) await writeMessage(message);
    }
    const last = lines.join("\n");
    if (last.trim().length > 0) await writeMessage(last);

    if (!started) throw new MalformedDocumentError("Not an mbox bundle");
    metadata.set("Message:Count", String(count));
    await xhtml.endDocument();
  }

  /** Parses one message with the mail parser and writes it. */
  async #writeMessage(message: string, xhtml: XHTMLContentHandler, ctx: ParseContext): Promise<void> {
    const captured = new BodyContentHandler();
    const messageMetadata = new Metadata();
    const messageStream = await RipstreamInputStream.from(latin1ToBytes(message), { context: ctx });
    try {
      await new MailParser().parse(messageStream, captured, messageMetadata, ctx);
      const subject = messageMetadata.get("dc:title");
      if (subject !== null) {
        await xhtml.startElement("div", "class", "message");
        await xhtml.element("h1", subject);
      } else {
        await xhtml.startElement("div", "class", "message");
      }
      const body = captured.toString().trim();
      for (const line of body.split(/\r?\n/)) {
        if (line.trim().length > 0) await xhtml.element("p", line);
      }
      await xhtml.endElement("div");
    } finally {
      await messageStream.close();
    }
  }
}

function bytesToLatin1(data: Uint8Array): string {
  const parts: string[] = [];
  const step = 8192;
  for (let index = 0; index < data.length; index += step) {
    parts.push(String.fromCharCode(...data.subarray(index, index + step)));
  }
  return parts.join("");
}

function latin1ToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    bytes[index] = text.charCodeAt(index);
  }
  return bytes;
}
