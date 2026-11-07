import {
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** Java class-file parser: class identity and member names, no bytecode execution. */
export class JavaClassParser implements Parser {
  readonly name = "ClassParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/java-vm")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const info = readClass(data);
    metadata.set("dc:title", info.name);
    if (info.superName.length > 0) {
      metadata.set("java:superclass", info.superName);
    }
    metadata.set("java:major-version", String(info.major));
    metadata.set("java:minor-version", String(info.minor));
    metadata.add("java:method", info.methods.join(", "));

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.element("h1", info.name);
    if (info.superName.length > 0) {
      await xhtml.element("p", `extends ${info.superName}`);
    }
    for (const method of info.methods) {
      await xhtml.element("p", method);
    }
    await xhtml.endDocument();
  }
}

interface ClassInfo {
  readonly name: string;
  readonly superName: string;
  readonly minor: number;
  readonly major: number;
  readonly methods: readonly string[];
}

function readClass(data: Uint8Array): ClassInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 10 || view.getUint32(0) !== 0xcafebabe) {
    throw new MalformedDocumentError("Not a Java class file");
  }
  const minor = view.getUint16(4);
  const major = view.getUint16(6);
  const count = view.getUint16(8);
  const utf8: string[] = [];
  const classNames: number[] = [];
  let offset = 10;

  for (let index = 1; index < count; index++) {
    // Largest fixed-size read in this loop is tag + u16 length.
    ensure(data, offset, 3, "constant pool");
    const tag = data[offset]!;
    offset++;
    if (tag === 1) {
      const length = view.getUint16(offset);
      offset += 2;
      utf8[index] = new TextDecoder("utf-8", { fatal: false }).decode(
        data.subarray(offset, offset + length),
      );
      offset += length;
    } else if (tag === 7) {
      classNames[index] = view.getUint16(offset);
      offset += 2;
    } else if (tag === 8 || tag === 16 || tag === 19 || tag === 20) {
      offset += 2;
    } else if (tag === 15) {
      offset += 3;
    } else if (tag === 3 || tag === 4 || tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) {
      offset += 4;
    } else if (tag === 5 || tag === 6) {
      offset += 8;
      index++;
    } else {
      throw new MalformedDocumentError(`Unsupported constant pool tag ${tag}`);
    }
    if (offset > data.byteLength) {
      throw new MalformedDocumentError("Truncated constant pool");
    }
  }

  ensure(data, offset, 8, "class header");
  const name = className(classNames, utf8, view.getUint16(offset + 2));
  const superName = className(classNames, utf8, view.getUint16(offset + 4));
  offset += 6;
  const interfaces = view.getUint16(offset);
  offset += 2 + interfaces * 2;
  ensure(data, offset, 2, "interfaces");

  offset = readMembers(data, view, offset, utf8, false).offset;
  let methods: string[] = [];
  ({ offset, names: methods } = readMembers(data, view, offset, utf8, true));
  return { name, superName, minor, major, methods };
}

function ensure(data: Uint8Array, offset: number, size: number, what: string): void {
  if (offset + size > data.byteLength) {
    throw new MalformedDocumentError(`Truncated class file (${what})`);
  }
}

function readMembers(
  data: Uint8Array,
  view: DataView,
  start: number,
  utf8: string[],
  collect: boolean,
): { offset: number; names: string[] } {
  let offset = start;
  ensure(data, offset, 2, "members");
  const count = view.getUint16(offset);
  offset += 2;
  const names: string[] = [];
  for (let index = 0; index < count; index++) {
    ensure(data, offset, 8, "member");
    const nameIndex = view.getUint16(offset + 2);
    const descriptorIndex = view.getUint16(offset + 4);
    const attributes = view.getUint16(offset + 6);
    offset += 8;
    for (let attribute = 0; attribute < attributes; attribute++) {
      ensure(data, offset, 6, "attribute");
      const length = view.getUint32(offset + 2);
      offset += 6 + length;
    }
    if (offset > data.byteLength) throw new MalformedDocumentError("Truncated class");
    if (collect) {
      names.push(`${utf8[nameIndex] ?? "?"}${utf8[descriptorIndex] ?? ""}`);
    }
  }
  return { offset, names };
}

function className(
  classes: number[],
  utf8: string[],
  index: number,
): string {
  const nameIndex = classes[index];
  return nameIndex === undefined ? "" : (utf8[nameIndex] ?? "").replace(/\//g, ".");
}
