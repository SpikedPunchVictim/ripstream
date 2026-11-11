import { MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { Ber, decodeOid, is, CONTEXT, UNIVERSAL, TAG_OID, TAG_SEQUENCE, type Element } from "./ber.ts";

/*
 * GeneralName as text, in the form of BouncyCastle's GeneralName.toString and BCStyle, which is what Tika's TSDParser
 * writes for the "TSA" metadata. Written from memory of BouncyCastle, whose source is not available here: the directory
 * name (the one a time stamping authority names itself with) and the three IA5 names are what this has been written for,
 * and the names BouncyCastle prints as an ASN.1 structure (other name, x400 address, EDI party name) come out as hex.
 */

const RFC822_NAME = 1;
const DNS_NAME = 2;
const DIRECTORY_NAME = 4;
const URI = 6;
const IP_ADDRESS = 7;
const REGISTERED_ID = 8;

/** BCStyle.DefaultSymbols for the attribute types a name usually has; any other is written as its dotted OID. */
const SYMBOLS = new Map<string, string>([
  ["2.5.4.3", "CN"],
  ["2.5.4.4", "SURNAME"],
  ["2.5.4.5", "SERIALNUMBER"],
  ["2.5.4.6", "C"],
  ["2.5.4.7", "L"],
  ["2.5.4.8", "ST"],
  ["2.5.4.9", "STREET"],
  ["2.5.4.10", "O"],
  ["2.5.4.11", "OU"],
  ["2.5.4.12", "T"],
  ["2.5.4.17", "PostalCode"],
  ["2.5.4.42", "GIVENNAME"],
  ["2.5.4.97", "organizationIdentifier"],
  ["1.2.840.113549.1.9.1", "E"],
  ["0.9.2342.19200300.100.1.1", "UID"],
  ["0.9.2342.19200300.100.1.25", "DC"],
]);

/** The characters IETFUtils.valueToString puts a backslash before. */
const SPECIAL = ',"\\+=<>;';

const TAG_UTF8_STRING = 12;
const TAG_PRINTABLE_STRING = 19;
const TAG_TELETEX_STRING = 20;
const TAG_IA5_STRING = 22;
const TAG_BMP_STRING = 30;

/** `tag: value` for the GeneralName `name`, which `limit` bounds. */
export function generalNameToString(ber: Ber, name: Element, limit: number): string {
  if (name.tagClass !== CONTEXT) throw new MalformedDocumentError("A GeneralName is context-tagged");
  const text = describe(ber, name, limit);
  return `${name.tagNumber}: ${text}`;
}

function describe(ber: Ber, name: Element, limit: number): string {
  switch (name.tagNumber) {
    case RFC822_NAME:
    case DNS_NAME:
    case URI:
      return latin1(ber.content(name));
    case DIRECTORY_NAME: {
      // directoryName is tagged explicitly, as Name is a CHOICE: its content is the Name.
      for (const child of ber.children(name, limit)) return x500NameToString(ber, child, limit);
      throw new MalformedDocumentError("An empty directory name");
    }
    case IP_ADDRESS:
      return `#${hex(ber.content(name))}`;
    case REGISTERED_ID:
      return decodeOid(ber.content(name));
    default:
      return `#${hex(ber.content(name))}`;
  }
}

/** BCStyle.toString: the RDNs in the order they are encoded, joined by commas, the attributes of one RDN by plus signs. */
function x500NameToString(ber: Ber, name: Element, limit: number): string {
  if (!is(name, UNIVERSAL, TAG_SEQUENCE, true)) throw new MalformedDocumentError("A Name is a SEQUENCE");
  const end = name.contentEnd ?? limit;
  const rdns: string[] = [];
  for (const rdn of ber.children(name, end)) {
    const attributes: string[] = [];
    for (const attribute of ber.children(rdn, end)) attributes.push(attributeToString(ber, attribute, end));
    rdns.push(attributes.join("+"));
  }
  return rdns.join(",");
}

function attributeToString(ber: Ber, attribute: Element, limit: number): string {
  const parts: Element[] = [];
  for (const child of ber.children(attribute, limit)) {
    if (parts.length === 2) throw new MalformedDocumentError("An AttributeTypeAndValue is an OID and a value");
    parts.push(child);
  }
  const [type, value] = parts;
  if (type === undefined || value === undefined || !is(type, UNIVERSAL, TAG_OID, false)) {
    throw new MalformedDocumentError("An AttributeTypeAndValue is an OID and a value");
  }
  const oid = decodeOid(ber.content(type));
  return `${SYMBOLS.get(oid) ?? oid}=${attributeValue(ber, value)}`;
}

/**
 * A string type as escaped text; any other type, and a UniversalString, as `#` and the hex of its DER encoding. The hex
 * form is not escaped: its number sign is the mark of the form, where in a string one is escaped.
 */
function attributeValue(ber: Ber, value: Element): string {
  if (value.tagClass === UNIVERSAL && !value.constructed) {
    const content = ber.content(value);
    switch (value.tagNumber) {
      case TAG_UTF8_STRING:
        return escapeString(new TextDecoder("utf-8").decode(content));
      case TAG_PRINTABLE_STRING:
      case TAG_TELETEX_STRING:
      case TAG_IA5_STRING:
        return escapeString(latin1(content));
      case TAG_BMP_STRING:
        return escapeString(new TextDecoder("utf-16be").decode(content));
      default:
        return `#${hex(derEncoding(value, content))}`;
    }
  }
  throw new MalformedDocumentError("An attribute value of a constructed type");
}

/** IETFUtils.valueToString: a backslash before the characters of RFC 2253 that need one, and before outer spaces. */
function escapeString(value: string): string {
  const text = value.startsWith("#") ? `\\${value}` : value;
  // An escaped leading # is not escaped again.
  const skip = text.startsWith("\\#") ? 2 : 0;
  let escaped = text.slice(0, skip);
  for (const char of text.slice(skip)) escaped += SPECIAL.includes(char) ? `\\${char}` : char;
  let start = 0;
  while (start < escaped.length && escaped[start] === " ") start++;
  let end = escaped.length;
  while (end > start && escaped[end - 1] === " ") end--;
  return "\\ ".repeat(start) + escaped.slice(start, end) + "\\ ".repeat(escaped.length - end);
}

/** The header octets of a primitive element of the given content, for a tag number below 31 and a length below 2^32. */
function derEncoding(element: Element, content: Uint8Array): Uint8Array {
  const length = content.length;
  const lengthOctets =
    length < 0x80 ? [length] : length < 0x100 ? [0x81, length] : length < 0x10000 ? [0x82, length >> 8, length & 0xff] : [0x84, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff];
  const header = [(element.tagClass << 6) | Math.min(element.tagNumber, 0x1f), ...lengthOctets];
  return Uint8Array.from([...header, ...content]);
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
