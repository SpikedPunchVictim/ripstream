export interface Attribute {
  readonly uri: string;
  readonly localName: string;
  readonly qName: string;
  readonly type: string;
  readonly value: string;
}

export interface Attributes {
  getLength(): number;
  getQName(index: number): string;
  getURI(index: number): string;
  getLocalName(index: number): string;
  getType(index: number): string;
  getValue(index: number): string;
  getValueByQName(qName: string): string | null;
  getValueByURI(uri: string, localName: string): string | null;
  readonly names: readonly Attribute[];
}

/** Minimal SAX-compatible Attributes implementation. */
export class AttributesImpl implements Attributes {
  private readonly attributes: Attribute[] = [];

  constructor(source?: Attributes | readonly Attribute[]) {
    if (source === undefined) return;
    const values = "names" in source ? source.names : source;
    for (const attribute of values) this.attributes.push({ ...attribute });
  }

  getLength(): number {
    return this.attributes.length;
  }

  getQName(index: number): string {
    return this.attributes[index]?.qName ?? "";
  }

  getURI(index: number): string {
    return this.attributes[index]?.uri ?? "";
  }

  getLocalName(index: number): string {
    return this.attributes[index]?.localName ?? "";
  }

  getType(index: number): string {
    return this.attributes[index]?.type ?? "CDATA";
  }

  getValue(index: number): string {
    return this.attributes[index]?.value ?? "";
  }

  getValueByQName(qName: string): string | null {
    return this.attributes.find((attribute) => attribute.qName === qName)?.value ?? null;
  }

  getValueByURI(uri: string, localName: string): string | null {
    return (
      this.attributes.find(
        (attribute) =>
          attribute.uri === uri && attribute.localName === localName,
      )?.value ?? null
    );
  }

  get names(): readonly Attribute[] {
    return this.attributes;
  }

  addAttribute(
    uri: string,
    localName: string,
    qName: string,
    type: string,
    value: string,
  ): void {
    this.attributes.push({ uri, localName, qName, type, value });
  }

  clear(): void {
    this.attributes.length = 0;
  }
}
