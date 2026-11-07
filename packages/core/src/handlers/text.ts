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

  async characters(ch: string, start: number, length: number): Promise<void> {
    await this.write(
      length,
      (count) => this.getDelegate().characters?.(ch, start, count),
    );
  }

  async ignorableWhitespace(
    ch: string,
    start: number,
    length: number,
  ): Promise<void> {
    await this.write(
      length,
      (count) => this.getDelegate().ignorableWhitespace?.(ch, start, count),
    );
  }

  private async write(
    length: number,
    forward: (count: number) => MaybePromise<void>,
  ): Promise<void> {
    if (this.reached) return;
    if (this.writeLimit === -1 || this.writeCount + length <= this.writeLimit) {
      await forward(length);
      this.writeCount += length;
      return;
    }

    const allowed = Math.max(0, this.writeLimit - this.writeCount);
    if (allowed > 0) {
      await forward(allowed);
      this.writeCount += allowed;
    }
    this.reached = true;
    if (this.onLimit === "throw") throw new WriteLimitReachedError(this.writeLimit);
  }
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

  async characters(ch: string, start: number, length: number): Promise<void> {
    if (this.styleDepth + this.scriptDepth !== 0) return;
    const text = ch.slice(start, start + length);
    if (this.sink === null) {
      this.buffer += text;
    } else {
      await this.sink(text);
    }
  }

  async ignorableWhitespace(
    ch: string,
    start: number,
    length: number,
  ): Promise<void> {
    await this.characters(ch, start, length);
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

  async characters(ch: string, start: number, length: number): Promise<void> {
    if (this.inBody) await super.characters(ch, start, length);
  }

  async ignorableWhitespace(
    ch: string,
    start: number,
    length: number,
  ): Promise<void> {
    if (this.inBody) await super.ignorableWhitespace(ch, start, length);
  }
}
