import { metadataKeyDefinition } from "./generated/metadata-schema.ts";
import type { Metadata } from "./metadata.ts";
import type { ParseRecord } from "./recursive.ts";

export interface RmetaOptions {
  /** Coerce values using the upstream metadata schema value types. */
  readonly typedMetadata?: boolean;
  /** "records" (rmeta array) or "document" (first record only). */
  readonly jsonShape?: "records" | "document";
  readonly includeContent?: boolean;
}

type RmetaValue = string | number | boolean | readonly (string | number | boolean)[];

/**
 * Serializes parse records into the recursive-metadata JSON shape used by
 * Ripstream. Metadata values are arrays unless typedMetadata collapses singletons.
 */
export function serializeRmeta(
  records: readonly ParseRecord[],
  options: RmetaOptions = {},
): string {
  const shape = options.jsonShape ?? "records";
  const objects = records.map((record) => rmetaObject(record, options));
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

  for (const name of record.metadata.names()) {
    const values = record.metadata.getAll(name);
    if (values.length === 0) continue;
    if (typed) {
      result[name] = typedValue(name, values);
    } else {
      result[name] = [...values];
    }
  }

  result["X-TIKA:embedded_resource_path"] = [record.embeddedResourcePath];
  result["X-TIKA:embedded_depth"] = [String(record.depth)];
  if (includeContent) result["X-TIKA:content"] = record.content;
  if (record.exception !== null) {
    const name =
      record.exception instanceof Error
        ? record.exception.name
        : "Error";
    result[`X-TIKA:EXCEPTION:${name}`] = [record.exception.message];
  }
  return result;
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
    "X-TIKA:parse_time_millis",
    String(Math.max(0, Math.round(performance.now() - startedAt))),
  );
}
