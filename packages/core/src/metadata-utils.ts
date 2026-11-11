import { metadataKeyDefinition } from "./generated/metadata-schema.ts";
import { Metadata } from "./metadata.ts";

/** Coerces a string using the generated metadata schema value type. */
export function coerceMetadataValue(
  key: string,
  value: string,
): string | number | boolean {
  const type = metadataKeyDefinition(key)?.valueType;
  if (type === "INTEGER") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (type === "REAL" || type === "RATIONAL") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (type === "BOOLEAN" && (value === "true" || value === "false")) {
    return value === "true";
  }
  return value;
}

/** CSV serialization: one `key,value` row per value, RFC 4180 quoting. */
export function metadataToCsv(metadata: Metadata): string {
  const lines = ["key,value"];
  for (const name of metadata.names()) {
    for (const value of metadata.getAll(name)) {
      lines.push(`${csvCell(name)},${csvCell(value)}`);
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** XML serialization with escaped names and values. */
export function metadataToXml(metadata: Metadata): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<metadata>"];
  for (const name of metadata.names()) {
    for (const value of metadata.getAll(name)) {
      lines.push(
        `  <property name="${escapeXml(name)}">${escapeXml(value)}</property>`,
      );
    }
  }
  lines.push("</metadata>", "");
  return lines.join("\n");
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal XMP packet reader: RDF properties, attributes and simple elements. */
export function parseXmpPacket(xml: string): Metadata {
  const metadata = new Metadata();
  const element = /<([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1:\2>/g;
  for (const match of xml.matchAll(element)) {
    const key = `${match[1]}:${match[2]}`;
    const value = decodeXml(match[3] ?? "").trim();
    if (value.length > 0) metadata.add(key, value);
  }
  const attribute = /\b([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)=["']([^"']*)["']/g;
  for (const match of xml.matchAll(attribute)) {
    const value = decodeXml(match[3] ?? "").trim();
    if (value.length > 0) metadata.add(`${match[1]}:${match[2]}`, value);
  }
  return metadata;
}

/** Writes a minimal XMP packet for the supplied metadata. */
export function writeXmpPacket(metadata: Metadata): string {
  const properties: string[] = [];
  for (const name of metadata.names()) {
    const colon = name.indexOf(":");
    if (colon <= 0) continue;
    for (const value of metadata.getAll(name)) {
      properties.push(
        `    <${name}>${escapeXml(value)}</${name}>`,
      );
    }
  }
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `    <rdf:Description rdf:about="">`,
    ...properties,
    "    </rdf:Description>",
    "  </rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
    "",
  ].join("\n");
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
