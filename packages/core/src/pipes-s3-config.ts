/*
 * The S3 components of a Tika configuration (tika-pipes-s3 4.2.0: S3FetcherConfig, S3EmitterConfig, S3PipesIteratorConfig),
 * read the way pipes-config.ts reads the file-system ones (tikajs-68os.6.6): what ripstream applies is applied, what changes
 * nothing is accepted and said so, and the rest is refused by name with the reason. The three share their connection
 * settings; each adds its own.
 */

export const S3_CREDENTIAL_PROVIDERS = ["instance", "profile", "key_secret"] as const;

/** What reaches a bucket: Tika's region, bucket, credentials and endpoint settings, validated. */
export interface S3ConnectionSettings {
  readonly region: string;
  readonly bucket: string;
  readonly credentialsProvider: (typeof S3_CREDENTIAL_PROVIDERS)[number];
  readonly profile?: string;
  readonly accessKey?: string;
  readonly secretKey?: string;
  /** Tika's `endpointConfigurationService`: S3-compatible storage at another URL. Absent: AWS. */
  readonly endpoint?: string;
  /** Tika's `pathStyleAccessEnabled`. */
  readonly pathStyle: boolean;
}

export interface S3FetcherSettings {
  readonly id: string;
  readonly type: "s3-fetcher";
  readonly s3: S3ConnectionSettings;
  /** Put in front of every fetch key, as it is (Tika adds no slash). */
  readonly prefix?: string;
  /** An object longer than this is refused before it is read. Absent: no limit. */
  readonly maxLength?: number;
}

export interface S3EmitterSettings {
  readonly id: string;
  readonly type: "s3-emitter";
  readonly s3: S3ConnectionSettings;
  /** Put before every key with a `/`; one trailing `/` is dropped. */
  readonly prefix?: string;
  /** Added to every key after a dot. Tika's default is `json`; a blank value is none. Absent here means none. */
  readonly fileExtension?: string;
}

export interface S3IteratorSettings {
  readonly type: "s3-pipes-iterator";
  readonly s3: S3ConnectionSettings;
  readonly prefix?: string;
  /** A key is listed when this matches (anywhere in) its file name. Tika's `fileNamePattern`. */
  readonly fileNamePattern?: string;
  readonly fetcherId: string;
  readonly emitterId: string;
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !value.includes("\u0000");

const CONNECTION_KEYS = [
  "region",
  "bucket",
  "credentialsProvider",
  "profile",
  "accessKey",
  "secretKey",
  "endpointConfigurationService",
  "pathStyleAccessEnabled",
  "maxConnections",
] as const;

export interface S3ParseContext {
  readonly at: string;
  readonly issues: string[];
  readonly notices: string[];
  /** The fetcher and the iterator default to `instance`, as Tika's do; the emitter's validate() insists the setting is given. */
  readonly providerRequired: boolean;
}

/** The keys every S3 component has, and the reasons for the ones that are refused. Returns undefined when there are issues. */
export function parseS3Connection(config: Record<string, unknown>, context: S3ParseContext): S3ConnectionSettings | undefined {
  const { at, issues, notices } = context;
  const before = issues.length;
  const region = config.region;
  const bucket = config.bucket;
  if (!text(bucket)) issues.push(`${at}.bucket is required and must be a non-empty string`);
  if (!text(region)) issues.push(`${at}.region is required and must be a non-empty string`);

  const given = config.credentialsProvider;
  let credentialsProvider: S3ConnectionSettings["credentialsProvider"] = "instance";
  if (given === undefined || given === null) {
    if (context.providerRequired) issues.push(`${at}.credentialsProvider must be set to 'profile', 'instance' or 'key_secret'`);
  } else if (typeof given === "string" && (S3_CREDENTIAL_PROVIDERS as readonly string[]).includes(given)) {
    credentialsProvider = given as S3ConnectionSettings["credentialsProvider"];
  } else {
    issues.push(`${at}.credentialsProvider must be 'profile', 'instance' or 'key_secret'`);
  }

  const profile = config.profile;
  if (credentialsProvider === "profile" && !text(profile)) issues.push(`${at}.profile must be set when credentialsProvider is 'profile'`);
  const accessKey = config.accessKey;
  const secretKey = config.secretKey;
  if (credentialsProvider === "key_secret") {
    if (!text(accessKey)) issues.push(`${at}.accessKey must be set when credentialsProvider is 'key_secret'`);
    if (!text(secretKey)) issues.push(`${at}.secretKey must be set when credentialsProvider is 'key_secret'`);
  }
  if (profile !== undefined && profile !== null && typeof profile !== "string") issues.push(`${at}.profile must be a string`);
  if (accessKey !== undefined && accessKey !== null && typeof accessKey !== "string") issues.push(`${at}.accessKey must be a string`);
  if (secretKey !== undefined && secretKey !== null && typeof secretKey !== "string") issues.push(`${at}.secretKey must be a string`);

  let endpoint: string | undefined;
  const service = config.endpointConfigurationService;
  if (service !== undefined && service !== null && !(typeof service === "string" && service.trim() === "")) {
    try {
      if (typeof service !== "string") throw new Error("not a string");
      const url = new URL(service);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http(s)");
      endpoint = service;
    } catch {
      issues.push(`${at}.endpointConfigurationService must be an http or https URL`);
    }
  }
  const pathStyle = config.pathStyleAccessEnabled;
  if (pathStyle !== undefined && typeof pathStyle !== "boolean") issues.push(`${at}.pathStyleAccessEnabled must be a boolean`);
  const connections = config.maxConnections;
  if (connections !== undefined && connections !== null) {
    if (typeof connections !== "number" || !Number.isSafeInteger(connections)) issues.push(`${at}.maxConnections must be an integer`);
    else notices.push(`${at}.maxConnections sizes the AWS SDK's connection pool; ripstream sends with fetch, so it changes nothing`);
  }

  if (issues.length > before) return undefined;
  return {
    region: (region as string).trim(),
    bucket: (bucket as string).trim(),
    credentialsProvider,
    ...(credentialsProvider === "profile" ? { profile: (profile as string).trim() } : {}),
    ...(credentialsProvider === "key_secret" ? { accessKey: accessKey as string, secretKey: secretKey as string } : {}),
    ...(endpoint === undefined ? {} : { endpoint }),
    pathStyle: pathStyle === true,
  };
}

/** `unknownKeys` for an S3 component: its own keys and the connection's; a refused key says why. */
export function unknownS3Keys(config: Record<string, unknown>, own: readonly string[], at: string, reasons: Readonly<Record<string, string>>, issues: string[]): void {
  const known = [...CONNECTION_KEYS, ...own];
  for (const key of Object.keys(config)) {
    if (known.includes(key)) continue;
    issues.push(`${at}.${key} ${reasons[key] ?? `is not a setting ripstream has (it reads ${known.join(", ")})`}`);
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

export function parseS3Fetcher(id: string, config: Record<string, unknown>, context: Omit<S3ParseContext, "providerRequired">): S3FetcherSettings | undefined {
  const { at, issues, notices } = context;
  const before = issues.length;
  unknownS3Keys(
    config,
    ["prefix", "maxLength", "spoolToTemp", "extractUserMetadata", "throttleSeconds"],
    at,
    {},
    issues,
  );
  const throttle = config.throttleSeconds;
  if (throttle !== undefined && throttle !== null) {
    issues.push(`${at}.throttleSeconds sleeps between Tika's own retries of a fetch; give the run retry attempts instead (ripstream pipes --retry-attempts), which retries any component's transient failure`);
  }
  for (const key of ["spoolToTemp", "extractUserMetadata"] as const) {
    const value = config[key];
    if (value !== undefined && typeof value !== "boolean") issues.push(`${at}.${key} must be a boolean`);
  }
  if (config.spoolToTemp === false) notices.push(`${at}.spoolToTemp false streams the object into the parse; ripstream holds a fetched document's bytes in memory, so it changes nothing`);
  if (config.extractUserMetadata === true) {
    notices.push(`${at}.extractUserMetadata asks for the object's user metadata as s3:* fields; ripstream's fetchers return bytes only, so no field is added`);
  }
  const maxLength = config.maxLength;
  if (maxLength !== undefined && maxLength !== null && (typeof maxLength !== "number" || !Number.isSafeInteger(maxLength) || maxLength < -1)) {
    issues.push(`${at}.maxLength must be an integer, -1 (no limit) or more`);
  }
  const prefix = optionalText(config, "prefix", at, issues);
  const s3 = parseS3Connection(config, { ...context, providerRequired: false });
  if (s3 === undefined || issues.length > before) return undefined;
  return {
    id,
    type: "s3-fetcher",
    s3,
    ...(prefix === undefined || prefix.trim() === "" ? {} : { prefix }),
    ...(typeof maxLength === "number" && maxLength > -1 ? { maxLength } : {}),
  };
}

export function parseS3Emitter(id: string, config: Record<string, unknown>, context: Omit<S3ParseContext, "providerRequired">): S3EmitterSettings | undefined {
  const { at, issues, notices } = context;
  const before = issues.length;
  unknownS3Keys(config, ["prefix", "fileExtension", "spoolToTemp"], at, {}, issues);
  if (config.spoolToTemp !== undefined && typeof config.spoolToTemp !== "boolean") issues.push(`${at}.spoolToTemp must be a boolean`);
  if (config.spoolToTemp === false) notices.push(`${at}.spoolToTemp false builds the body in memory instead of a temporary file; ripstream always does, so it changes nothing`);
  const prefix = optionalText(config, "prefix", at, issues);
  const extension = optionalText(config, "fileExtension", at, issues);
  const s3 = parseS3Connection(config, { ...context, providerRequired: true });
  if (s3 === undefined || issues.length > before) return undefined;
  // Tika: `json` unless set, and a blank one is none; a leading slash on the prefix is the operator's.
  const fileExtension = extension === undefined ? "json" : extension.trim();
  const normalized = prefix === undefined ? undefined : prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return {
    id,
    type: "s3-emitter",
    s3,
    ...(normalized === undefined || normalized.trim() === "" ? {} : { prefix: normalized }),
    ...(fileExtension === "" ? {} : { fileExtension }),
  };
}

export function parseS3Iterator(config: Record<string, unknown>, context: Omit<S3ParseContext, "providerRequired">): S3IteratorSettings | undefined {
  const { at, issues, notices } = context;
  const before = issues.length;
  unknownS3Keys(config, ["prefix", "fileNamePattern", "countTotal", "fetcherId", "emitterId"], at, {}, issues);
  if (config.countTotal !== undefined) {
    if (typeof config.countTotal !== "boolean") issues.push(`${at}.countTotal must be a boolean`);
    else if (config.countTotal) notices.push(`${at}.countTotal asks for the total ahead of the run; ripstream does not count ahead, so it changes nothing`);
  }
  for (const key of ["fetcherId", "emitterId"] as const) {
    if (!text(config[key])) issues.push(`${at}.${key} is required and must be a non-empty string`);
  }
  const prefix = optionalText(config, "prefix", at, issues);
  const pattern = optionalText(config, "fileNamePattern", at, issues);
  if (pattern !== undefined && pattern.trim() !== "") {
    try {
      new RegExp(pattern);
    } catch {
      issues.push(`${at}.fileNamePattern is not a regular expression ripstream can read`);
    }
  }
  const s3 = parseS3Connection(config, { ...context, providerRequired: false });
  if (s3 === undefined || issues.length > before) return undefined;
  return {
    type: "s3-pipes-iterator",
    s3,
    ...(prefix === undefined || prefix === "" ? {} : { prefix }),
    ...(pattern === undefined || pattern.trim() === "" ? {} : { fileNamePattern: pattern }),
    fetcherId: config.fetcherId as string,
    emitterId: config.emitterId as string,
  };
}
