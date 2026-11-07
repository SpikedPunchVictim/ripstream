import type { Attributes } from "../attributes.ts";
import type { ContentHandler, MaybePromise } from "../content-handler.ts";

type Sink = (text: string) => MaybePromise<void>;

/**
 * Streaming XHTML event stream to GitHub-flavored Markdown, Tika 4's default
 * output shape. Keeps a bounded structural stack; no DOM is built.
 */
export class MarkdownContentHandler implements ContentHandler {
  private readonly sink: Sink | null;
  private buffer = "";
  private inHead = false;
  private preDepth = 0;
  private listStack: Array<"ul" | "ol"> = [];
  private listCounters: number[] = [];
  private href: string | null = null;
  private linkText = "";
  private tableRow = 0;
  private tableCell = 0;
  private atLineStart = true;
  private lastWasBlank = true;

  constructor(sink?: Sink) {
    this.sink = sink ?? null;
  }

  startDocument(): void {}
  endDocument(): void {}

  async startElement(
    uri: string,
    localName: string,
    qName: string,
    attributes: Attributes,
  ): Promise<void> {
    const name = (qName || localName).toLowerCase();

    if (name === "head") {
      this.inHead = true;
      return;
    }
    if (name === "title" || name === "meta" || name === "link" || name === "base") return;
    if (this.inHead) return;

    switch (name) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        await this.blankLine();
        await this.write(`${"#".repeat(Number(name[1]))} `);
        break;
      case "p":
        await this.blankLine();
        break;
      case "div":
        if (attributes.getValueByQName("class") === "page") {
          await this.blankLine();
          await this.write("---\n");
        } else {
          await this.blankLine();
        }
        break;
      case "br":
        await this.write("  \n");
        break;
      case "hr":
        await this.blankLine();
        await this.write("---\n");
        break;
      case "strong":
      case "b":
        await this.write("**");
        break;
      case "em":
      case "i":
        await this.write("*");
        break;
      case "code":
        if (this.preDepth === 0) await this.write("`");
        break;
      case "pre":
        await this.blankLine();
        await this.write("```\n");
        this.preDepth++;
        break;
      case "blockquote":
        await this.blankLine();
        await this.write("> ");
        break;
      case "ul":
        this.listStack.push("ul");
        this.listCounters.push(0);
        break;
      case "ol":
        this.listStack.push("ol");
        this.listCounters.push(0);
        break;
      case "li": {
        const index = this.listCounters.length - 1;
        const ordered = this.listStack.at(-1) === "ol";
        this.listCounters[index] = (this.listCounters[index] ?? 0) + 1;
        await this.write(`${ordered ? `${this.listCounters[index]}.` : "-"} `);
        break;
      }
      case "a":
        this.href = attributes.getValueByQName("href");
        this.linkText = "";
        break;
      case "img": {
        const src = attributes.getValueByQName("src") ?? "";
        const alt = attributes.getValueByQName("alt") ?? "";
        await this.write(`![${alt}](${src})`);
        break;
      }
      case "table":
        await this.blankLine();
        this.tableRow = 0;
        break;
      case "tr":
        this.tableCell = 0;
        break;
      case "td":
      case "th":
        if (this.tableCell > 0) await this.write(" | ");
        else await this.write("| ");
        this.tableCell++;
        break;
    }
  }

  async endElement(uri: string, localName: string, qName: string): Promise<void> {
    const name = (qName || localName).toLowerCase();

    if (name === "head") {
      this.inHead = false;
      return;
    }
    if (this.inHead) return;

    switch (name) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
      case "p":
      case "blockquote":
        await this.write("\n");
        break;
      case "div":
        break;
      case "strong":
      case "b":
        await this.write("**");
        break;
      case "em":
      case "i":
        await this.write("*");
        break;
      case "code":
        if (this.preDepth === 0) await this.write("`");
        break;
      case "pre":
        this.preDepth = Math.max(0, this.preDepth - 1);
        await this.write("\n```\n");
        break;
      case "li":
        await this.write("\n");
        break;
      case "ul":
      case "ol":
        this.listStack.pop();
        this.listCounters.pop();
        await this.blankLine();
        break;
      case "a": {
        const href = this.href ?? "";
        const text = this.linkText || href;
        await this.write(`[${text}](${href})`);
        this.href = null;
        this.linkText = "";
        break;
      }
      case "tr":
        await this.write(" |\n");
        break;
      case "table":
        await this.write("\n");
        break;
    }
  }

  async characters(ch: string, start: number, length: number): Promise<void> {
    const text = ch.slice(start, start + length);
    if (this.href !== null) this.linkText += text;
    else await this.write(text);
  }

  async ignorableWhitespace(ch: string, start: number, length: number): Promise<void> {
    await this.characters(ch, start, length);
  }

  toString(): string {
    return this.buffer;
  }

  private async write(text: string): Promise<void> {
    if (text.length === 0) return;
    if (this.sink === null) {
      this.buffer += text;
    } else {
      await this.sink(text);
    }
    this.atLineStart = text.endsWith("\n");
    this.lastWasBlank = /^\n+$/.test(text);
  }

  private async blankLine(): Promise<void> {
    if (this.lastWasBlank) return;
    if (!this.atLineStart) await this.write("\n");
    await this.write("\n");
    this.lastWasBlank = true;
  }
}
