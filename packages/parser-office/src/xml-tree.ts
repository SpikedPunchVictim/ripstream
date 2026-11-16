import { MalformedDocumentError, RipstreamError } from "@spikedpunch/ripstream-core";
import { SaxesParser } from "saxes";

export const MAX_XML_DEPTH = 256;

export interface XmlNode {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlNode[];
  /** Every text and CDATA event of this element, concatenated; it loses where child elements sit between the pieces. */
  text: string;
  /** The same text and the child elements in document order, so mixed content keeps its order. Adjacent text is merged. */
  readonly content: (string | XmlNode)[];
}

export function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

export function attribute(
  node: XmlNode,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(node.attributes)) {
    if (localName(key) === name) return value;
  }
  return undefined;
}

export interface XmlTreeOptions {
  /**
   * An entity the document does not define is skipped, not refused, when its DOCTYPE names an external DTD: a parser that does
   * not read the DTD cannot know the entity is undefined (Xerces reports it as skipped, as Tika's SAX parsing does for the
   * `&nbsp;` of an XHTML chapter). Without such a DOCTYPE an undefined entity is still malformed.
   */
  readonly skipEntitiesOfExternalDtd?: boolean;
}

/** The document nests deeper than MAX_XML_DEPTH. */
class XmlDepthError extends MalformedDocumentError {}

/** Builds a minimal element tree for a document part. */
export function parseXmlTree(xml: string, options: XmlTreeOptions = {}): XmlNode {
  return buildTree(xml, options, false).root;
}

/** What a read that stops at its first error got: the tree of everything before it, and the error. */
export interface PartialXmlTree {
  readonly root: XmlNode;
  readonly failure?: Error;
}

/**
 * Builds the element tree up to the first well-formedness error, as a SAX handler sees a document: every event before the
 * error has been delivered, including the text that precedes an undefined entity ("First" of `First&nbsp;para`). Elements
 * the error left open stay in the tree. Limits (a RipstreamError) are still thrown.
 */
export function parseXmlTreeUntilError(xml: string, options: XmlTreeOptions = {}): PartialXmlTree {
  return buildTree(xml, options, true);
}

function buildTree(xml: string, options: XmlTreeOptions, untilError: boolean): PartialXmlTree {
  const root: XmlNode = { name: "#document", attributes: {}, children: [], text: "", content: [] };
  const stack: XmlNode[] = [root];
  const parser = new SaxesParser({ xmlns: false });
  if (options.skipEntitiesOfExternalDtd === true) skipEntitiesOfExternalDtd(parser);

  parser.on("opentag", (tag) => {
    if (stack.length > MAX_XML_DEPTH) {
      throw new XmlDepthError(`XML nesting exceeds ${MAX_XML_DEPTH} levels`);
    }
    const parent = stack[stack.length - 1]!;
    const node: XmlNode = {
      name: tag.name,
      attributes: { ...(tag.attributes as Record<string, string>) },
      children: [],
      text: "",
      content: [],
    };
    parent.children.push(node);
    parent.content.push(node);
    stack.push(node);
  });
  const onText = (text: string): void => appendText(stack[stack.length - 1]!, text);
  parser.on("text", onText);
  // CDATA is character data like any other (a feed, an EPUB chapter or a shared string may carry its text in it).
  parser.on("cdata", onText);
  parser.on("closetag", () => {
    if (stack.length > 1) stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    // Too deep is an error of the document like any other here: Tika's SAX handler fails at that depth with what came before kept.
    if (!untilError || (error instanceof RipstreamError && !(error instanceof XmlDepthError)) || !(error instanceof Error)) throw error;
    // saxes holds the text it has read in a private field until a tag ends it; an entity error is raised in the middle of it.
    const pending = (parser as unknown as { text: string }).text;
    if (/entit/.test(error.message) && pending.length > 0) onText(pending);
    return { root, failure: error };
  }
  return { root };
}

/** Adds text to an element as the tree builder does: to `text`, and to `content` merged with the text before it. */
export function appendText(node: XmlNode, text: string): void {
  node.text += text;
  const last = node.content.length - 1;
  const tail = node.content[last];
  if (typeof tail === "string") node.content[last] = tail + text;
  else node.content.push(text);
}

export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => localName(child.name) === name);
}

export function descendantsNamed(node: XmlNode, name: string): XmlNode[] {
  const result: XmlNode[] = [];
  const visit = (current: XmlNode): void => {
    for (const child of current.children) {
      if (localName(child.name) === name) result.push(child);
      visit(child);
    }
  };
  visit(node);
  return result;
}

const ENTITY_NAME = /^[A-Za-z_:][\w.:-]*$/;
const EXTERNAL_DTD = /\b(?:PUBLIC|SYSTEM)\b/;

function skipEntitiesOfExternalDtd(parser: SaxesParser): void {
  let externalDtd = false;
  parser.on("doctype", (doctype) => {
    externalDtd = EXTERNAL_DTD.test(doctype);
  });
  parser.ENTITIES = new Proxy(parser.ENTITIES, {
    get(entities, name) {
      const defined = entities[name as string];
      if (defined !== undefined || !externalDtd || typeof name !== "string" || !ENTITY_NAME.test(name)) return defined;
      return "";
    },
  });
}
