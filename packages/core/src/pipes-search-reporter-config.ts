import type { PipesResultStatus } from "./pipes-config.ts";

/*
 * The Elasticsearch and OpenSearch reporters of a Tika configuration (tika-pipes-es ESReporterConfig and
 * tika-pipes-opensearch OpenSearchReporterConfig 4.2.0), read the way pipes-search-config.ts reads the emitters
 * (tikajs-68os.34): what ripstream applies is applied, what changes nothing is accepted and said so, and the rest is
 * refused by name with the reason. Tika reads these with a strict mapper, so a key neither class has is refused here too.
 * The pipes package builds the reporters.
 */

export type SearchReporterType = "es-pipes-reporter" | "opensearch-pipes-reporter";

export interface SearchReporterSettings {
  readonly type: SearchReporterType;
  /** The index's URL (Tika's `esUrl` / `openSearchUrl`), without a trailing slash: `/_bulk` is added to it. */
  readonly url: string;
  /** Only the results of these statuses are reported. Absent or empty: every result (Tika's null and empty set). */
  readonly includes?: readonly PipesResultStatus[];
  /** Every result but those of these statuses is reported. At most one of the two has any. */
  readonly excludes?: readonly PipesResultStatus[];
  /** Goes before `parse_status` and `parse_time_ms`. Tika's null is blank: no prefix. */
  readonly keyPrefix: string;
  /** Whether the update is routed by the document's id. */
  readonly includeRouting: boolean;
  /** Elasticsearch only: sent as `Authorization: ApiKey <value>`. */
  readonly apiKey?: string;
  readonly userName?: string;
  readonly password?: string;
  /** Applied as the time one request may take. Absent: no limit. */
  readonly socketTimeoutMillis?: number;
}

export interface SearchReporterParseContext {
  readonly at: string;
  readonly issues: string[];
  readonly notices: string[];
  /** The names of the result statuses `includes` and `excludes` may hold. */
  readonly statuses: readonly string[];
}

const URL_KEY: Readonly<Record<SearchReporterType, string>> = { "es-pipes-reporter": "esUrl", "opensearch-pipes-reporter": "openSearchUrl" };

const HTTP_KEYS = ["userName", "password", "authScheme", "connectionTimeoutMillis", "socketTimeoutMillis", "proxyHost", "proxyPort", "verifySsl"] as const;

/** Tika's TikaCoreProperties.TIKA_META_PREFIX and LEGACY_TIKA_META_PREFIX: its Metadata refuses to write a key that starts with either. */
const RESERVED_PREFIXES = ["tk:", "X-TIKA:"] as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const present = (value: unknown): boolean => value !== undefined && value !== null;
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !value.includes("\u0000");

function reporterUrl(given: unknown, where: string, issues: string[]): string | undefined {
  if (!text(given)) {
    issues.push(`${where} is required and must be the index's URL`);
    return undefined;
  }
  try {
    const parsed = new URL(given);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http(s)");
    if (parsed.username !== "" || parsed.password !== "") {
      issues.push(`${where} must not carry a user name or password: give them as httpClientConfig.userName and password, or as apiKey`);
      return undefined;
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      issues.push(`${where} must not carry a query or a fragment: it is the index's URL, and /_bulk is added to it`);
      return undefined;
    }
    return given.trim().replace(/\/+$/, "");
  } catch {
    issues.push(`${where} must be an http or https URL`);
    return undefined;
  }
}

function statusList(value: unknown, where: string, statuses: readonly string[], issues: string[]): PipesResultStatus[] {
  if (!present(value)) return [];
  if (!Array.isArray(value)) {
    issues.push(`${where} must be an array of result statuses`);
    return [];
  }
  const names: PipesResultStatus[] = [];
  value.forEach((item: unknown, index) => {
    if (typeof item === "string" && statuses.includes(item)) names.push(item as PipesResultStatus);
    else issues.push(`${where}[${index}] ${JSON.stringify(item)} is not a result status (Tika's are ${statuses.join(", ")})`);
  });
  return names;
}

interface HttpSettings {
  readonly userName?: string;
  readonly password?: string;
  readonly socketTimeoutMillis?: number;
}

/**
 * Elasticsearch's reporter applies all of httpClientConfig. OpenSearch's applies only the credentials and verifySsl: the
 * rest is commented out in its `init`, so there the rest is accepted with a notice. A timeout is applied anyway, since a
 * request that nothing bounds can hang a run.
 */
function httpClientConfig(type: SearchReporterType, http: unknown, at: string, issues: string[], notices: string[]): HttpSettings {
  if (!present(http)) return {};
  const where = `${at}.httpClientConfig`;
  if (!isObject(http)) {
    issues.push(`${where} must be an object`);
    return {};
  }
  const elastic = type === "es-pipes-reporter";
  const ignored = `Tika's ${type} does not apply it`;
  for (const key of Object.keys(http)) {
    if (!(HTTP_KEYS as readonly string[]).includes(key)) issues.push(`${where}.${key} is not a setting ripstream has (it reads ${HTTP_KEYS.join(", ")})`);
  }
  for (const key of ["userName", "password"] as const) {
    if (present(http[key]) && typeof http[key] !== "string") issues.push(`${where}.${key} must be a string`);
  }
  const userName = typeof http.userName === "string" && http.userName !== "" ? http.userName : undefined;
  const password = typeof http.password === "string" && http.password !== "" ? http.password : undefined;
  if ((userName === undefined) !== (password === undefined)) issues.push(`${where}.userName and password go together`);

  const scheme = http.authScheme;
  if (present(scheme) && typeof scheme !== "string") issues.push(`${where}.authScheme must be a string`);
  else if (typeof scheme === "string" && !elastic) notices.push(`${where}.authScheme ${ignored}; ripstream sends basic authentication`);
  else if (typeof scheme === "string" && scheme.toLowerCase() !== "basic") {
    issues.push(`${where}.authScheme ${JSON.stringify(scheme)} is not supported: ripstream sends basic authentication, or an API key (Elasticsearch)`);
  }

  let socketTimeoutMillis: number | undefined;
  for (const key of ["connectionTimeoutMillis", "socketTimeoutMillis"] as const) {
    const value = http[key];
    if (!present(value)) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      issues.push(`${where}.${key} must be an integer of 0 or more`);
    } else if (key === "socketTimeoutMillis" && value > 0) {
      socketTimeoutMillis = value;
      if (!elastic) notices.push(`${where}.socketTimeoutMillis ${ignored}; ripstream applies it as the time one request may take`);
    } else if (key === "connectionTimeoutMillis" && value > 0) {
      notices.push(
        elastic
          ? `${where}.connectionTimeoutMillis bounds connecting alone in Tika; ripstream bounds the whole request with socketTimeoutMillis`
          : `${where}.connectionTimeoutMillis ${ignored}; ripstream bounds the whole request with socketTimeoutMillis`,
      );
    }
  }

  if (present(http.proxyHost) && http.proxyHost !== "") {
    if (elastic) issues.push(`${where}.proxyHost is not supported: Node's fetch has no per-client proxy setting, so a proxy has to be the process's own (its network or environment)`);
    else notices.push(`${where}.proxyHost ${ignored}, and ripstream has no per-client proxy: the process's own is used`);
  }
  if (present(http.proxyPort) && http.proxyPort !== 0) {
    if (elastic) issues.push(`${where}.proxyPort is not supported: see proxyHost`);
    else notices.push(`${where}.proxyPort ${ignored}`);
  }
  if (present(http.verifySsl) && typeof http.verifySsl !== "boolean") issues.push(`${where}.verifySsl must be a boolean`);
  if (http.verifySsl === false) {
    issues.push(`${where}.verifySsl false is refused: ripstream does not turn certificate checking off for one connection; trust the server's CA with NODE_EXTRA_CA_CERTS instead`);
  }
  return { ...(userName === undefined ? {} : { userName, password: password as string }), ...(socketTimeoutMillis === undefined ? {} : { socketTimeoutMillis }) };
}

export function parseSearchReporter(type: SearchReporterType, config: Record<string, unknown>, context: SearchReporterParseContext): SearchReporterSettings | undefined {
  const { at, issues, notices, statuses } = context;
  const before = issues.length;
  const urlKey = URL_KEY[type];
  const own = [urlKey, "includes", "excludes", "keyPrefix", "includeRouting", "httpClientConfig", ...(type === "es-pipes-reporter" ? ["apiKey"] : [])];
  for (const key of Object.keys(config)) {
    if (!own.includes(key)) issues.push(`${at}.${key} is not a setting ripstream has (it reads ${own.join(", ")})`);
  }

  const url = reporterUrl(config[urlKey], `${at}.${urlKey}`, issues);

  const includes = statusList(config.includes, `${at}.includes`, statuses, issues);
  const excludes = statusList(config.excludes, `${at}.excludes`, statuses, issues);
  if (includes.length > 0 && excludes.length > 0) issues.push(`${at} may set includes or excludes, not both: Tika refuses "Only one of includes and excludes may have any contents"`);

  let keyPrefix = "";
  if (present(config.keyPrefix) && typeof config.keyPrefix !== "string") issues.push(`${at}.keyPrefix must be a string`);
  else if (typeof config.keyPrefix === "string") {
    // Tika's StringUtils.isBlank: a blank prefix is none.
    keyPrefix = config.keyPrefix.trim() === "" ? "" : config.keyPrefix;
    if (RESERVED_PREFIXES.some((reserved) => keyPrefix.startsWith(reserved))) {
      issues.push(`${at}.keyPrefix ${JSON.stringify(keyPrefix)} is in the reserved Tika-native namespace (tk:/X-TIKA:): Tika's Metadata refuses to write a key that starts so; choose a different keyPrefix`);
    }
  }

  if (present(config.includeRouting) && typeof config.includeRouting !== "boolean") issues.push(`${at}.includeRouting must be a boolean`);

  const apiKey = config.apiKey;
  if (present(apiKey) && typeof apiKey !== "string") issues.push(`${at}.apiKey must be a string`);
  const hasKey = typeof apiKey === "string" && apiKey !== "";

  const http = httpClientConfig(type, config.httpClientConfig, at, issues, notices);
  if (hasKey && http.userName !== undefined) notices.push(`${at} has an apiKey and a userName: the apiKey is sent, as Tika's reporter does`);
  if ((hasKey || http.userName !== undefined) && url?.startsWith("http:") === true) notices.push(`${at}.${urlKey} is plain http, so the credentials are sent unencrypted`);

  if (url === undefined || issues.length > before) return undefined;
  return {
    type,
    url,
    ...(includes.length === 0 ? {} : { includes }),
    ...(excludes.length === 0 ? {} : { excludes }),
    keyPrefix,
    includeRouting: config.includeRouting === true,
    ...(hasKey ? { apiKey: apiKey as string } : {}),
    ...http,
  };
}
