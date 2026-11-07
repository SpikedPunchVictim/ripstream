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

    return this.run(async () => {
      if (HEAD.has(qName)) {
        await this.lazyStartHead();
      } else {
        await this.lazyEndHead(false);
      }

      if (TRIMMED_INLINE.has(qName)) {
        this.pendingStarts.push({
          uri,
          localName,
          qName,
          attributes: new AttributesImpl(attributes),
        });
        return;
      }

      await this.flushHeld();
      if (uri === XHTML && INDENT.has(qName)) {
        await this.delegate.ignorableWhitespace?.("\t", 0, 1);
      }
      await this.delegate.startElement?.(
        uri,
        localName,
        qName,
        filterAttributes(attributes),
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

    return this.run(async () => {
      if (TRIMMED_INLINE.has(name)) {
        const last = this.pendingStarts.at(-1);
        if (last !== undefined && last.qName === name) {
          this.pendingStarts.pop();
          return;
        }
        if (this.pendingStarts.length === 0) {
          await this.delegate.endElement?.(uri, local, name);
          this.openTrimmed = Math.max(0, this.openTrimmed - 1);
          return;
        }
      }

      await this.flushHeld();
      await this.delegate.endElement?.(uri, local, name);

      if (TRIMMED_INLINE.has(name)) {
        this.openTrimmed = Math.max(0, this.openTrimmed - 1);
      }
      if (uri === XHTML && ENDLINE.has(name)) {
        await this.newline();
      }
    });
  }

  characters(ch: string, start?: number, length?: number): MaybePromise<void> {
    if (start === undefined || length === undefined) {
      if (ch.length === 0) return;
      start = 0;
      length = ch.length;
    }

    return this.run(async () => {
      await this.lazyEndHead(this.useFrameset);

      const raw = ch.slice(start, start + length);
      if (
        this.pendingStarts.length === 0 &&
        this.openTrimmed === 0 &&
        this.heldWhitespace.length === 0
      ) {
        const filtered = filterText(raw);
        await this.delegate.characters?.(filtered, 0, filtered.length);
        return;
      }

      const firstNonWhitespace = findFirstNonWhitespace(raw);
      if (firstNonWhitespace === -1) {
        if (this.pendingStarts.length === 0 && this.openTrimmed === 0) {
          await this.flushHeld();
          const filtered = filterText(raw);
          await this.delegate.characters?.(filtered, 0, filtered.length);
        } else {
          this.heldWhitespace += raw;
        }
        return;
      }

      this.heldWhitespace += raw.slice(0, firstNonWhitespace);
      await this.flushHeld();

      const middleStart = firstNonWhitespace;
      let middleEnd = raw.length;
      if (this.openTrimmed > 0) {
        middleEnd = findLastNonWhitespace(raw) + 1;
      }

      const middle = raw.slice(middleStart, middleEnd);
      if (middle.length > 0) {
        const filtered = filterText(middle);
        await this.delegate.characters?.(filtered, 0, filtered.length);
      }
      this.heldWhitespace += raw.slice(middleEnd);
    });
  }

  ignorableWhitespace(ch: string, start: number, length: number): MaybePromise<void> {
    return this.run(async () => {
      await this.flushHeld();
      await this.delegate.ignorableWhitespace?.(ch, start, length);
    });
  }

  processingInstruction(target: string, data: string): MaybePromise<void> {
    return this.run(async () => {
      await this.flushHeld();
      await this.delegate.processingInstruction?.(target, data);
    });
  }

  skippedEntity(name: string): MaybePromise<void> {
    return this.run(async () => {
      await this.flushHeld();
      await this.delegate.skippedEntity?.(name);
    });
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
    return this.run(async () => {
      await this.startElement(name);
      await this.characters(value);
      await this.endElement(name);
    });
  }

  private async flushHeld(): Promise<void> {
    if (this.heldWhitespace.length > 0) {
      const held = this.heldWhitespace;
      this.heldWhitespace = "";
      const filtered = filterText(held);
      await this.delegate.characters?.(filtered, 0, filtered.length);
    }

    while (this.pendingStarts.length > 0) {
      const pending = this.pendingStarts.shift()!;
      await this.delegate.startElement?.(
        pending.uri,
        pending.localName,
        pending.qName,
        filterAttributes(pending.attributes),
      );
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
