import { metadataKeyDefinition } from "./generated/metadata-schema.ts";
import type { Metadata } from "./metadata.ts";
import type { ParseRecord } from "./recursive.ts";
import { handlerTypeName } from "./handler-type.ts";
import { TIKA_KEYS } from "./tika-keys.ts";

export interface RmetaOptions {
  /** Coerce values using the upstream metadata schema value types. */
  readonly typedMetadata?: boolean;
  /** "records" (rmeta array) or "document" (first record only). */
  readonly jsonShape?: "records" | "document";
  readonly includeContent?: boolean;
}

export type RmetaValue = string | number | boolean | readonly (string | number | boolean)[];

/**
 * Serializes parse records into the recursive-metadata JSON shape of Tika's /rmeta: one object per document, the
 * container first. A key with one value is a string; a key with several is an array (Tika's MetadataSerializer).
 * typedMetadata additionally turns integers, reals and booleans into JSON numbers and booleans.
 */
export function serializeRmeta(
  records: readonly ParseRecord[],
  options: RmetaOptions = {},
): string {
  const shape = options.jsonShape ?? "records";
  const objects = rmetaObjects(records, options);
  if (shape === "document") {
    return JSON.stringify(objects[0] ?? {});
  }
  return JSON.stringify(objects);
}

export function rmetaObject(
  record: ParseRecord,
  options: RmetaOptions = {},
): Record<string, RmetaValue> {
  const includeContent = options.includeContent ?? true;
  const typed = options.typedMetadata ?? false;
  const result: Record<string, RmetaValue> = {};

  Object.assign(result, metadataJson(record.metadata, { typedMetadata: typed }));

  result[TIKA_KEYS.EMBEDDED_DEPTH] ??= String(record.depth);
  // A failure the wrapper did not note on the metadata (a record built by hand) is noted here, as Tika's container
  // and embedded keys.
  const failureKey = record.depth === 0 ? TIKA_KEYS.CONTAINER_EXCEPTION : TIKA_KEYS.EMBEDDED_EXCEPTION;
  if (record.exception !== null && result[failureKey] === undefined) {
    result[failureKey] = `${record.exception.name}: ${record.exception.message}`;
  }
  // Tika adds content only when it is not blank, with the handler that made it.
  if (includeContent && record.content.trim() !== "") {
    result[TIKA_KEYS.CONTENT] = record.content;
    result[TIKA_KEYS.CONTENT_HANDLER_TYPE] = handlerTypeName(record.handlerType ?? "text");
  }
  return result;
}

/** One document's metadata as Tika writes it: a key with one value is a string, a key with several is an array. */
export function metadataJson(
  metadata: Metadata,
  options: Pick<RmetaOptions, "typedMetadata"> = {},
): Record<string, RmetaValue> {
  const result: Record<string, RmetaValue> = {};
  for (const name of metadata.names()) {
    const values = metadata.getAll(name);
    if (values.length === 0) continue;
    result[name] = options.typedMetadata === true ? typedValue(name, values) : values.length === 1 ? values[0]! : [...values];
  }
  return result;
}

/**
 * The record objects of one parse, with the two keys that need the whole list: the container's
 * `tk:parsed-by-full-set` (every parser that ran anywhere in the file) and each embedded document's
 * `tk:final-embedded-resource-path` (its path by names, worked out once every name is known).
 */
export function rmetaObjects(
  records: readonly ParseRecord[],
  options: RmetaOptions = {},
): Record<string, RmetaValue>[] {
  const objects = records.map((record) => rmetaObject(record, options));
  const nameOfId = new Map<string, string>();
  let unknown = 0;
  for (const record of records) {
    const id = record.metadata.get(TIKA_KEYS.EMBEDDED_ID);
    if (id === null) continue;
    const name = record.metadata.get(TIKA_KEYS.RESOURCE_NAME) ?? `embedded-${++unknown}`;
    nameOfId.set(id, name.slice(name.lastIndexOf("/") + 1));
  }
  const parsedBy = new Set<string>();
  records.forEach((record, index) => {
    for (const parser of record.metadata.getAll(TIKA_KEYS.PARSED_BY)) parsedBy.add(parser);
    const idPath = record.metadata.get(TIKA_KEYS.EMBEDDED_ID_PATH);
    if (idPath === null) return;
    const names = idPath.split("/").filter((id) => id !== "").map((id) => nameOfId.get(id) ?? id);
    objects[index]![TIKA_KEYS.FINAL_EMBEDDED_RESOURCE_PATH] = `/${names.join("/")}`;
  });
  const container = objects[0];
  if (container !== undefined && parsedBy.size > 0) container[TIKA_KEYS.PARSED_BY_FULL_SET] = [...parsedBy];
  return objects;
}

function typedValue(
  name: string,
  values: readonly string[],
): RmetaValue {
  const definition = metadataKeyDefinition(name);
  if (definition === undefined) {
    return values.length === 1 ? values[0]! : [...values];
  }
  const converted = values.map((value) => coerce(definition.valueType, value));
  return converted.length === 1 ? converted[0]! : converted;
}

function coerce(
  type: string,
  value: string,
): string | number | boolean {
  if (type === "INTEGER") {
    const number = Number(value);
    return Number.isInteger(number) ? number : value;
  }
  if (type === "REAL" || type === "RATIONAL") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (type === "BOOLEAN") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return value;
}

/** Adds standard timing fields to a record's metadata. */
export function markParseTiming(metadata: Metadata, startedAt: number): void {
  metadata.set(
    TIKA_KEYS.PARSE_TIME_MILLIS,
    String(Math.max(0, Math.round(performance.now() - startedAt))),
  );
}
