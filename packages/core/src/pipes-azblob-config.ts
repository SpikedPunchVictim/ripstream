/*
 * The Azure Blob components of a Tika configuration (tika-pipes-az-blob 4.2.0: AZBlobFetcherConfig, AZBlobEmitterConfig,
 * AZBlobPipesIteratorConfig), read the way pipes-s3-config.ts reads the S3 ones (tikajs-68os.32): what ripstream applies
 * is applied, what changes nothing is accepted and said so, and the rest is refused by name. Tika reads these with a
 * strict mapper, so a key none of the three classes has is refused here too. The pipes package builds the components.
 */

/** What reaches a container: the account's endpoint, the container, and the SAS token that authorises the requests. */
export interface AzBlobConnectionSettings {
  readonly endpoint: string;
  readonly container: string;
  readonly sasToken: string;
}

export interface AzBlobFetcherSettings {
  readonly id: string;
  readonly type: "az-blob-fetcher";
  readonly azure: AzBlobConnectionSettings;
}

export interface AzBlobEmitterSettings {
  readonly id: string;
  readonly type: "az-blob-emitter";
  readonly azure: AzBlobConnectionSettings;
  /** Put before every key with a `/`; one trailing `/` is dropped. */
  readonly prefix?: string;
  /** Added to every key after a dot. Tika's default is `json`; a blank value is none. Absent here means none. */
  readonly fileExtension?: string;
  /** Tika's default is false, which refuses to replace a blob. Absent here means false. */
  readonly overwriteExisting?: boolean;
}

export interface AzBlobIteratorSettings {
  readonly type: "az-blob-pipes-iterator";
  readonly azure: AzBlobConnectionSettings;
  readonly prefix?: string;
  /** Milliseconds each List Blobs request may take. Tika's default is 360000. Absent here means that. */
  readonly timeoutMillis?: number;
  readonly fetcherId: string;
  readonly emitterId: string;
}

export interface AzBlobParseContext {
  readonly at: string;
  readonly issues: string[];
  readonly notices: string[];
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !value.includes("\u0000");

const CONNECTION_KEYS = ["sasToken", "endpoint", "container"] as const;
const MAX_TIMER = 2147483647;

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

function optionalBoolean(config: Record<string, unknown>, key: string, at: string, issues: string[]): boolean | undefined {
  const value = config[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    issues.push(`${at}.${key} must be a boolean`);
    return undefined;
  }
  return value;
}

/** The endpoint of a Blob service: the SAS token is its own setting, so the URL has no query, and a secret does not belong in it. */
function endpointIsValid(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.search === "" && url.hash === "" && url.username === "" && url.password === "" && !value.includes("?") && !value.includes("#");
  } catch {
    return false;
  }
}

/** The settings every Azure Blob component has. A token is what comes after the `?` of a SAS URL, and the portal gives it with the `?`. */
function parseConnection(config: Record<string, unknown>, context: AzBlobParseContext): AzBlobConnectionSettings | undefined {
  const { at, issues } = context;
  const before = issues.length;
  const token = config.sasToken;
  if (!text(token) || token.trim().replace(/^\?/, "").trim() === "") issues.push(`${at}.sasToken is required and must be a non-empty string`);
  const endpoint = config.endpoint;
  if (!text(endpoint)) issues.push(`${at}.endpoint is required and must be a non-empty string`);
  else if (!endpointIsValid(endpoint.trim())) issues.push(`${at}.endpoint must be an absolute http or https URL with no query, fragment or credentials (the SAS token is the sasToken setting)`);
  if (!text(config.container)) issues.push(`${at}.container is required and must be a non-empty string`);
  if (issues.length > before) return undefined;
  return { endpoint: (endpoint as string).trim(), container: (config.container as string).trim(), sasToken: (token as string).trim() };
}

export function parseAzBlobFetcher(id: string, config: Record<string, unknown>, context: AzBlobParseContext): AzBlobFetcherSettings | undefined {
  const { at, issues, notices } = context;
  const before = issues.length;
  unknownKeys(config, ["spoolToTemp", "extractUserMetadata"], at, issues);
  optionalBoolean(config, "spoolToTemp", at, issues);
  optionalBoolean(config, "extractUserMetadata", at, issues);
  if (config.spoolToTemp === false) notices.push(`${at}.spoolToTemp false streams the blob into the parse; ripstream holds a fetched document's bytes in memory, so it changes nothing`);
  // Tika's default is true, so a setting that is absent is the same as true.
  if (config.extractUserMetadata !== false) {
    notices.push(`${at}.extractUserMetadata (true unless set) adds the blob's user metadata as az-blob:* fields; ripstream's fetchers return bytes only, so no field is added`);
  }
  if (CONNECTION_KEYS.every((key) => config[key] === undefined || config[key] === null)) {
    // Tika's fetcher then reads the fetch key itself as a connection string, a mode its own class comment calls a SAS URL.
    issues.push(`${at} has none of sasToken, endpoint and container: Tika then takes each fetch key as a connection string for one blob, which ripstream does not do; set all three and the fetch key is the blob's name`);
    return undefined;
  }
  const azure = parseConnection(config, context);
  if (azure === undefined || issues.length > before) return undefined;
  return { id, type: "az-blob-fetcher", azure };
}

export function parseAzBlobEmitter(id: string, config: Record<string, unknown>, context: AzBlobParseContext): AzBlobEmitterSettings | undefined {
  const { at, issues } = context;
  const before = issues.length;
  unknownKeys(config, ["prefix", "fileExtension", "overwriteExisting"], at, issues);
  const prefix = optionalText(config, "prefix", at, issues);
  const extension = optionalText(config, "fileExtension", at, issues);
  const overwriteExisting = optionalBoolean(config, "overwriteExisting", at, issues);
  const azure = parseConnection(config, context);
  if (azure === undefined || issues.length > before) return undefined;
  // Tika: `json` unless set, and a blank one is none; a leading slash on the prefix is the operator's.
  const fileExtension = extension === undefined ? "json" : extension.trim();
  const normalized = prefix === undefined ? undefined : prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return {
    id,
    type: "az-blob-emitter",
    azure,
    ...(normalized === undefined || normalized.trim() === "" ? {} : { prefix: normalized }),
    ...(fileExtension === "" ? {} : { fileExtension }),
    ...(overwriteExisting === true ? { overwriteExisting } : {}),
  };
}

export function parseAzBlobIterator(config: Record<string, unknown>, context: AzBlobParseContext): AzBlobIteratorSettings | undefined {
  const { at, issues } = context;
  const before = issues.length;
  unknownKeys(config, ["prefix", "timeoutMillis", "fetcherId", "emitterId"], at, issues);
  for (const key of ["fetcherId", "emitterId"] as const) {
    if (!text(config[key])) issues.push(`${at}.${key} is required and must be a non-empty string`);
  }
  const prefix = optionalText(config, "prefix", at, issues);
  const timeout = config.timeoutMillis;
  if (timeout !== undefined && timeout !== null && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMER)) {
    issues.push(`${at}.timeoutMillis must be a whole number of milliseconds from 1 to ${MAX_TIMER}`);
  }
  const azure = parseConnection(config, context);
  if (azure === undefined || issues.length > before) return undefined;
  return {
    type: "az-blob-pipes-iterator",
    azure,
    ...(prefix === undefined || prefix.trim() === "" ? {} : { prefix }),
    ...(typeof timeout === "number" ? { timeoutMillis: timeout } : {}),
    fetcherId: config.fetcherId as string,
    emitterId: config.emitterId as string,
  };
}
