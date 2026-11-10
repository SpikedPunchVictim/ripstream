/*
 * The Elasticsearch and OpenSearch emitters of a Tika configuration (tika-pipes-es and tika-pipes-opensearch 4.2.0:
 * ESEmitterConfig, OpenSearchEmitterConfig), read the way pipes-config.ts reads the file-system ones (tikajs-68os.6.6):
 * what ripstream applies is applied, what changes nothing is accepted and said so, and the rest is refused by name with the
 * reason. The two send the same `_bulk` requests; Elasticsearch's also takes an API key.
 */

export type SearchEmitterType = "es-emitter" | "opensearch-emitter";

export interface SearchEmitterSettings {
  readonly id: string;
  readonly type: SearchEmitterType;
  /** The index's URL (Tika's `esUrl` / `openSearchUrl`), without a trailing slash: `/_bulk` is added to it. */
  readonly url: string;
  /** Tika's null is neither: an embedded document is then indexed with no link to its container. */
  readonly attachmentStrategy?: "SEPARATE_DOCUMENTS" | "PARENT_CHILD";
  /** Tika's null is UPSERT, so that is the default here. */
  readonly updateStrategy: "OVERWRITE" | "UPSERT";
  /** The relation name of an embedded document under PARENT_CHILD. */
  readonly embeddedFileFieldName: string;
  /** Elasticsearch only: sent as `Authorization: ApiKey <value>`. */
  readonly apiKey?: string;
  readonly userName?: string;
  readonly password?: string;
  /** Applied as the time one request may take. Absent: no limit. */
  readonly socketTimeoutMillis?: number;
}

const URL_KEY: Readonly<Record<SearchEmitterType, string>> = { "es-emitter": "esUrl", "opensearch-emitter": "openSearchUrl" };

const HTTP_KEYS = ["userName", "password", "authScheme", "connectionTimeoutMillis", "socketTimeoutMillis", "proxyHost", "proxyPort", "verifySsl"] as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !value.includes("\u0000");

function choice<T extends string>(config: Record<string, unknown>, key: string, allowed: readonly T[], at: string, issues: string[]): T | undefined {
  const value = config[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  issues.push(`${at}.${key} must be ${allowed.slice(0, -1).join(", ")} or ${allowed[allowed.length - 1]}`);
  return undefined;
}

export interface SearchParseContext {
  readonly at: string;
  readonly issues: string[];
  readonly notices: string[];
}

export function parseSearchEmitter(id: string, type: SearchEmitterType, config: Record<string, unknown>, context: SearchParseContext): SearchEmitterSettings | undefined {
  const { at, issues, notices } = context;
  const before = issues.length;
  const urlKey = URL_KEY[type];
  const own = [urlKey, "idField", "attachmentStrategy", "updateStrategy", "commitWithin", "embeddedFileFieldName", "httpClientConfig", "chunkStrategy", ...(type === "es-emitter" ? ["apiKey"] : [])];
  for (const key of Object.keys(config)) {
    if (own.includes(key)) continue;
    issues.push(`${at}.${key} is not a setting ripstream has (it reads ${own.join(", ")})`);
  }

  const given = config[urlKey];
  let url: string | undefined;
  if (!text(given)) {
    issues.push(`${at}.${urlKey} is required and must be the index's URL`);
  } else {
    try {
      const parsed = new URL(given);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http(s)");
      if (parsed.username !== "" || parsed.password !== "") issues.push(`${at}.${urlKey} must not carry a user name or password: give them as httpClientConfig.userName and password, or as apiKey`);
      else if (parsed.search !== "" || parsed.hash !== "") issues.push(`${at}.${urlKey} must not carry a query or a fragment: it is the index's URL, and /_bulk is added to it`);
      else url = given.trim().replace(/\/+$/, "");
    } catch {
      issues.push(`${at}.${urlKey} must be an http or https URL`);
    }
  }
  if (!text(config.idField)) issues.push(`${at}.idField is required and must be a non-empty string`);
  else notices.push(`${at}.idField is required by Tika, which then takes the document id from the emit key and not from this field; ripstream does the same`);

  const attachmentStrategy = choice(config, "attachmentStrategy", ["SEPARATE_DOCUMENTS", "PARENT_CHILD"] as const, at, issues);
  const updateStrategy = choice(config, "updateStrategy", ["OVERWRITE", "UPSERT"] as const, at, issues) ?? "UPSERT";
  const field = config.embeddedFileFieldName;
  if (field !== undefined && field !== null && !text(field)) issues.push(`${at}.embeddedFileFieldName must be a non-empty string`);
  if (config.commitWithin !== undefined && config.commitWithin !== null) {
    if (typeof config.commitWithin !== "number" || !Number.isSafeInteger(config.commitWithin)) issues.push(`${at}.commitWithin must be an integer`);
    else notices.push(`${at}.commitWithin is not used by Tika's ${type}, and not by ripstream's`);
  }
  const chunks = choice(config, "chunkStrategy", ["INLINE", "DOCUMENTS"] as const, at, issues);
  if (chunks === "DOCUMENTS") {
    issues.push(`${at}.chunkStrategy DOCUMENTS splits tk:chunks into one document each; ripstream produces no tk:chunks, so there is nothing to split (INLINE keeps a tk:chunks that a document carries as a JSON field)`);
  }
  if (chunks === "DOCUMENTS" && attachmentStrategy === "PARENT_CHILD") {
    issues.push(`${at}.chunkStrategy DOCUMENTS needs attachmentStrategy SEPARATE_DOCUMENTS: chunk documents have no join field`);
  }

  const apiKey = config.apiKey;
  if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") issues.push(`${at}.apiKey must be a string`);

  let userName: string | undefined;
  let password: string | undefined;
  let socketTimeoutMillis: number | undefined;
  const http = config.httpClientConfig;
  if (http !== undefined && http !== null) {
    const httpAt = `${at}.httpClientConfig`;
    if (!isObject(http)) {
      issues.push(`${httpAt} must be an object`);
    } else {
      for (const key of Object.keys(http)) {
        if (!(HTTP_KEYS as readonly string[]).includes(key)) issues.push(`${httpAt}.${key} is not a setting ripstream has (it reads ${HTTP_KEYS.join(", ")})`);
      }
      for (const key of ["userName", "password"] as const) {
        const value = http[key];
        if (value !== undefined && value !== null && typeof value !== "string") issues.push(`${httpAt}.${key} must be a string`);
      }
      userName = typeof http.userName === "string" && http.userName !== "" ? http.userName : undefined;
      password = typeof http.password === "string" && http.password !== "" ? http.password : undefined;
      if ((userName === undefined) !== (password === undefined)) issues.push(`${httpAt}.userName and password go together`);
      const scheme = http.authScheme;
      if (scheme !== undefined && scheme !== null && !(typeof scheme === "string" && scheme.toLowerCase() === "basic")) {
        issues.push(`${httpAt}.authScheme ${JSON.stringify(scheme)} is not supported: ripstream sends basic authentication, or an API key (Elasticsearch)`);
      }
      for (const key of ["connectionTimeoutMillis", "socketTimeoutMillis"] as const) {
        const value = http[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) issues.push(`${httpAt}.${key} must be an integer of 0 or more`);
        else if (key === "socketTimeoutMillis" && value > 0) socketTimeoutMillis = value;
        else if (key === "connectionTimeoutMillis" && value > 0) notices.push(`${httpAt}.connectionTimeoutMillis bounds connecting alone in Tika; ripstream bounds the whole request with socketTimeoutMillis`);
      }
      if (http.proxyHost !== undefined && http.proxyHost !== null && http.proxyHost !== "") {
        issues.push(`${httpAt}.proxyHost is not supported: Node's fetch has no per-client proxy setting, so a proxy has to be the process's own (its network or environment)`);
      }
      if (http.proxyPort !== undefined && http.proxyPort !== null && http.proxyPort !== 0) issues.push(`${httpAt}.proxyPort is not supported: see proxyHost`);
      if (http.verifySsl !== undefined && http.verifySsl !== null && typeof http.verifySsl !== "boolean") issues.push(`${httpAt}.verifySsl must be a boolean`);
      if (http.verifySsl === false) {
        issues.push(`${httpAt}.verifySsl false is refused: ripstream does not turn certificate checking off for one connection; trust the server's CA with NODE_EXTRA_CA_CERTS instead`);
      }
    }
  }
  const hasKey = typeof apiKey === "string" && apiKey !== "";
  if (hasKey && userName !== undefined) notices.push(`${at} has an apiKey and a userName: the apiKey is sent, as Tika's emitter does`);
  if ((hasKey || userName !== undefined) && url?.startsWith("http:") === true) notices.push(`${at}.${urlKey} is plain http, so the credentials are sent unencrypted`);

  if (url === undefined || issues.length > before) return undefined;
  return {
    id,
    type,
    url,
    ...(attachmentStrategy === undefined ? {} : { attachmentStrategy }),
    updateStrategy,
    embeddedFileFieldName: typeof field === "string" ? field.trim() : "embedded",
    ...(hasKey && type === "es-emitter" ? { apiKey: apiKey as string } : {}),
    ...(userName === undefined ? {} : { userName, password: password as string }),
    ...(socketTimeoutMillis === undefined ? {} : { socketTimeoutMillis }),
  };
}
