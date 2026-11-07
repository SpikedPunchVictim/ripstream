import type { Attributes } from "./attributes.ts";

export type MaybePromise<T> = T | Promise<T>;

export type ByteStream = AsyncIterable<Uint8Array>;

export type InputSource =
  | ByteStream
  | ReadableStream<Uint8Array>
  | Uint8Array
  | ArrayBuffer
  | Blob
  | { readonly path: string }
  | { readonly url: string; readonly headers?: HeadersInit };

/**
 * SAX-shaped contract, matching upstream ContentHandler method signatures.
 * Async returns are allowed so handlers can apply backpressure.
 */
export interface ContentHandler {
  startDocument(): MaybePromise<void>;
  endDocument(): MaybePromise<void>;
  startPrefixMapping?(prefix: string, uri: string): MaybePromise<void>;
  endPrefixMapping?(prefix: string): MaybePromise<void>;
  startElement?(
    uri: string,
    localName: string,
    qName: string,
    attributes: Attributes,
  ): MaybePromise<void>;
  endElement?(uri: string, localName: string, qName: string): MaybePromise<void>;
  characters?(ch: string, start: number, length: number): MaybePromise<void>;
  ignorableWhitespace?(ch: string, start: number, length: number): MaybePromise<void>;
  processingInstruction?(target: string, data: string): MaybePromise<void>;
  skippedEntity?(name: string): MaybePromise<void>;
}

export class ContentHandlerDecorator implements ContentHandler {
  private delegate: ContentHandler;

  constructor(delegate: ContentHandler) {
    this.delegate = delegate;
  }

  setDelegate(delegate: ContentHandler): void {
    this.delegate = delegate;
  }

  getDelegate(): ContentHandler {
    return this.delegate;
  }

  startDocument(): MaybePromise<void> {
    return this.delegate.startDocument();
  }

  endDocument(): MaybePromise<void> {
    return this.delegate.endDocument();
  }

  startPrefixMapping(prefix: string, uri: string): MaybePromise<void> {
    return this.delegate.startPrefixMapping?.(prefix, uri);
  }

  endPrefixMapping(prefix: string): MaybePromise<void> {
    return this.delegate.endPrefixMapping?.(prefix);
  }

  startElement(
    uri: string,
    localName: string,
    qName: string,
    attributes: Attributes,
  ): MaybePromise<void> {
    return this.delegate.startElement?.(uri, localName, qName, attributes);
  }

  endElement(uri: string, localName: string, qName: string): MaybePromise<void> {
    return this.delegate.endElement?.(uri, localName, qName);
  }

  characters(ch: string, start: number, length: number): MaybePromise<void> {
    return this.delegate.characters?.(ch, start, length);
  }

  ignorableWhitespace(ch: string, start: number, length: number): MaybePromise<void> {
    return this.delegate.ignorableWhitespace?.(ch, start, length);
  }

  processingInstruction(target: string, data: string): MaybePromise<void> {
    return this.delegate.processingInstruction?.(target, data);
  }

  skippedEntity(name: string): MaybePromise<void> {
    return this.delegate.skippedEntity?.(name);
  }
}
