/** Determines the encoding of an XML byte stream from its BOM or declaration. */
export function detectXmlEncoding(prefix: Uint8Array): string {
  if (prefix.length >= 4) {
    if (prefix[0] === 0xff && prefix[1] === 0xfe && prefix[2] === 0 && prefix[3] === 0) return "utf-32le";
    if (prefix[0] === 0 && prefix[1] === 0 && prefix[2] === 0xfe && prefix[3] === 0xff) return "utf-32be";
  }
  if (prefix.length >= 2) {
    if (prefix[0] === 0xff && prefix[1] === 0xfe) return "utf-16le";
    if (prefix[0] === 0xfe && prefix[1] === 0xff) return "utf-16be";
  }
  if (
    prefix.length >= 3 &&
    prefix[0] === 0xef &&
    prefix[1] === 0xbb &&
    prefix[2] === 0xbf
  ) {
    return "utf-8";
  }

  const bomless16 = detectBomlessUtf16(prefix);
  if (bomless16 !== null) return bomless16;

  let declaration = "";
  const limit = Math.min(prefix.length, 512);
  for (let index = 0; index < limit; index++) {
    declaration += String.fromCharCode(prefix[index]!);
  }
  const match = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(
    declaration,
  );
  const declared = match?.[1]?.trim() ?? "utf-8";
  // No BOM was found, so the bytes are 8-bit: a declaration of UTF-16 or UTF-32 cannot be true of them.
  return /^utf-?(16|32)(le|be)?$/i.test(declared) ? "utf-8" : declared;
}

/**
 * A UTF-16 document with no byte order mark that begins `<?` is read as UTF-16 when its declaration allows it, as Xerces
 * (Tika's XML reader) does from the first four bytes (measured on 4.2.0): an encoding of `UTF-16` or `ISO-10646-UCS-2`
 * takes either byte order, `UTF-16LE` and `UTF-16BE` only their own, and a declaration with no encoding takes either. Any
 * other encoding, or a document with no declaration, is not UTF-16 for Xerces and is left to the 8-bit rules.
 */
function detectBomlessUtf16(prefix: Uint8Array): "utf-16le" | "utf-16be" | null {
  if (prefix.length < 4) return null;
  let order: "utf-16le" | "utf-16be";
  if (prefix[0] === 0x3c && prefix[1] === 0 && prefix[2] === 0x3f && prefix[3] === 0) order = "utf-16le";
  else if (prefix[0] === 0 && prefix[1] === 0x3c && prefix[2] === 0 && prefix[3] === 0x3f) order = "utf-16be";
  else return null;
  const text = new TextDecoder(order).decode(prefix.subarray(0, Math.min(prefix.length, 1024)));
  const declared = /^<\?xml[^>]*?encoding\s*=\s*["']([^"']*)["']/.exec(text)?.[1];
  if (declared === undefined || /^(utf-16|iso-10646-ucs-2)$/i.test(declared)) return order;
  return declared.toLowerCase() === order ? order : null;
}
