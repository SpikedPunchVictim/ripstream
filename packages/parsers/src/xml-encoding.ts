/** Determines the encoding of an XML byte stream from its BOM or declaration. */
export function detectXmlEncoding(prefix: Uint8Array): string {
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

  let declaration = "";
  const limit = Math.min(prefix.length, 512);
  for (let index = 0; index < limit; index++) {
    declaration += String.fromCharCode(prefix[index]!);
  }
  const match = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(
    declaration,
  );
  return match?.[1]?.trim() ?? "utf-8";
}
