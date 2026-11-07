import type { Attributes } from "../attributes.ts";
import type { ContentHandler } from "../content-handler.ts";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/** Minimal XML serializer over the SAX event model. */
export class ToXMLContentHandler implements ContentHandler {
  private output = "";
  private readonly encoding: string;
  private readonly declaration: boolean;

  constructor(encoding = "UTF-8", declaration = true) {
    this.encoding = encoding;
    this.declaration = declaration;
  }

  startDocument(): void {
    if (this.declaration) {
      this.output += `<?xml version="1.0" encoding="${escapeAttribute(this.encoding)}"?>`;
    }
  }

  endDocument(): void {}

  startPrefixMapping(): void {}
  endPrefixMapping(): void {}

  startElement(
    uri: string,
    localName: string,
    qName: string,
    attributes: Attributes,
  ): void {
    const name = qName || localName;
    this.output += `<${name}`;
    for (const attribute of attributes.names) {
      this.output += ` ${attribute.qName}="${escapeAttribute(attribute.value)}"`;
    }
    this.output += ">";
  }

  endElement(uri: string, localName: string, qName: string): void {
    this.output += `</${qName || localName}>`;
  }

  characters(ch: string, start: number, length: number): void {
    this.output += escapeText(ch.slice(start, start + length));
  }

  ignorableWhitespace(ch: string, start: number, length: number): void {
    this.characters(ch, start, length);
  }

  processingInstruction(target: string, data: string): void {
    this.output += `<?${target} ${data}?>`;
  }

  skippedEntity(name: string): void {
    this.output += `&${name};`;
  }

  toString(): string {
    return this.output;
  }
}

/** HTML serializer: no XML declaration, void elements written without end tags. */
export class ToHTMLContentHandler extends ToXMLContentHandler {
  private readonly open: string[] = [];

  constructor() {
    super("UTF-8", false);
  }

  override startElement(
    uri: string,
    localName: string,
    qName: string,
    attributes: Attributes,
  ): void {
    super.startElement(uri, localName, qName, attributes);
    this.open.push(qName || localName);
  }

  override endElement(uri: string, localName: string, qName: string): void {
    const name = (qName || localName).toLowerCase();
    this.open.pop();
    if (VOID_ELEMENTS.has(name)) return;
    super.endElement(uri, localName, qName);
  }
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}
