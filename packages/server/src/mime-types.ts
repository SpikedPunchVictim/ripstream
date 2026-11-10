/**
 * What `GET /mime-types` and `GET /mime-types/{type}/{subtype}` answer, by Tika's `TikaMimeTypes` resource: the media
 * types the server knows, as HTML (the default), JSON or, for the list, plain text.
 */

/** One media type the server describes. The server takes these from its caller: it has no registry of its own. */
export interface ServerMimeType {
  /** `text/plain`. */
  readonly type: string;
  /** Other names for the type (`application/x-gzip` for `application/gzip`). */
  readonly aliases?: readonly string[];
  /** The type this one is a kind of (`text/plain` for `text/x-java-source`). */
  readonly supertype?: string;
  readonly description?: string;
  /** File extensions, with the dot, the default one first. */
  readonly extensions?: readonly string[];
  /** The parser that reads the type, by name. */
  readonly parser?: string;
}

/** What the list can be answered as, the default first. */
export const MIME_LIST_OFFERS = ["text/html", "application/json", "text/plain"] as const;
/** What one type can be answered as, the default first. */
export const MIME_DETAIL_OFFERS = ["text/html", "application/json"] as const;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The types in order by name, which is the order every list is written in. */
export function sortMimeTypes(types: readonly ServerMimeType[]): ServerMimeType[] {
  return [...types].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

/** The type a path names (`text`, `plain`), found as Tika finds it: by its normalized, lower-case name. */
export function findMimeType(types: readonly ServerMimeType[], type: string, subtype: string): ServerMimeType | undefined {
  const wanted = `${type}/${subtype}`.toLowerCase();
  return types.find((candidate) => candidate.type.toLowerCase() === wanted);
}

const page = (title: string, body: string): string =>
  `<!DOCTYPE html>\n<html><head><title>${escapeHtml(title)}</title></head><body>\n<h1>${escapeHtml(title)}</h1>\n${body}</body></html>\n`;

export function mimeTypesJson(types: readonly ServerMimeType[]): string {
  const document: Record<string, Record<string, unknown>> = {};
  for (const type of types) {
    document[type.type] = {
      alias: type.aliases ?? [],
      ...(type.supertype === undefined ? {} : { supertype: type.supertype }),
      ...(type.parser === undefined ? {} : { parser: type.parser }),
    };
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function mimeTypesText(types: readonly ServerMimeType[]): string {
  let text = "";
  for (const type of types) {
    text += `${type.type}\n`;
    for (const alias of type.aliases ?? []) text += `  alias:     ${alias}\n`;
    if (type.supertype !== undefined) text += `  supertype: ${type.supertype}\n`;
    if (type.parser !== undefined) text += `  parser:    ${type.parser}\n`;
  }
  return text;
}

export function mimeTypesHtml(types: readonly ServerMimeType[]): string {
  // One link to the first type of each section (`application`, `text`, ...).
  const firstOfSection = new Map<string, string>();
  for (const { type } of types) {
    const section = type.split("/")[0] ?? type;
    if (!firstOfSection.has(section)) firstOfSection.set(section, type);
  }
  let body = "<ul>\n";
  for (const [section, first] of firstOfSection) body += `<li><a href="#${escapeHtml(first)}">${escapeHtml(section)}</a></li>\n`;
  body += "</ul>\n";
  for (const type of types) {
    body += `<a name="${escapeHtml(type.type)}"></a>\n<h2><a href="/mime-types/${escapeHtml(type.type)}">${escapeHtml(type.type)}</a></h2>\n`;
    body += detailLines(type);
  }
  return page("Ripstream Supported Media Types", body);
}

export function mimeTypeDetailJson(type: ServerMimeType): string {
  const [defaultExtension] = type.extensions ?? [];
  const document = {
    type: type.type,
    alias: type.aliases ?? [],
    ...(type.supertype === undefined ? {} : { supertype: type.supertype }),
    ...(type.parser === undefined ? {} : { parser: type.parser }),
    ...(type.description === undefined || type.description === "" ? {} : { description: type.description }),
    ...(defaultExtension === undefined ? {} : { defaultExtension }),
    ...(type.extensions === undefined || type.extensions.length === 0 ? {} : { extensions: type.extensions }),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function mimeTypeDetailHtml(type: ServerMimeType): string {
  return page(`Details on Media Type ${type.type}`, `<h2>${escapeHtml(type.type)}</h2>\n${detailLines(type)}`);
}

function detailLines(type: ServerMimeType): string {
  const line = (label: string, value: string): string => `<div>${label}: ${escapeHtml(value)}</div>\n`;
  let lines = "";
  for (const alias of type.aliases ?? []) lines += line("Alias", alias);
  if (type.supertype !== undefined) {
    lines += `<div>Super Type: <a href="#${escapeHtml(type.supertype)}">${escapeHtml(type.supertype)}</a></div>\n`;
  }
  if (type.description !== undefined && type.description !== "") lines += line("Description", type.description);
  const [defaultExtension, ...others] = type.extensions ?? [];
  if (defaultExtension !== undefined) lines += line("Default Extension", defaultExtension);
  for (const extension of [defaultExtension, ...others]) if (extension !== undefined) lines += line("Extension", extension);
  if (type.parser !== undefined) lines += line("Parser", type.parser);
  return lines;
}
