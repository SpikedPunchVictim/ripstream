import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { decodeUtf8 } from "./bytes.ts";
import { javaDoubleString } from "./java-double.ts";
import { localName, parseXmlTree, type XmlNode } from "./xml-tree.ts";

/*
 * A property-list reader for the iWork package parsers, which Tika feeds to dd-plist's PropertyListParser (binary
 * "bplist00" and XML lists). Bounded for untrusted input: every count is checked against the bytes present before a
 * loop runs, references are followed to a depth cap, and the objects a list expands to are capped. parser-archive's
 * PlistParser caps the expansion the same way for the same reason; it is a parser that writes text, not a reader that
 * returns values, and parser-office does not depend on parser-archive.
 */

export type PlistValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "integer"; readonly value: bigint }
  | { readonly kind: "real"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "date"; readonly value: Date }
  | { readonly kind: "data"; readonly value: Uint8Array }
  | { readonly kind: "uid"; readonly value: bigint }
  | { readonly kind: "null" }
  | { readonly kind: "array"; readonly value: readonly PlistValue[] }
  | { readonly kind: "dict"; readonly value: ReadonlyMap<string, PlistValue> };

const MAX_EXPANDED_NODES = 1_000_000;
const MAX_DEPTH = 256;
const BINARY_HEADER = "bplist00";
const TRAILER_BYTES = 32;
/** Seconds between the Unix epoch and the 2001-01-01 epoch binary lists count dates from. */
const APPLE_EPOCH_MS = 978_307_200_000;

export function parsePlist(data: Uint8Array): PlistValue {
  return startsWith(data, "bplist") ? new BinaryPlist(data).read() : readXml(data);
}

/** What dd-plist's `NSObject.toString()` gives for a value, which is what Tika writes into the metadata. */
export function plistText(value: PlistValue): string {
  switch (value.kind) {
    case "string":
      return value.value;
    case "integer":
    case "uid":
      return value.value.toString();
    case "real":
      return javaDoubleString(value.value);
    case "boolean":
      return String(value.value);
    case "date":
      return javaDateString(value.value);
    case "data":
      return Buffer.from(value.value).toString("base64");
    case "array":
      return `[${value.value.map(plistText).join(", ")}]`;
    case "dict":
      return `{${[...value.value].map(([key, entry]) => `${key}=${plistText(entry)}`).join(", ")}}`;
    case "null":
      // dd-plist hands back null here, and the toString on it throws in Tika.
      throw new MalformedDocumentError("Property list value is null");
  }
}

function startsWith(data: Uint8Array, prefix: string): boolean {
  return data.byteLength >= prefix.length && [...prefix].every((char, index) => data[index] === char.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Binary lists
// ---------------------------------------------------------------------------

class BinaryPlist {
  readonly #data: Uint8Array;
  readonly #view: DataView;
  readonly #offsetSize: number;
  readonly #refSize: number;
  readonly #objectCount: number;
  readonly #topObject: number;
  readonly #tableOffset: number;
  /** Where the objects end and the offset table begins: nothing an object reads may reach past it. */
  readonly #tableEnd: number;
  #nodes = 0;

  constructor(data: Uint8Array) {
    if (!startsWith(data, BINARY_HEADER)) throw new MalformedDocumentError("Unsupported binary property list version");
    if (data.byteLength < BINARY_HEADER.length + 1 + TRAILER_BYTES) {
      throw new MalformedDocumentError("Binary property list is shorter than its trailer");
    }
    this.#data = data;
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const trailer = data.byteLength - TRAILER_BYTES;
    this.#offsetSize = data[trailer + 6]!;
    this.#refSize = data[trailer + 7]!;
    if (this.#offsetSize < 1 || this.#offsetSize > 8) throw new MalformedDocumentError("Binary property list offset size is out of range");
    if (this.#refSize < 1 || this.#refSize > 8) throw new MalformedDocumentError("Binary property list reference size is out of range");
    this.#objectCount = this.#trailerField(trailer + 8);
    this.#topObject = this.#trailerField(trailer + 16);
    this.#tableOffset = this.#trailerField(trailer + 24);
    if (this.#objectCount < 1 || this.#topObject >= this.#objectCount) {
      throw new MalformedDocumentError("Binary property list object count or top object is out of range");
    }
    if (this.#tableOffset < BINARY_HEADER.length || this.#tableOffset + this.#objectCount * this.#offsetSize > trailer) {
      throw new MalformedDocumentError("Binary property list offset table is outside the file");
    }
    this.#tableEnd = this.#tableOffset;
  }

  read(): PlistValue {
    return this.#object(this.#topObject, 0);
  }

  /** A trailer field, which can only be as large as the file: anything bigger is refused before it is used. */
  #trailerField(at: number): number {
    const value = this.#view.getBigUint64(at);
    if (value > BigInt(this.#data.byteLength)) throw new MalformedDocumentError("Binary property list trailer field is out of range");
    return Number(value);
  }

  #object(index: number, depth: number): PlistValue {
    if (++this.#nodes > MAX_EXPANDED_NODES) {
      throw new LimitExceededError(`Property list expands to more than ${MAX_EXPANDED_NODES} objects`);
    }
    if (depth > MAX_DEPTH) throw new MalformedDocumentError(`Property list nests deeper than ${MAX_DEPTH} levels`);
    const at = this.#offsetOf(index);
    const marker = this.#data[at]!;
    const low = marker & 0x0f;
    switch (marker >> 4) {
      case 0x0:
        return this.#simple(low);
      case 0x1: {
        const size = 1 << low;
        if (size > 8) throw new MalformedDocumentError("Property list integer is wider than 8 bytes");
        const bytes = this.#bytes(at + 1, size);
        return { kind: "integer", value: size === 8 ? BigInt.asIntN(64, toBigInt(bytes)) : toBigInt(bytes) };
      }
      case 0x2: {
        const size = 1 << low;
        if (size !== 4 && size !== 8) throw new MalformedDocumentError("Property list real is neither 4 nor 8 bytes");
        const bytes = this.#bytes(at + 1, size);
        const view = new DataView(bytes.buffer, bytes.byteOffset, size);
        return { kind: "real", value: size === 4 ? view.getFloat32(0) : view.getFloat64(0) };
      }
      case 0x3: {
        if (low !== 3) throw new MalformedDocumentError("Property list date is not 8 bytes");
        const bytes = this.#bytes(at + 1, 8);
        const seconds = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0);
        return { kind: "date", value: new Date(APPLE_EPOCH_MS + seconds * 1000) };
      }
      case 0x4: {
        const { count, start } = this.#count(at, low);
        return { kind: "data", value: this.#bytes(start, count) };
      }
      case 0x5: {
        const { count, start } = this.#count(at, low);
        return { kind: "string", value: asciiText(this.#bytes(start, count)) };
      }
      case 0x6: {
        const { count, start } = this.#count(at, low);
        return { kind: "string", value: new TextDecoder("utf-16be").decode(this.#bytes(start, count * 2)) };
      }
      case 0x8:
        return { kind: "uid", value: toBigInt(this.#bytes(at + 1, low + 1)) };
      case 0xa:
      case 0xc:
        return this.#array(at, low, depth);
      case 0xd:
        return this.#dict(at, low, depth);
      default:
        throw new MalformedDocumentError(`Unknown property list object marker 0x${marker.toString(16)}`);
    }
  }

  #simple(low: number): PlistValue {
    if (low === 0x00 || low === 0x0f) return { kind: "null" };
    if (low === 0x08) return { kind: "boolean", value: false };
    if (low === 0x09) return { kind: "boolean", value: true };
    throw new MalformedDocumentError(`Unknown property list simple value 0x${low.toString(16)}`);
  }

  #array(at: number, low: number, depth: number): PlistValue {
    const { count, start } = this.#count(at, low);
    this.#bytes(start, count * this.#refSize);
    const items: PlistValue[] = [];
    for (let slot = 0; slot < count; slot++) items.push(this.#object(this.#reference(start + slot * this.#refSize), depth + 1));
    return { kind: "array", value: items };
  }

  #dict(at: number, low: number, depth: number): PlistValue {
    const { count, start } = this.#count(at, low);
    this.#bytes(start, count * this.#refSize * 2);
    const entries = new Map<string, PlistValue>();
    for (let slot = 0; slot < count; slot++) {
      const key = this.#object(this.#reference(start + slot * this.#refSize), depth + 1);
      if (key.kind !== "string") throw new MalformedDocumentError("Property list dictionary key is not a string");
      const valueAt = start + (count + slot) * this.#refSize;
      entries.set(key.value, this.#object(this.#reference(valueAt), depth + 1));
    }
    return { kind: "dict", value: entries };
  }

  /** An object's element count: the marker's low nibble, or, at 0xF, the integer object that follows. */
  #count(at: number, low: number): { count: number; start: number } {
    if (low !== 0x0f) return { count: low, start: at + 1 };
    const marker = this.#bytes(at + 1, 1)[0]!;
    if (marker >> 4 !== 0x1) throw new MalformedDocumentError("Property list length is not an integer object");
    const size = 1 << (marker & 0x0f);
    if (size > 8) throw new MalformedDocumentError("Property list length is wider than 8 bytes");
    const count = toBigInt(this.#bytes(at + 2, size));
    if (count > BigInt(this.#data.byteLength)) throw new MalformedDocumentError("Property list length is larger than the file");
    return { count: Number(count), start: at + 2 + size };
  }

  #reference(at: number): number {
    return Number(toBigInt(this.#bytes(at, this.#refSize)));
  }

  #offsetOf(index: number): number {
    if (index >= this.#objectCount) throw new MalformedDocumentError("Property list object reference is out of range");
    const at = this.#tableOffset + index * this.#offsetSize;
    const offset = toBigInt(this.#data.subarray(at, at + this.#offsetSize));
    if (offset < BigInt(BINARY_HEADER.length) || offset >= BigInt(this.#tableEnd)) {
      throw new MalformedDocumentError("Property list object offset is outside the objects");
    }
    return Number(offset);
  }

  /** `length` bytes at `start`, from inside the objects: what a declared length asks for must be there. */
  #bytes(start: number, length: number): Uint8Array {
    if (start + length > this.#tableEnd) throw new MalformedDocumentError("Property list object runs past the objects");
    return this.#data.subarray(start, start + length);
  }
}

function toBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * US-ASCII, a byte above 0x7F becoming U+FFFD as Java's ASCII decoder makes it. Not TextDecoder("latin1") and a replace: that
 * decoder is windows-1252, which gives 0x80 to 0x9F characters (such as the euro sign) outside the range the replace covers.
 */
function asciiText(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte < 0x80 ? String.fromCharCode(byte) : "\uFFFD";
  return text;
}

// ---------------------------------------------------------------------------
// XML lists
// ---------------------------------------------------------------------------

function readXml(data: Uint8Array): PlistValue {
  let tree: XmlNode;
  try {
    tree = parseXmlTree(decodeUtf8(data));
  } catch (error) {
    if (error instanceof MalformedDocumentError) throw error;
    throw new MalformedDocumentError("Malformed XML property list", { cause: error });
  }
  const plist = tree.children.find((child) => localName(child.name) === "plist");
  const root = plist?.children[0];
  if (root === undefined) throw new MalformedDocumentError("Not an XML property list");
  return xmlValue(root, { nodes: 0 });
}

function xmlValue(node: XmlNode, budget: { nodes: number }): PlistValue {
  if (++budget.nodes > MAX_EXPANDED_NODES) {
    throw new LimitExceededError(`Property list holds more than ${MAX_EXPANDED_NODES} objects`);
  }
  const name = localName(node.name);
  switch (name) {
    case "string":
      return { kind: "string", value: node.text };
    case "integer":
      return { kind: "integer", value: xmlInteger(node.text) };
    case "real":
      return { kind: "real", value: xmlReal(node.text) };
    case "true":
    case "false":
      return { kind: "boolean", value: name === "true" };
    case "date":
      return { kind: "date", value: xmlDate(node.text) };
    case "data":
      return { kind: "data", value: new Uint8Array(Buffer.from(node.text.replace(/\s+/g, ""), "base64")) };
    case "array":
      return { kind: "array", value: node.children.map((child) => xmlValue(child, budget)) };
    case "dict":
      return { kind: "dict", value: xmlDict(node, budget) };
    default:
      throw new MalformedDocumentError(`Unknown property list element <${name}>`);
  }
}

function xmlDict(node: XmlNode, budget: { nodes: number }): Map<string, PlistValue> {
  if (node.children.length % 2 !== 0) throw new MalformedDocumentError("Property list dictionary has a key with no value");
  const entries = new Map<string, PlistValue>();
  for (let index = 0; index < node.children.length; index += 2) {
    const key = node.children[index]!;
    if (localName(key.name) !== "key") throw new MalformedDocumentError("Property list dictionary has a value with no key");
    entries.set(key.text, xmlValue(node.children[index + 1]!, budget));
  }
  return entries;
}

function xmlInteger(text: string): bigint {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) throw new MalformedDocumentError(`Property list integer is not a number: ${trimmed.slice(0, 40)}`);
  return BigInt(trimmed);
}

function xmlReal(text: string): number {
  const trimmed = text.trim();
  if (/^nan$/i.test(trimmed)) return Number.NaN;
  if (/^[+-]?inf(inity)?$/i.test(trimmed)) return trimmed.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    throw new MalformedDocumentError(`Property list real is not a number: ${trimmed.slice(0, 40)}`);
  }
  return Number(trimmed);
}

function xmlDate(text: string): Date {
  const date = new Date(text.trim());
  if (Number.isNaN(date.getTime())) throw new MalformedDocumentError(`Property list date is not a date: ${text.trim().slice(0, 40)}`);
  return date;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Date.toString()` as Java writes it ("Thu Jun 12 18:32:21 UTC 2014"), in UTC where Java uses the JVM's time zone. */
function javaDateString(date: Date): string {
  if (Number.isNaN(date.getTime())) return "NaN";
  const two = (value: number): string => String(value).padStart(2, "0");
  const time = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
  return `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${two(date.getUTCDate())} ${time} UTC ${date.getUTCFullYear()}`;
}
