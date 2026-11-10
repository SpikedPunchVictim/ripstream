/**
 * The metadata keys the framework itself writes, under Tika 4.x's names (`TikaCoreProperties`). Tika 4.0 moved every
 * key it asserts about a parse from `X-TIKA:` to the `tk:` namespace, kebab-cased, and `resourceName` to
 * `tk:resource-name`; the table is tika-core's metadata-migration-3x-4x.json.
 */
export const TIKA_KEYS = {
  CONTENT: "tk:content",
  CONTENT_HANDLER_TYPE: "tk:content-handler-type",
  CONTENT_TYPE_MAGIC_DETECTED: "tk:content-type-magic-detected",
  CONTENT_TYPE_PARSER_OVERRIDE: "tk:content-type-parser-override",
  PARSE_TIME_MILLIS: "tk:parse-time-millis",
  PARSED_BY: "tk:parsed-by",
  PARSED_BY_FULL_SET: "tk:parsed-by-full-set",
  RESOURCE_NAME: "tk:resource-name",
  EMBEDDED_DEPTH: "tk:embedded-depth",
  EMBEDDED_ID: "tk:embedded-id",
  EMBEDDED_ID_PATH: "tk:embedded-id-path",
  EMBEDDED_RESOURCE_PATH: "tk:embedded-resource-path",
  FINAL_EMBEDDED_RESOURCE_PATH: "tk:final-embedded-resource-path",
  CONTAINER_EXCEPTION: "tk:exception:container-exception",
  EMBEDDED_EXCEPTION: "tk:exception:embedded-exception",
  EMBEDDED_PARSER: "tk:exception:embedded-parser",
  EMBEDDED_STREAM_EXCEPTION: "tk:exception:embedded-stream-exception",
  WRITE_LIMIT_REACHED: "tk:exception:write-limit-reached",
  IS_ENCRYPTED: "tk:encrypted",
} as const;

/** `tk:content-handler-type` for text output (Tika's BasicContentHandlerFactory.HANDLER_TYPE enum name). */
export const TEXT_HANDLER_TYPE = "TEXT";

/** The standard HTTP header name Tika also uses for the size of the input. */
export const CONTENT_LENGTH = "Content-Length";
