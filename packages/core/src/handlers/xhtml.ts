import { AttributesImpl, type Attributes } from "../attributes.ts";
import type {
  ContentHandler,
  MaybePromise,
} from "../content-handler.ts";
import { Metadata } from "../metadata.ts";

const XHTML = "http://www.w3.org/1999/xhtml";

const ENDLINE = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "div", "ul", "ol", "dl", "pre",
  "hr", "blockquote", "address", "fieldset", "table", "form", "noscript",
  "li", "dt", "dd", "noframes", "br", "tr", "select", "option", "link",
  "script",
]);
const HEAD = new Set(["title", "link", "base", "meta", "script"]);
const AUTO = new Set(["head", "frameset"]);
const INDENT = new Set(["li", "dd", "dt", "td", "th", "frame"]);
const TRIMMED_INLINE = new Set(["b", "strong", "i", "em", "sup", "sub"]);

interface PendingStart {
  readonly uri: string;
  readonly localName: string;
  readonly qName: string;
  readonly attributes: Attributes;
}

function isInvalid(codePoint: number): boolean {
  return (
    (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint >= 0xfffe && codePoint <= 0xffff) ||
    codePoint > 0x10ffff
  );
}

/** Port of SafeContentHandler's text filtering. */
function filterText(text: string): string {
  let invalid = -1;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index)!;
    if (isInvalid(codePoint)) {
      invalid = index;
      break;
    }
    index += codePoint > 0xffff ? 2 : 1;
  }
  if (invalid === -1) return text;

  let result = text.slice(0, invalid);
  for (let index = invalid; index < text.length; ) {
    const codePoint = text.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    result += isInvalid(codePoint) ? "�" : text.slice(index, index + width);
    index += width;
  }
  return result;
}

function filterAttributes(attributes: Attributes): Attributes {
  let changed = false;
  const filtered = attributes.names.map((attribute) => {
    const value = filterText(attribute.value);
    if (value !== attribute.value) changed = true;
    return { ...attribute, value };
  });
  return changed ? new AttributesImpl(filtered) : attributes;
}

const EMPTY_ATTRIBUTES = new AttributesImpl();

/**
 * Port of org.apache.tika.sax.XHTMLContentHandler, including the
 * SafeContentHandler filtering and the upstream ENDLINE/INDENT/AUTO/HEAD/
 * TRIMMED_INLINE behavior. Upstream performs no nesting validation; neither
 * does this port.
 */
export class XHTMLContentHandler implements ContentHandler {
  private readonly delegate: ContentHandler;
  private readonly metadata: Metadata;
  private readonly writeMetadataToHead: boolean;
  private readonly includeTitle: boolean;

  private documentStarted = false;
  private headStarted = false;
  private headEnded = false;
  private useFrameset = false;

  private readonly pendingStarts: PendingStart[] = [];
  private heldWhitespace = "";
  private openTrimmed = 0;

  constructor(
    delegate: ContentHandler,
    metadata: Metadata = new Metadata(),
    options: { writeMetadataToHead?: boolean; includeTitle?: boolean } = {},
  ) {
    this.delegate = delegate;
    this.metadata = metadata;
    this.writeMetadataToHead = options.writeMetadataToHead ?? true;
    this.includeTitle = options.includeTitle ?? true;
  }

  startDocument(): MaybePromise<void> {
    if (this.documentStarted) return;
    this.documentStarted = true;
    return this.chain(
      () => this.delegate.startDocument(),
      () => this.delegate.startPrefixMapping?.("", XHTML),
    );
  }

  private lazyStartHead(): MaybePromise<void> {
    if (this.headStarted) return;
    this.headStarted = true;

    const language = this.metadata.get("Content-Language");
    const attributes = new AttributesImpl();
    if (language !== null) {
      attributes.addAttribute("", "lang", "lang", "CDATA", filterText(language));
    }

    return this.chain(
      () => this.delegate.startElement?.(XHTML, "html", "html", attributes),
      () => this.newline(),
      () => this.delegate.startElement?.(XHTML, "head", "head", EMPTY_ATTRIBUTES),
      () => this.newline(),
    );
  }

  private lazyEndHead(frameset: boolean): MaybePromise<void> {
    if (this.headEnded) return;
    this.headEnded = true;
    this.useFrameset = frameset;

    return this.run(async () => {
      await this.lazyStartHead();

      if (this.writeMetadataToHead) {
        for (const name of this.metadata.names()) {
          if (name === "title") continue;
          for (const value of this.metadata.getAll(name)) {
            if (value === null) continue;
            const attributes = new AttributesImpl();
            attributes.addAttribute("", "name", "name", "CDATA", filterText(name));
            attributes.addAttribute("", "content", "content", "CDATA", filterText(value));
            await this.delegate.startElement?.(XHTML, "meta", "meta", attributes);
            await this.delegate.endElement?.(XHTML, "meta", "meta");
            await this.newline();
          }
        }
      }

      if (this.includeTitle) {
        await this.delegate.startElement?.(
          XHTML, "title", "title", EMPTY_ATTRIBUTES,
        );
        const title = this.metadata.get("dc:title") ?? this.metadata.get("title");
        if (title !== null && title.length > 0) {
          const filtered = filterText(title);
          await this.delegate.characters?.(filtered, 0, filtered.length);
        } else {
          await this.delegate.characters?.("", 0, 0);
        }
        await this.delegate.endElement?.(XHTML, "title", "title");
        await this.newline();
      }

      await this.delegate.endElement?.(XHTML, "head", "head");
      await this.newline();
      const body = frameset ? "frameset" : "body";
      await this.delegate.startElement?.(XHTML, body, body, EMPTY_ATTRIBUTES);
    });
  }

  startElement(name: string): MaybePromise<void>;
  startElement(name: string, attribute: string, value: string): MaybePromise<void>;
  startElement(
    uri: string,
    localName: string,
    qName: string,
    attributes: Attributes,
  ): MaybePromise<void>;
  startElement(
    uriOrName: string,
    localNameOrAttribute?: string,
    qNameOrValue?: string,
    attributes?: Attributes,
  ): MaybePromise<void> {
    if (attributes === undefined) {
      const name = uriOrName;
      const attributesImpl = new AttributesImpl();
      if (localNameOrAttribute !== undefined && qNameOrValue !== undefined) {
        attributesImpl.addAttribute(
          "",
          localNameOrAttribute,
          localNameOrAttribute,
          "CDATA",
          qNameOrValue,
        );
      }
      return this.startElement(XHTML, name, name, attributesImpl);
    }

    const uri = uriOrName;
    const localName = localNameOrAttribute ?? "";
    const qName = qNameOrValue ?? localName;

    if (qName === "frameset") {
      return this.lazyEndHead(true);
    }
    if (AUTO.has(qName)) return;

    const head = HEAD.has(qName) ? this.lazyStartHead() : this.lazyEndHead(false);
    return after(head, () => this.openElement(uri, localName, qName, attributes));
  }

  private openElement(
    uri: string,
    localName: string,
    qName: string,
    attributes: Attributes,
  ): MaybePromise<void> {
    if (TRIMMED_INLINE.has(qName)) {
      this.pendingStarts.push({
        uri,
        localName,
        qName,
        attributes: new AttributesImpl(attributes),
      });
      return;
    }

    return after(this.flushHeld(), () => {
      const indent =
        uri === XHTML && INDENT.has(qName)
          ? this.delegate.ignorableWhitespace?.("\t", 0, 1)
          : undefined;
      return after(indent, () =>
        this.delegate.startElement?.(uri, localName, qName, filterAttributes(attributes)),
      );
    });
  }

  endElement(name: string): MaybePromise<void>;
  endElement(uri: string, localName: string, qName: string): MaybePromise<void>;
  endElement(
    uriOrName: string,
    localName?: string,
    qName?: string,
  ): MaybePromise<void> {
    const uri = qName === undefined ? XHTML : uriOrName;
    const local = qName === undefined ? uriOrName : localName!;
    const name = qName === undefined ? uriOrName : qName;

    if (AUTO.has(name)) return;

    const trimmed = TRIMMED_INLINE.has(name);
    if (trimmed) {
      const last = this.pendingStarts.at(-1);
      if (last !== undefined && last.qName === name) {
        this.pendingStarts.pop();
        return;
      }
      if (this.pendingStarts.length === 0) {
        return after(this.delegate.endElement?.(uri, local, name), () => {
          this.openTrimmed = Math.max(0, this.openTrimmed - 1);
        });
      }
    }

    return after(this.flushHeld(), () =>
      after(this.delegate.endElement?.(uri, local, name), () => {
        if (trimmed) this.openTrimmed = Math.max(0, this.openTrimmed - 1);
        if (uri === XHTML && ENDLINE.has(name)) return this.newline();
      }),
    );
  }

  characters(ch: string, start?: number, length?: number): MaybePromise<void> {
    if (start === undefined || length === undefined) {
      if (ch.length === 0) return;
      start = 0;
      length = ch.length;
    }

    const begin = start;
    const count = length;
    return after(this.lazyEndHead(this.useFrameset), () =>
      this.writeCharacters(ch.slice(begin, begin + count)),
    );
  }

  private writeCharacters(raw: string): MaybePromise<void> {
    if (
      this.pendingStarts.length === 0 &&
      this.openTrimmed === 0 &&
      this.heldWhitespace.length === 0
    ) {
      const filtered = filterText(raw);
      return this.delegate.characters?.(filtered, 0, filtered.length);
    }

    const firstNonWhitespace = findFirstNonWhitespace(raw);
    if (firstNonWhitespace === -1) {
      if (this.pendingStarts.length === 0 && this.openTrimmed === 0) {
        return after(this.flushHeld(), () => {
          const filtered = filterText(raw);
          return this.delegate.characters?.(filtered, 0, filtered.length);
        });
      }
      this.heldWhitespace += raw;
      return;
    }

    this.heldWhitespace += raw.slice(0, firstNonWhitespace);
    return after(this.flushHeld(), () => {
      let middleEnd = raw.length;
      if (this.openTrimmed > 0) {
        middleEnd = findLastNonWhitespace(raw) + 1;
      }

      const middle = raw.slice(firstNonWhitespace, middleEnd);
      const filtered = middle.length > 0 ? filterText(middle) : "";
      const written =
        middle.length > 0 ? this.delegate.characters?.(filtered, 0, filtered.length) : undefined;
      return after(written, () => {
        this.heldWhitespace += raw.slice(middleEnd);
      });
    });
  }

  ignorableWhitespace(ch: string, start: number, length: number): MaybePromise<void> {
    return after(this.flushHeld(), () => this.delegate.ignorableWhitespace?.(ch, start, length));
  }

  processingInstruction(target: string, data: string): MaybePromise<void> {
    return after(this.flushHeld(), () => this.delegate.processingInstruction?.(target, data));
  }

  skippedEntity(name: string): MaybePromise<void> {
    return after(this.flushHeld(), () => this.delegate.skippedEntity?.(name));
  }

  endDocument(): MaybePromise<void> {
    return this.run(async () => {
      await this.flushHeld();
      await this.lazyEndHead(this.useFrameset);
      const body = this.useFrameset ? "frameset" : "body";
      await this.delegate.endElement?.(XHTML, body, body);
      await this.delegate.endElement?.(XHTML, "html", "html");
      await this.delegate.endPrefixMapping?.("");
      await this.delegate.endDocument();
    });
  }

  newline(): MaybePromise<void> {
    return this.delegate.ignorableWhitespace?.("\n", 0, 1);
  }

  element(name: string, value: string | null | undefined): MaybePromise<void> {
    if (value == null || value.length === 0) return;
    return after(this.startElement(name), () =>
      after(this.characters(value), () => this.endElement(name)),
    );
  }

  /** Writes held whitespace and pending inline starts; synchronous when the delegate is. */
  private flushHeld(): MaybePromise<void> {
    if (this.heldWhitespace.length > 0) {
      const held = this.heldWhitespace;
      this.heldWhitespace = "";
      const filtered = filterText(held);
      return after(this.delegate.characters?.(filtered, 0, filtered.length), () =>
        this.flushPendingStarts(),
      );
    }
    return this.flushPendingStarts();
  }

  private flushPendingStarts(): MaybePromise<void> {
    while (this.pendingStarts.length > 0) {
      const pending = this.pendingStarts.shift()!;
      const started = this.delegate.startElement?.(
        pending.uri,
        pending.localName,
        pending.qName,
        filterAttributes(pending.attributes),
      );
      if (isThenable(started)) {
        return Promise.resolve(started).then(() => {
          this.openTrimmed++;
          return this.flushPendingStarts();
        });
      }
      this.openTrimmed++;
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    await action();
  }

  private async chain(
    ...actions: Array<() => MaybePromise<void> | undefined>
  ): Promise<void> {
    for (const action of actions) await action();
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Runs next once result has settled. A delegate that returns synchronously (the usual case) costs no promise; every
 * promise is expensive under the node:test harness, which tracks each one with async hooks.
 */
function after(result: MaybePromise<void> | undefined, next: () => MaybePromise<void>): MaybePromise<void> {
  if (isThenable(result)) return Promise.resolve(result).then(next);
  return next();
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char) || char === " ";
}

function findFirstNonWhitespace(value: string): number {
  for (let index = 0; index < value.length; index++) {
    if (!isWhitespace(value[index]!)) return index;
  }
  return -1;
}

function findLastNonWhitespace(value: string): number {
  for (let index = value.length - 1; index >= 0; index--) {
    if (!isWhitespace(value[index]!)) return index;
  }
  return -1;
}
