import { SaxesParser } from "saxes";

export interface XmlAttribute {
  /** The prefix as written, empty when there is none. */
  readonly prefix: string;
  readonly local: string;
  readonly value: string;
}

export interface XmlElement {
  readonly local: string;
  /** The element's namespace URI, empty when it has none. */
  readonly uri: string;
  readonly attributes: readonly XmlAttribute[];
}

export interface XmlParseOptions {
  /** Refuse a document that has a DOCTYPE, as POI's `DocumentHelper` does. */
  readonly refuseDoctype?: boolean;
}

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

const STOP = Symbol("xml-parse-stop");

/**
 * Walks start tags in document order, namespace-aware. A visitor returns true to stop. saxes resolves no entities and
 * fetches nothing, so a hostile DOCTYPE cannot expand or reach out. Whatever the visitor saw before an error still
 * counts: Tika's SAX handlers are lenient, while a strict reader (POI's) discards it on a false return.
 *
 * Returns true only when the whole document decoded and parsed without error and the visitor never stopped early.
 *
 * Namespaces are resolved here, not by saxes: with `xmlns: true` saxes walks every open element for each prefix it
 * cannot find in the current one, which is quadratic in nesting depth (40k nested `<a>` took 6.7 s) while Java parses
 * the same document at once. This resolver keeps one stack of URIs per prefix and is linear.
 */
export function parseXml(
  data: Uint8Array,
  visit: (element: XmlElement) => boolean | void,
  options: XmlParseOptions = {},
): boolean {
  const decoded = decodeXmlBytes(data);
  if (decoded === null) return false;

  const scope = new NamespaceScope();
  const parser = new SaxesParser({ xmlns: false });
  if (options.refuseDoctype === true) {
    parser.on("doctype", () => {
      throw new XmlRefused("DOCTYPE");
    });
  }
  parser.on("opentag", (tag) => {
    const element = scope.open(tag.name, tag.attributes as Record<string, string>);
    if (visit(element) === true) throw STOP;
  });
  parser.on("closetag", () => scope.close());

  try {
    parser.write(decoded.text).close();
    return decoded.complete;
  } catch {
    return false;
  }
}

class XmlRefused extends Error {}

/**
 * Namespace bindings in scope, as one stack of URIs per prefix plus the prefixes each open element declared, so that a
 * lookup is constant time however deeply the elements nest. Raises on what Namespaces in XML 1.0 forbids (an unbound
 * prefix, a rebound `xml` or `xmlns`, a prefix bound to nothing, two attributes with the same expanded name).
 *
 * Call `open` for each start tag and `close` for each end tag, over a SaxesParser made with `xmlns: false`.
 */
export class NamespaceScope {
  private readonly bindings = new Map<string, string[]>([
    ["xml", [XML_NAMESPACE]],
    ["xmlns", [XMLNS_NAMESPACE]],
  ]);
  private readonly declared: string[][] = [];

  open(name: string, attributes: Record<string, string>): XmlElement {
    const declaredHere: string[] = [];
    const parsed: (XmlAttribute & { readonly name: string })[] = [];
    for (const [attributeName, value] of Object.entries(attributes)) {
      const { prefix, local } = qname(attributeName);
      parsed.push({ name: attributeName, prefix, local, value });
      if (prefix === "xmlns") this.addBinding(local, value, declaredHere);
      else if (attributeName === "xmlns") this.addBinding("", value, declaredHere);
    }
    this.declared.push(declaredHere);

    const element = qname(name);
    if (element.prefix === "xmlns") throw new XmlRefused('"xmlns" as an element prefix');
    const uri = this.resolve(element.prefix) ?? "";
    if (element.prefix !== "" && uri === "") throw new XmlRefused(`unbound prefix ${element.prefix}`);

    const seen = new Set<string>();
    for (const attribute of parsed) {
      let expanded = attribute.name;
      if (attribute.prefix !== "") {
        const attributeUri = this.resolve(attribute.prefix);
        if (attributeUri === undefined) throw new XmlRefused(`unbound prefix ${attribute.prefix}`);
        expanded = `{${attributeUri}}${attribute.local}`;
      }
      if (seen.has(expanded)) throw new XmlRefused(`duplicate attribute ${expanded}`);
      seen.add(expanded);
    }
    return { local: element.local, uri, attributes: parsed };
  }

  close(): void {
    for (const prefix of this.declared.pop() ?? []) this.bindings.get(prefix)?.pop();
  }

  private addBinding(prefix: string, rawValue: string, declaredHere: string[]): void {
    const uri = rawValue.trim();
    if (prefix !== "" && uri === "") throw new XmlRefused("prefix bound to nothing");
    checkBinding(prefix, uri);
    const stack = this.bindings.get(prefix);
    if (stack === undefined) this.bindings.set(prefix, [uri]);
    else stack.push(uri);
    declaredHere.push(prefix);
  }

  private resolve(prefix: string): string | undefined {
    const stack = this.bindings.get(prefix);
    return stack?.[stack.length - 1];
  }
}

function qname(name: string): { readonly prefix: string; readonly local: string } {
  const colon = name.indexOf(":");
  if (colon === -1) return { prefix: "", local: name };
  const prefix = name.slice(0, colon);
  const local = name.slice(colon + 1);
  if (prefix === "" || local === "" || local.includes(":")) throw new XmlRefused(`malformed name ${name}`);
  return { prefix, local };
}

function checkBinding(prefix: string, uri: string): void {
  if (prefix === "xml" && uri !== XML_NAMESPACE) throw new XmlRefused("xml prefix rebound");
  if (prefix === "xmlns" && uri !== XMLNS_NAMESPACE) throw new XmlRefused("xmlns prefix rebound");
  if (uri === XMLNS_NAMESPACE) throw new XmlRefused("xmlns namespace assigned");
  if (uri === XML_NAMESPACE && prefix !== "xml") throw new XmlRefused("xml namespace assigned");
}

const DECLARED_ENCODING =
  /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"[^"]*"|'[^']*')[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"([A-Za-z][A-Za-z0-9._-]*)"|'([A-Za-z][A-Za-z0-9._-]*)')/;
/** The XML declaration is ASCII and short; there is nothing to gain from looking further. */
const DECLARATION_BYTES = 256;

interface Decoded {
  readonly text: string;
  /** False when the bytes ran into one the charset forbids: `text` is what came before it. */
  readonly complete: boolean;
}

/**
 * Decodes a document the way Xerces (behind POI's and Tika's XML readers) does, or returns null where it refuses
 * before reading anything: the byte order mark or the first four bytes pick UTF-8 or UTF-16, and a declared `encoding`
 * must then agree (UTF-16 bytes declared UTF-8, or UTF-8 bytes declared UTF-16, are fatal) or, for 8-bit text, name a
 * charset to decode with. Bytes the charset forbids (an overlong or surrogate UTF-8 sequence, a lone UTF-16 surrogate,
 * a byte above 0x7f under US-ASCII) are fatal at that point, so the text before them is still returned. Charsets are
 * those a `TextDecoder` knows; one it does not know is refused, as Xerces refuses an unknown one.
 */
export function decodeXmlBytes(data: Uint8Array): Decoded | null {
  const utf16 = sniffUtf16(data);
  const bomLength = utf16 !== null ? (utf16.bom ? 2 : 0) : hasUtf8Bom(data) ? 3 : 0;
  const body = data.subarray(bomLength);

  if (utf16 === null) return decodeEightBit(body, declaredEncoding(Buffer.from(body.subarray(0, DECLARATION_BYTES)).toString("latin1")));

  const label = utf16.littleEndian ? "utf-16le" : "utf-16be";
  const head = new TextDecoder(label, { ignoreBOM: true }).decode(body.subarray(0, DECLARATION_BYTES * 2));
  const declared = declaredEncoding(head);
  const accepted = ["UTF-16", label.toUpperCase()];
  if (declared !== null && !accepted.includes(declared.toUpperCase())) return null;
  return decodeStrict(label, body);
}

interface Utf16 {
  readonly littleEndian: boolean;
  readonly bom: boolean;
}

function sniffUtf16(data: Uint8Array): Utf16 | null {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return { littleEndian: true, bom: true };
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return { littleEndian: false, bom: true };
  if (data.length >= 4 && data[0] === 0x3c && data[1] === 0x00 && data[2] === 0x3f && data[3] === 0x00) {
    return { littleEndian: true, bom: false };
  }
  if (data.length >= 4 && data[0] === 0x00 && data[1] === 0x3c && data[2] === 0x00 && data[3] === 0x3f) {
    return { littleEndian: false, bom: false };
  }
  return null;
}

function hasUtf8Bom(data: Uint8Array): boolean {
  return data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
}

function declaredEncoding(head: string): string | null {
  const match = DECLARED_ENCODING.exec(head);
  return match === null ? null : (match[1] ?? match[2] ?? null);
}

/** `label` must be a charset a `TextDecoder` knows. On invalid bytes the text stops before the first replacement character. */
function decodeStrict(label: string, body: Uint8Array): Decoded {
  try {
    return { text: new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(body), complete: true };
  } catch {
    const lossy = new TextDecoder(label, { ignoreBOM: true }).decode(body);
    const bad = lossy.indexOf("\uFFFD");
    return { text: bad === -1 ? lossy : lossy.slice(0, bad), complete: false };
  }
}

function decodeEightBit(body: Uint8Array, declared: string | null): Decoded | null {
  const label = declared?.toLowerCase() ?? "utf-8";
  if (label.startsWith("utf-16") || label.startsWith("utf16") || label === "ucs-2") return null;
  if (label === "utf-8" || label === "utf8") return decodeStrict("utf-8", body);
  if (label === "us-ascii" || label === "ascii") {
    const bad = body.findIndex((byte) => byte >= 0x80);
    return { text: latin1(bad === -1 ? body : body.subarray(0, bad)), complete: bad === -1 };
  }
  // WHATWG maps ISO-8859-1 to windows-1252, which differs on 0x80-0x9f; Java does not.
  if (label === "iso-8859-1" || label === "iso_8859-1" || label === "latin1") return { text: latin1(body), complete: true };
  let canonical: string;
  try {
    canonical = new TextDecoder(label).encoding;
  } catch {
    return null;
  }
  return canonical.startsWith("utf-16") ? null : decodeStrict(canonical, body);
}

function latin1(body: Uint8Array): string {
  return Buffer.from(body).toString("latin1");
}
