import {
  BodyContentHandler,
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
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Decode as true latin1 (1 byte <-> 1 char, lossless) so 8-bit bytes that
    // are not valid UTF-8 survive the split and each part's own charset can
    // still be applied by the mail parser.
    const text = bytesToLatin1(data);
    const messages = splitMessages(text);
    if (messages.length === 0) {
      throw new MalformedDocumentError("Not an mbox bundle");
    }

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    let count = 0;
    for (const message of messages) {
      const captured = new BodyContentHandler();
      const messageMetadata = new Metadata();
      const messageStream = await RipstreamInputStream.from(
        latin1ToBytes(message),
        { context: ctx },
      );
      try {
        await new MailParser().parse(
          messageStream,
          captured,
          messageMetadata,
          ctx,
        );
        count++;
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
    metadata.set("Message:Count", String(count));
    const firstSubject = messages.length > 0 ? undefined : undefined;
    void firstSubject;
    await xhtml.endDocument();
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

function splitMessages(text: string): string[] {
  const messages: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^From .+/.test(line)) {
      if (current.length > 0) messages.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) messages.push(current.join("\n"));
  return messages.filter((message) => message.trim().length > 0);
}
