/**
 * The syntax rules POI's `OPCPackage.open` enforces, which decide whether it opens a package at all: part names, the
 * part name a relationship target resolves to, and content types. Each rule was measured against Tika 4.2.0.
 */

/** URI path characters Java's `java.net.URI` refuses, plus the `?` and `#` that POI will not take in a part name. */
const ILLEGAL_PART_NAME_CHARACTER = /[\u0000- \u007f"<>\\^`{|}[\]?#\p{Zs}\p{Zl}\p{Zp}\p{Cc}]/u;

/** RFC 2616 `token`: printable ASCII except the separators `()<>@,;:\/"[]?={}`. */
const TOKEN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]";
/** POI's media type pattern: parameters are `;name=value` with no spaces, and the value's quotes are optional. */
const CONTENT_TYPE = new RegExp(`^${TOKEN}+/${TOKEN}+(?:;${TOKEN}+="?${TOKEN}+"?)*$`);

/**
 * The part name POI gives a ZIP entry, or null when POI skips the entry because the name is not a valid part name.
 * Backslashes are read as slashes and a missing leading slash is added.
 */
export function partNameOfEntry(entryName: string): string | null {
  const slashed = entryName.replaceAll("\\", "/");
  const partName = slashed.startsWith("/") ? slashed : `/${slashed}`;
  return isValidPartName(partName) ? partName : null;
}

/**
 * The part name a relationship target names, or null when it names none. An internal relative target is resolved
 * against the package root, as `java.net.URI.resolve` does; an absolute path, and the target of an external
 * relationship, is taken as written.
 */
export function targetPartName(target: string, external: boolean): string | null {
  const slashed = target.replaceAll("\\", "/");
  const partName = external || slashed.startsWith("/") ? slashed : resolveFromRoot(slashed);
  return isValidPartName(partName) ? partName : null;
}

/**
 * How POI compares part names: `java.net.URI.toASCIIString` (which writes a non-ASCII character as its UTF-8 bytes in
 * escapes), lower-cased, so `/a/é.xml` and `/a/%C3%A9.xml` are one part and the case of a name or of an escape does not
 * matter. Escapes of ASCII characters are not decoded: POI refuses a name that has one for an unreserved character.
 */
export function partNameKey(partName: string): string {
  let ascii = "";
  for (const character of partName) {
    // A lone surrogate cannot be written as UTF-8; POI could not have built a URI from it either.
    ascii += character.codePointAt(0)! < 0x80 || /[\uD800-\uDFFF]/u.test(character) ? character : encodeURIComponent(character);
  }
  return ascii.toLowerCase();
}

export function isValidContentType(value: string): boolean {
  return CONTENT_TYPE.test(value);
}

export function isValidPartName(partName: string): boolean {
  if (!partName.startsWith("/") || partName.endsWith("/")) return false;
  if (ILLEGAL_PART_NAME_CHARACTER.test(partName)) return false;
  if (!hasValidPercentEscapes(partName)) return false;
  // A segment may be neither empty nor end in a dot, which also refuses "." and "..".
  return partName
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && !segment.endsWith("."));
}

/**
 * Measured: a ZIP entry whose name is valid as written but whose decoded path (`URI.getPath`) is not, because an escape
 * hides a space, a `?`, a control or space-separator character, or a `%` that no longer starts an escape, makes POI
 * refuse the package, where an entry that is not valid as written is merely skipped. Override and target names are not
 * held to this.
 */
export function hasValidDecodedName(partName: string): boolean {
  const decoded = decodeEscapes(partName);
  return decoded === partName || (!ILLEGAL_PART_NAME_CHARACTER.test(decoded) && hasValidPercentEscapes(decoded));
}

/** Each run of escapes read as UTF-8, with a replacement character for bytes that are not, as `java.net.URI` does. */
function decodeEscapes(value: string): string {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => Buffer.from(run.replaceAll("%", ""), "hex").toString("utf8"));
}

/** Every `%` must start a two-digit escape, and the escape may not hide a slash, a backslash or an unreserved character. */
function hasValidPercentEscapes(partName: string): boolean {
  for (let index = partName.indexOf("%"); index !== -1; index = partName.indexOf("%", index + 1)) {
    const digits = partName.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(digits)) return false;
    const code = Number.parseInt(digits, 16);
    if (code === 0x2f || code === 0x5c) return false;
    const unreserved =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x2d ||
      code === 0x2e ||
      code === 0x5f ||
      code === 0x7e;
    if (unreserved) return false;
  }
  return true;
}

/** `java.net.URI.normalize` of "/" + target: drops "." and empty segments, applies "..", and keeps a trailing slash. */
function resolveFromRoot(target: string): string {
  const segments = target.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && resolved.length > 0 && resolved[resolved.length - 1] !== "..") resolved.pop();
    else resolved.push(segment);
  }
  const last = segments[segments.length - 1];
  const directory = last === "" || last === "." || last === "..";
  return `/${resolved.join("/")}${directory && resolved.length > 0 ? "/" : ""}`;
}
