import type { Attributes, AttributesImpl } from "../attributes.ts";
import type { ContentHandler, MaybePromise } from "../content-handler.ts";

/** Fans SAX events out to several handlers in order. */
export class TeeContentHandler implements ContentHandler {
  readonly #handlers: readonly ContentHandler[];

  constructor(handlers: readonly ContentHandler[]) {
    this.#handlers = handlers;
  }

  async startDocument(): Promise<void> {
    for (const handler of this.#handlers) await handler.startDocument?.();
  }

  async endDocument(): Promise<void> {
    for (const handler of this.#handlers) await handler.endDocument?.();
  }

  async startElement(uri: string, localName: string, qName: string, attributes: Attributes): Promise<void> {
    for (const handler of this.#handlers) {
      await handler.startElement?.(uri, localName, qName, attributes);
    }
  }

  async endElement(uri: string, localName: string, qName: string): Promise<void> {
    for (const handler of this.#handlers) await handler.endElement?.(uri, localName, qName);
  }

  async characters(ch: string, start: number, length: number): Promise<void> {
    for (const handler of this.#handlers) await handler.characters?.(ch, start, length);
  }

  async ignorableWhitespace(ch: string, start: number, length: number): Promise<void> {
    for (const handler of this.#handlers) await handler.ignorableWhitespace?.(ch, start, length);
  }
}

export type { AttributesImpl };
export type TeeMaybePromise = MaybePromise<void>;
