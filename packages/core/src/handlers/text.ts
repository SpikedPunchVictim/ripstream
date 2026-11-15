import {
  ContentHandlerDecorator,
  type ContentHandler,
  type MaybePromise,
} from "../content-handler.ts";
import { WriteLimitReachedError } from "../errors.ts";

export interface WriteOutOptions {
  readonly writeLimit?: number;
  readonly onLimit?: "throw" | "truncate";
}

/**
 * Port of org.apache.tika.sax.WriteOutContentHandler.
 *
 * Default limit is 100,000 characters. The prefix up to the limit is always
 * forwarded, then the handler either throws WriteLimitReachedError (upstream
 * default) or silently drops the remainder.
 */
export class WriteOutContentHandler extends ContentHandlerDecorator {
  readonly writeLimit: number;
  private readonly onLimit: "throw" | "truncate";
  private writeCount = 0;
  private reached = false;

  constructor(delegate: ContentHandler, options: WriteOutOptions = {}) {
    super(delegate);
    this.writeLimit = options.writeLimit ?? 100_000;
    this.onLimit = options.onLimit ?? "throw";
  }

  get isWriteLimitReached(): boolean {
    return this.reached;
  }

  get charactersWritten(): number {
    return this.writeCount;
  }

  // Synchronous unless the delegate returns a promise: an async wrapper costs two promises per event, and a text
  // document is thousands of events.
  characters(ch: string, start: number, length: number): MaybePromise<void> {
    return this.write(length, (count) => this.getDelegate().characters?.(ch, start, count));
  }

  ignorableWhitespace(ch: string, start: number, length: number): MaybePromise<void> {
    return this.write(length, (count) => this.getDelegate().ignorableWhitespace?.(ch, start, count));
  }

  private write(length: number, forward: (count: number) => MaybePromise<void>): MaybePromise<void> {
    if (this.reached) return;
    if (this.writeLimit === -1 || this.writeCount + length <= this.writeLimit) {
      const result = forward(length);
      if (isThenable(result)) {
        return Promise.resolve(result).then(() => {
          this.writeCount += length;
        });
      }
      this.writeCount += length;
      return;
    }
    return this.writeTruncated(forward);
  }

  private async writeTruncated(forward: (count: number) => MaybePromise<void>): Promise<void> {
    const allowed = Math.max(0, this.writeLimit - this.writeCount);
    if (allowed > 0) {
      await forward(allowed);
      this.writeCount += allowed;
    }
    this.reached = true;
    if (this.onLimit === "throw") throw new WriteLimitReachedError(this.writeLimit);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function";
}

export class TextContentHandler implements ContentHandler {

  private buffer = "";
  private readonly sink: ((text: string) => MaybePromise<void>) | null;
  private styleDepth = 0;
  private scriptDepth = 0;

  constructor(sink?: (text: string) => MaybePromise<void>) {
    this.sink = sink ?? null;
  }

  startDocument(): void {}
  endDocument(): void {}

  startElement(uri: string, localName: string, qName: string): void {
    const name = (qName || "").toUpperCase();
    if (name === "STYLE") this.styleDepth++;
    if (name === "SCRIPT") this.scriptDepth++;
  }

  endElement(uri: string, localName: string, qName: string): void {
    const name = (qName || "").toUpperCase();
    if (name === "STYLE") this.styleDepth--;
    if (name === "SCRIPT") this.scriptDepth--;
  }

  // Synchronous unless a sink is set: a promise per event is costly on large documents.
  characters(ch: string, start: number, length: number): MaybePromise<void> {
    if (this.styleDepth + this.scriptDepth !== 0) return;
    const text = ch.slice(start, start + length);
    if (this.sink === null) {
      this.buffer += text;
      return;
    }
    return this.sink(text);
  }

  ignorableWhitespace(
    ch: string,
    start: number,
    length: number,
  ): MaybePromise<void> {
    return this.characters(ch, start, length);
  }

  toString(): string {
    return this.buffer;
  }
}

/** Captures only content inside the XHTML body element. */
export class BodyContentHandler extends TextContentHandler {
  private inBody = false;

  startElement(uri: string, localName: string, qName: string): void {
    if ((qName || "").toLowerCase() === "body") this.inBody = true;
    super.startElement(uri, localName, qName);
  }

  endElement(uri: string, localName: string, qName: string): void {
    if ((qName || "").toLowerCase() === "body") this.inBody = false;
    super.endElement(uri, localName, qName);
  }

  characters(ch: string, start: number, length: number): MaybePromise<void> {
    if (this.inBody) return super.characters(ch, start, length);
  }

  ignorableWhitespace(
    ch: string,
    start: number,
    length: number,
  ): MaybePromise<void> {
    if (this.inBody) return super.ignorableWhitespace(ch, start, length);
  }
}
