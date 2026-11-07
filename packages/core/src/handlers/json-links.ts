import type { ContentHandler, MaybePromise } from "../content-handler.ts";
import { Metadata } from "../metadata.ts";
import { TextContentHandler } from "./text.ts";

/** Collects text and emits a single JSON document at `toString()`. */
export class JsonContentHandler extends TextContentHandler {
  private readonly metadata: Metadata;

  constructor(metadata: Metadata, sink?: (text: string) => MaybePromise<void>) {
    super(sink);
    this.metadata = metadata;
  }

  toObject(): Record<string, unknown> {
    return {
      ...this.metadata.toObject(),
      "X-TIKA:content": super.toString(),
    };
  }

  override toString(): string {
    return JSON.stringify(this.toObject());
  }
}

/** Collects href/src values from anchor and image elements. */
export class LinkExtractor implements ContentHandler {
  private readonly delegate: ContentHandler | null;
  private readonly collected: string[] = [];

  constructor(delegate?: ContentHandler) {
    this.delegate = delegate ?? null;
  }

  get links(): readonly string[] {
    return this.collected;
  }

  startDocument(): MaybePromise<void> {
    return this.delegate?.startDocument();
  }

  endDocument(): MaybePromise<void> {
    return this.delegate?.endDocument();
  }

  startElement(
    uri: string,
    localName: string,
    qName: string,
    attributes: import("../attributes.ts").Attributes,
  ): MaybePromise<void> {
    const name = (qName || localName).toLowerCase();
    if (name === "a" || name === "img" || name === "link") {
      const target =
        attributes.getValueByQName("href") ?? attributes.getValueByQName("src");
      if (target !== null && target.length > 0) this.collected.push(target);
    }
    return this.delegate?.startElement?.(uri, localName, qName, attributes);
  }

  endElement(uri: string, localName: string, qName: string): MaybePromise<void> {
    return this.delegate?.endElement?.(uri, localName, qName);
  }

  characters(ch: string, start: number, length: number): MaybePromise<void> {
    return this.delegate?.characters?.(ch, start, length);
  }

  ignorableWhitespace(ch: string, start: number, length: number): MaybePromise<void> {
    return this.delegate?.ignorableWhitespace?.(ch, start, length);
  }
}
