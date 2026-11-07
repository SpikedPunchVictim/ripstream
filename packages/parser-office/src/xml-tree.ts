import { MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { SaxesParser } from "saxes";

const MAX_XML_DEPTH = 256;

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

/** Builds a minimal element tree for a document part. */
export function parseXmlTree(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", attributes: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const parser = new SaxesParser({ xmlns: false });

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
