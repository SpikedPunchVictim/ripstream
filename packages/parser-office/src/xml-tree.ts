import { MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { SaxesParser } from "saxes";

export const MAX_XML_DEPTH = 256;

export interface XmlNode {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlNode[];
  text: string;
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

/** Builds a minimal element tree for a document part. */
export function parseXmlTree(xml: string, options: XmlTreeOptions = {}): XmlNode {
  const root: XmlNode = { name: "#document", attributes: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const parser = new SaxesParser({ xmlns: false });
  if (options.skipEntitiesOfExternalDtd === true) skipEntitiesOfExternalDtd(parser);

  parser.on("opentag", (tag) => {
    if (stack.length > MAX_XML_DEPTH) {
      throw new MalformedDocumentError(
        `XML nesting exceeds ${MAX_XML_DEPTH} levels`,
      );
    }
    const parent = stack[stack.length - 1]!;
    const node: XmlNode = {
      name: tag.name,
      attributes: { ...(tag.attributes as Record<string, string>) },
      children: [],
      text: "",
    };
    parent.children.push(node);
    stack.push(node);
  });
  parser.on("text", (text) => {
    stack[stack.length - 1]!.text += text;
  });
  parser.on("closetag", () => {
    if (stack.length > 1) stack.pop();
  });
  parser.write(xml).close();
  return root;
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
