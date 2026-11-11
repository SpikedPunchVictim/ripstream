import { MediaType, ParserDeclinedError, type Metadata } from "@spikedpunch/ripstream-core";

/**
 * Lets a parser that claims one version of a type, such as `image/vnd.dgn; version=8`, refuse the others.
 *
 * Tika picks parsers by the full media type, so a claim of `image/vnd.dgn; version=8` is never offered a version 7
 * file. CompositeParser here keys a claim and a requested type by the type without parameters, so it also offers this
 * parser `image/vnd.dgn; version=7` and a bare `image/vnd.dgn`. The parser then declines, and CompositeParser moves to
 * the next candidate. With no Content-Type in the metadata nothing was selected by type, and the parser goes ahead.
 */
export function declineUnlessVersion(
  metadata: Metadata,
  baseType: string,
  parameters: readonly string[],
  versions: readonly string[],
): void {
  const raw = metadata.get("Content-Type");
  if (raw === null) return;
  const type = MediaType.parse(raw);
  if (type?.getBaseType().toString() === baseType) {
    for (const name of parameters) {
      const version = type.parameters.get(name);
      if (version !== undefined && versions.includes(version)) return;
    }
  }
  throw new ParserDeclinedError(`${raw} is not ${baseType} version ${versions.join(" or ")}`);
}
