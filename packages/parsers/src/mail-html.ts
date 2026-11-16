import { Parser as HtmlParser } from "htmlparser2";

/**
 * A text/html email body as xberg's plain renderer writes it (xberg 1.4.0, `rendering/plain.rs` with
 * `extraction/html/structure`): blocks separated by a blank line, a heading indented two spaces per level and the blocks
 * after it indented by the same distance, list items each on a line and not indented, table cells joined by spaces and
 * rows by newlines, an image as its alt text (`[Image]` without one), a block quote's blocks indented two spaces, inline
 * markup dropped, `<br>` a newline and other white space one space (measured against the xberg CLI on 30 documents).
 */

interface Block {
  readonly kind: "paragraph" | "heading" | "item" | "table";
  readonly text: string;
  readonly level: number;
  /** The indentation of a paragraph, captured when it was written. */
  readonly indent: number;
}

const SKIPPED = new Set(["script", "style", "head", "title", "meta", "link"]);
const BLOCK_CONTAINERS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "figure", "figcaption", "address", "center",
  "form", "fieldset", "dl", "dt", "dd", "caption", "details", "summary",
]);

export function renderEmailHtml(html: string): string {
  const blocks: Block[] = [];
  let inline = "";
  let quote = 0;
  let pre = 0;
  let list = 0;
  let skip = 0;
  let heading: number | null = null;
  let headingText = "";
  const headings: number[] = [];
  let cell: string | null = null;
  let row: string[] | null = null;
  let rows: string[][] | null = null;

  const indent = (): number => (quote > 0 ? 2 : headings.length * 2);
  // The renderer separates blocks by a blank line, and a heading or a list item from what follows it by one newline.
  const flush = (kind: "paragraph" | "item" = list > 0 ? "item" : "paragraph"): void => {
    const text = inline.trim();
    inline = "";
    if (text.length > 0) blocks.push({ kind, text, level: 0, indent: indent() });
  };
  const collapse = (text: string): string => text.replace(/\s+/g, " ");
  const append = (text: string): void => {
    if (skip > 0) return;
    const value = pre > 0 ? text : collapse(text);
    if (heading !== null) headingText += value;
    else if (cell !== null) cell += value;
    else inline += value;
  };
  const addImage = (alt: string): void => {
    if (skip > 0) return;
    const text = alt.trim().length > 0 ? alt.trim() : "[Image]";
    if (heading !== null) headingText += text;
    else if (cell !== null) cell += text;
    else if (pre > 0) inline += text;
    else {
      flush();
      blocks.push({ kind: "paragraph", text, level: 0, indent: indent() });
    }
  };

  const parser = new HtmlParser(
    {
      onopentag(name, attributes) {
        if (SKIPPED.has(name)) {
          skip++;
          return;
        }
        if (skip > 0) return;
        if (/^h[1-6]$/.test(name)) {
          flush();
          heading = Number(name[1]);
          headingText = "";
        } else if (name === "br") {
          if (heading !== null) headingText += "\n";
          else if (cell !== null) cell += "\n";
          else inline += "\n";
        } else if (name === "img") {
          addImage(attributes.alt ?? "");
        } else if (name === "hr") {
          flush();
        } else if (name === "ul" || name === "ol") {
          flush();
          list++;
        } else if (name === "li") {
          flush();
        } else if (name === "table") {
          flush();
          rows = [];
        } else if (name === "tr") {
          row = [];
        } else if (name === "td" || name === "th") {
          cell = "";
        } else if (name === "blockquote") {
          flush();
          quote++;
        } else if (name === "pre") {
          flush();
          pre++;
        } else if (BLOCK_CONTAINERS.has(name)) {
          flush();
        }
      },
      ontext(text) {
        append(text);
      },
      onclosetag(name) {
        if (SKIPPED.has(name)) {
          if (skip > 0) skip--;
          return;
        }
        if (skip > 0) return;
        if (/^h[1-6]$/.test(name)) {
          const value = heading ?? 1;
          const text = headingText.trim();
          if (text.length > 0) {
            while (headings.length > 0 && headings[headings.length - 1]! >= value) headings.pop();
            const depth = headings.length > 0 ? headings.length + 1 : Math.max(1, value - 1);
            headings.push(value);
            blocks.push({ kind: "heading", text, level: value, indent: depth * 2 });
          }
          heading = null;
          headingText = "";
        } else if (name === "br" || name === "img" || name === "hr") {
          return;
        } else if (name === "ul" || name === "ol") {
          flush();
          list = Math.max(0, list - 1);
        } else if (name === "li") {
          flush("item");
        } else if (name === "table") {
          if (rows !== null && rows.length > 0) {
            blocks.push({ kind: "table", text: rows.map((cells) => cells.join(" ")).join("\n"), level: 0, indent: 0 });
          }
          rows = null;
        } else if (name === "tr") {
          if (row !== null && rows !== null) rows.push(row);
          row = null;
        } else if (name === "td" || name === "th") {
          if (cell !== null && row !== null) row.push(cell.trim());
          cell = null;
        } else if (name === "blockquote") {
          flush();
          quote = Math.max(0, quote - 1);
        } else if (name === "pre") {
          flush(list > 0 ? "item" : "paragraph");
          pre = Math.max(0, pre - 1);
        } else if (BLOCK_CONTAINERS.has(name)) {
          flush();
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  flush();

  let out = "";
  let previous: Block | undefined;
  for (const block of blocks) {
    const text = block.kind === "table" ? block.text : " ".repeat(block.kind === "heading" ? block.indent : block.kind === "paragraph" ? block.indent : 0) + block.text;
    if (text.length === 0) continue;
    if (out.length > 0) out += separator(previous!, block);
    out += text;
    previous = block;
  }
  return out.replace(/\s+$/, "");
}

function separator(previous: Block, next: Block): string {
  if (previous.kind === "heading") return "\n";
  if (previous.kind === "item" && (next.kind === "item" || next.kind === "paragraph")) return "\n";
  return "\n\n";
}
