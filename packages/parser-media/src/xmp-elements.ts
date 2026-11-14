/*
 * Linear readers for the few XMP elements the image parsers pick out of a packet. The regexes they replace
 * (`<dc:title\b[^>]*>([\s\S]*?)</dc:title>` and its rdf:li and tag-strip siblings) retry from every opener when
 * there is no closer, which is quadratic on a packet of unclosed elements and a packet may be 64 MiB.
 */

/** True when `xml` has `<name` at `at` and the name ends there, as `\b` after the name would require. */
function opensElement(xml: string, at: number, name: string): boolean {
  const next = xml.charCodeAt(at + 1 + name.length);
  return Number.isNaN(next) ? true : !/\w/.test(String.fromCharCode(next));
}

/** The text of the next `<name ...>...</name>` at or after `from`, and where it ends; null when there is none. */
function nextElement(xml: string, name: string, from: number): { inner: string; end: number } | null {
  const closer = `</${name}>`;
  let at = xml.indexOf(`<${name}`, from);
  while (at !== -1 && !opensElement(xml, at, name)) at = xml.indexOf(`<${name}`, at + 1);
  if (at === -1) return null;
  const tagEnd = xml.indexOf(">", at + 1 + name.length);
  if (tagEnd === -1) return null;
  const close = xml.indexOf(closer, tagEnd + 1);
  // With no closer after this opener there is none after a later one either.
  if (close === -1) return null;
  return { inner: xml.slice(tagEnd + 1, close), end: close + closer.length };
}

/** What lies between the first `<name ...>` and its `</name>`, or undefined. */
export function xmpElementBlock(xml: string, name: string): string | undefined {
  return nextElement(xml, name, 0)?.inner;
}

/** The content of each `<rdf:li>` in a block, tags still in place. */
export function xmpListItems(block: string): string[] {
  const items: string[] = [];
  for (let from = 0; ; ) {
    const item = nextElement(block, "rdf:li", from);
    if (item === null) return items;
    items.push(item.inner);
    from = item.end;
  }
}

/** `value` without its `<...>` tags, as `replace(/<[^>]+>/g, "")` would leave it. */
export function stripTags(value: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = value.indexOf("<", from);
    if (open === -1) return out + value.slice(from);
    const close = value.indexOf(">", open + 1);
    if (close === -1) return out + value.slice(from);
    // "<>" is not a tag to the regex (it needs a character between); it stays as it is.
    out += close === open + 1 ? value.slice(from, close + 1) : value.slice(from, open);
    from = close + 1;
  }
}
