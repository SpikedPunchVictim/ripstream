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
  DETECTED_LANGUAGE: "tk:detected-language",
  DETECTED_LANGUAGE_CONFIDENCE: "tk:detected-language-confidence",
  DETECTED_LANGUAGE_CONFIDENCE_RAW: "tk:detected-language-confidence-raw",
  PARSE_TIME_MILLIS: "tk:parse-time-millis",
  PARSED_BY: "tk:parsed-by",
  PARSED_BY_FULL_SET: "tk:parsed-by-full-set",
  RESOURCE_NAME: "tk:resource-name",
  EMBEDDED_DEPTH: "tk:embedded-depth",
  EMBEDDED_ID: "tk:embedded-id",
  EMBEDDED_ID_PATH: "tk:embedded-id-path",
  EMBEDDED_RESOURCE_PATH: "tk:embedded-resource-path",
  EMBEDDED_RESOURCE_TYPE: "tk:embedded-resource-type",
  FINAL_EMBEDDED_RESOURCE_PATH: "tk:final-embedded-resource-path",
  CONTAINER_EXCEPTION: "tk:exception:container-exception",
  EMBEDDED_EXCEPTION: "tk:exception:embedded-exception",
  EMBEDDED_PARSER: "tk:exception:embedded-parser",
  EMBEDDED_STREAM_EXCEPTION: "tk:exception:embedded-stream-exception",
  WRITE_LIMIT_REACHED: "tk:exception:write-limit-reached",
  /**
   * Tika's `TikaCoreProperties.EMBEDDED_RESOURCE_LIMIT_REACHED`. Ripstream sets it under `onEmbeddedLimit: "truncate"`,
   * on the document whose embedded resources or archive entries were cut off, with the four keys below beside it.
   */
  EMBEDDED_RESOURCE_LIMIT_REACHED: "tk:exception:embedded-resource-limit-reached",
  /** Ripstream's own, beside the flag: which limit it was ("maxEmbeddedResources" or "maxZipEntries"). */
  EMBEDDED_RESOURCE_LIMIT: "tk:exception:embedded-resource-limit",
  /** The limit's value. */
  EMBEDDED_RESOURCE_LIMIT_MAX: "tk:exception:embedded-resource-limit-max",
  /** Resources or entries the parse had come across when it stopped (at least this many exist). */
  EMBEDDED_RESOURCE_LIMIT_SEEN: "tk:exception:embedded-resource-limit-seen",
  /** Resources or entries that were read, in archive order. */
  EMBEDDED_RESOURCE_LIMIT_READ: "tk:exception:embedded-resource-limit-read",
  /**
   * Ripstream's own. Set on a record whose segments could not all be located as asked, within the allowance for
   * locations (docs/segments.md): "ptr" for a JSON document, whose segments are then its lines, "selector" for HTML, whose
   * blocks are then located by paragraph, "cell" for a csv read as text, whose segments are then its lines.
   */
  SEGMENTS_DEGRADED: "tk:segments-degraded",
  IS_ENCRYPTED: "tk:encrypted",
  /** Ripstream's own: the release that wrote the result. */
  EXTRACTOR_VERSION: "tk:extractor-version",
} as const;

/** The values of `tk:embedded-resource-type` (`TikaCoreProperties.EmbeddedResourceType`), in Tika's order. */
export const EMBEDDED_RESOURCE_TYPES = [
  "INLINE",
  "ATTACHMENT",
  "MACRO",
  "METADATA",
  "FONT",
  "THUMBNAIL",
  "RENDERING",
  "VERSION",
  "ALTERNATE_FORMAT_CHUNK",
] as const;

/** `tk:content-handler-type` for text output (Tika's BasicContentHandlerFactory.HANDLER_TYPE enum name). */
export const TEXT_HANDLER_TYPE = "TEXT";

/** The standard HTTP header name Tika also uses for the size of the input. */
export const CONTENT_LENGTH = "Content-Length";
