/*
 * The GCS components of a Tika configuration (tika-pipes-gcs 4.2.0: GCSFetcherConfig, GCSEmitterConfig,
 * GCSPipesIteratorConfig), read the way pipes-s3-config.ts reads the S3 ones (tikajs-68os.31): what ripstream applies is
 * applied, what changes nothing is accepted and said so, and the rest is refused by name. Tika reads these with a strict
 * mapper, so a key none of the three classes has is refused here too. The pipes package builds the components.
 */

/** What reaches a bucket: Tika's project id and bucket, validated. Credentials are Google's application default credentials. */
export interface GcsConnectionSettings {
  readonly projectId: string;
  readonly bucket: string;
}

export interface GcsFetcherSettings {
  readonly id: string;
  readonly type: "gcs-fetcher";
  readonly gcs: GcsConnectionSettings;
}

export interface GcsEmitterSettings {
  readonly id: string;
  readonly type: "gcs-emitter";
  readonly gcs: GcsConnectionSettings;
  /** Put before every key with a `/`; one trailing `/` is dropped. */
  readonly prefix?: string;
  /** Added to every key after a dot. Tika's default is `json`; a blank value is none. Absent here means none. */
  readonly fileExtension?: string;
}

export interface GcsIteratorSettings {
  readonly type: "gcs-pipes-iterator";
  readonly gcs: GcsConnectionSettings;
  readonly prefix?: string;
  readonly fetcherId: string;
  readonly emitterId: string;
}

export interface GcsParseContext {
  readonly at: string;
  readonly issues: string[];
  readonly notices: string[];
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !value.includes("\u0000");

const CONNECTION_KEYS = ["projectId", "bucket"] as const;

function unknownKeys(config: Record<string, unknown>, own: readonly string[], at: string, issues: string[]): void {
  const known = [...CONNECTION_KEYS, ...own];
  for (const key of Object.keys(config)) {
    if (!known.includes(key)) issues.push(`${at}.${key} is not a setting ripstream has (it reads ${known.join(", ")})`);
  }
}

function optionalText(config: Record<string, unknown>, key: string, at: string, issues: string[]): string | undefined {
  const value = config[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.includes("\u0000")) {
    issues.push(`${at}.${key} must be a string without a NUL byte`);
    return undefined;
  }
  return value;
}

/** The settings every GCS component has. Tika refuses a blank bucket or projectId when it builds the component. */
function parseConnection(config: Record<string, unknown>, context: GcsParseContext): GcsConnectionSettings | undefined {
  const { at, issues, notices } = context;
  const before = issues.length;
  if (!text(config.bucket)) issues.push(`${at}.bucket is required and must be a non-empty string`);
  if (!text(config.projectId)) issues.push(`${at}.projectId is required and must be a non-empty string`);
  else notices.push(`${at}.projectId is required by Tika, which gives it to Google's client; ripstream's requests are for the bucket by name, which does not use it`);
  if (issues.length > before) return undefined;
  return { projectId: (config.projectId as string).trim(), bucket: (config.bucket as string).trim() };
}

export function parseGcsFetcher(id: string, config: Record<string, unknown>, context: GcsParseContext): GcsFetcherSettings | undefined {
  const { at, issues, notices } = context;
  const before = issues.length;
  unknownKeys(config, ["spoolToTemp", "extractUserMetadata"], at, issues);
  for (const key of ["spoolToTemp", "extractUserMetadata"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") issues.push(`${at}.${key} must be a boolean`);
  }
  if (config.spoolToTemp === false) notices.push(`${at}.spoolToTemp false streams the object into the parse; ripstream holds a fetched document's bytes in memory, so it changes nothing`);
  // Tika's default is true, so a setting that is absent is the same as true.
  if (config.extractUserMetadata !== false) {
    notices.push(`${at}.extractUserMetadata (true unless set) adds the object's user metadata as gcs:* fields; ripstream's fetchers return bytes only, so no field is added`);
  }
  const gcs = parseConnection(config, context);
  if (gcs === undefined || issues.length > before) return undefined;
  return { id, type: "gcs-fetcher", gcs };
}

export function parseGcsEmitter(id: string, config: Record<string, unknown>, context: GcsParseContext): GcsEmitterSettings | undefined {
  const { at, issues } = context;
  const before = issues.length;
  unknownKeys(config, ["prefix", "fileExtension"], at, issues);
  const prefix = optionalText(config, "prefix", at, issues);
  const extension = optionalText(config, "fileExtension", at, issues);
  const gcs = parseConnection(config, context);
  if (gcs === undefined || issues.length > before) return undefined;
  // Tika: `json` unless set, and a blank one is none; a leading slash on the prefix is the operator's.
  const fileExtension = extension === undefined ? "json" : extension.trim();
  const normalized = prefix === undefined ? undefined : prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return {
    id,
    type: "gcs-emitter",
    gcs,
    ...(normalized === undefined || normalized.trim() === "" ? {} : { prefix: normalized }),
    ...(fileExtension === "" ? {} : { fileExtension }),
  };
}

export function parseGcsIterator(config: Record<string, unknown>, context: GcsParseContext): GcsIteratorSettings | undefined {
  const { at, issues } = context;
  const before = issues.length;
  unknownKeys(config, ["prefix", "fetcherId", "emitterId"], at, issues);
  for (const key of ["fetcherId", "emitterId"] as const) {
    if (!text(config[key])) issues.push(`${at}.${key} is required and must be a non-empty string`);
  }
  const prefix = optionalText(config, "prefix", at, issues);
  const gcs = parseConnection(config, context);
  if (gcs === undefined || issues.length > before) return undefined;
  return {
    type: "gcs-pipes-iterator",
    gcs,
    ...(prefix === undefined || prefix.trim() === "" ? {} : { prefix }),
    fetcherId: config.fetcherId as string,
    emitterId: config.emitterId as string,
  };
}
