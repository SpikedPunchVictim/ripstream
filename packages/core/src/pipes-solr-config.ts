/*
 * The Solr components of a Tika configuration (tika-pipes-solr 4.2.0: SolrEmitterConfig, SolrPipesIteratorConfig and the
 * checks of SolrClientHelper), read the way pipes-search-config.ts reads the Elasticsearch ones (tikajs-68os.33): what
 * ripstream applies is applied, what changes nothing is accepted and said so, and the rest is refused by name with the
 * reason. Tika reads these with a strict mapper, so a key neither class has is refused here too. Defaults are resolved
 * here, so a settings object is complete. The pipes package builds the components.
 */

/** What reaches a collection: the Solr base URLs (tried in order), the collection, and what authorises and bounds a request. */
export interface SolrConnectionSettings {
  readonly urls: readonly string[];
  readonly collection: string;
  /** Basic authentication, sent with every request. */
  readonly userName?: string;
  readonly password?: string;
  /** How long one request may take. Tika's default is 60000, which it gives Jetty as the idle timeout. */
  readonly socketTimeoutMillis: number;
}

export type SolrAttachmentStrategy = "SEPARATE_DOCUMENTS" | "PARENT_CHILD";
export type SolrUpdateStrategy = "ADD" | "UPDATE_MUST_EXIST" | "UPDATE_MUST_NOT_EXIST";

export interface SolrEmitterSettings {
  readonly id: string;
  readonly type: "solr-emitter";
  readonly solr: SolrConnectionSettings;
  /** The field the emit key is the value of. */
  readonly idField: string;
  readonly commitWithin: number;
  readonly attachmentStrategy: SolrAttachmentStrategy;
  readonly updateStrategy: SolrUpdateStrategy;
  /** The field of the container that holds its embedded documents under PARENT_CHILD. */
  readonly embeddedFileFieldName: string;
}

export interface SolrIteratorSettings {
  readonly type: "solr-pipes-iterator";
  readonly solr: SolrConnectionSettings;
  /** Each is a filter query (`fq`). */
  readonly filters: readonly string[];
  /** The field whose value is the fetch key and the emit key of each tuple. */
  readonly idField: string;
  /** The first sort field: the cursor goes through the documents in the order of it and then `id`. */
  readonly parsingIdField: string;
  readonly failCountField: string;
  readonly sizeFieldName: string;
  readonly additionalFields: readonly string[];
  /** Documents asked for at a time. */
  readonly rows: number;
  readonly fetcherId: string;
  readonly emitterId: string;
}

export interface SolrParseContext {
  readonly at: string;
  readonly issues: string[];
  readonly notices: string[];
}

const EMITTER_KEYS = [
  "solrCollection",
  "solrUrls",
  "solrZkHosts",
  "solrZkChroot",
  "idField",
  "commitWithin",
  "connectionTimeoutMillis",
  "socketTimeoutMillis",
  "attachmentStrategy",
  "updateStrategy",
  "embeddedFileFieldName",
  "userName",
  "password",
  "authScheme",
  "proxyHost",
  "proxyPort",
  "verifySsl",
] as const;

const ITERATOR_KEYS = [
  "solrCollection",
  "solrUrls",
  "solrZkHosts",
  "solrZkChroot",
  "filters",
  "idField",
  "parsingIdField",
  "failCountField",
  "sizeFieldName",
  "additionalFields",
  "rows",
  "connectionTimeoutMillis",
  "socketTimeoutMillis",
  "userName",
  "password",
  "authScheme",
  "proxyHost",
  "proxyPort",
  "verifySsl",
  "fetcherId",
  "emitterId",
] as const;

const DEFAULT_COMMIT_WITHIN = 1000;
const DEFAULT_SOCKET_TIMEOUT_MILLIS = 60000;
const MAX_TIMER = 2147483647;

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !value.includes("\u0000");
const absent = (value: unknown): boolean => value === undefined || value === null;

function unknownKeys(config: Record<string, unknown>, known: readonly string[], at: string, issues: string[]): void {
  for (const key of Object.keys(config)) {
    if (!known.includes(key)) issues.push(`${at}.${key} is not a setting ripstream has (it reads ${known.join(", ")})`);
  }
}

function requiredText(config: Record<string, unknown>, key: string, at: string, issues: string[]): string | undefined {
  const value = config[key];
  if (text(value)) return value.trim();
  issues.push(`${at}.${key} is required and must be a non-empty string`);
  return undefined;
}

function optionalText(config: Record<string, unknown>, key: string, fallback: string, at: string, issues: string[]): string {
  const value = config[key];
  if (absent(value)) return fallback;
  if (text(value)) return value.trim();
  issues.push(`${at}.${key} must be a non-empty string`);
  return fallback;
}

/** A Solr base URL, as SolrJ takes it: the root of the service, which `/<collection>/update` is added to. */
function solrUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const plain = (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && !value.includes("?") && !value.includes("#");
    return plain ? value.trim().replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

function stringList(config: Record<string, unknown>, key: string, at: string, issues: string[]): string[] {
  const value = config[key];
  if (absent(value)) return [];
  if (!Array.isArray(value) || !value.every(text)) {
    issues.push(`${at}.${key} must be an array of non-empty strings`);
    return [];
  }
  return value.map((item: string) => item.trim());
}

/** The collection and where it is: `solrUrls`, or the ZooKeeper way that ripstream does not have. */
function parseTarget(config: Record<string, unknown>, context: SolrParseContext): { collection: string | undefined; urls: string[] | undefined } {
  const { at, issues, notices } = context;
  const collection = requiredText(config, "solrCollection", at, issues);
  const given = config.solrUrls;
  const hosts = config.solrZkHosts;
  const hasUrls = Array.isArray(given) ? given.length > 0 : !absent(given);
  const hasHosts = Array.isArray(hosts) ? hosts.length > 0 : !absent(hosts);
  if (hasUrls && hasHosts) {
    issues.push(`${at} has both solrUrls and solrZkHosts: Tika accepts only one of them`);
    return { collection, urls: undefined };
  }
  if (hasHosts) {
    issues.push(`${at}.solrZkHosts is not supported: reaching SolrCloud through ZooKeeper needs a ZooKeeper client, which ripstream does not carry; give the URL of a node of the cluster as solrUrls`);
    return { collection, urls: undefined };
  }
  if (!hasUrls) {
    issues.push(`${at}.solrUrls is required: Tika's validate() wants either solrUrls or solrZkHosts`);
    return { collection, urls: undefined };
  }
  if (text(config.solrZkChroot)) notices.push(`${at}.solrZkChroot is used by Tika only with solrZkHosts; beside solrUrls it changes nothing`);
  if (!Array.isArray(given)) {
    issues.push(`${at}.solrUrls must be an array of http or https URLs`);
    return { collection, urls: undefined };
  }
  const urls: string[] = [];
  given.forEach((item: unknown, index: number) => {
    const url = solrUrl(item);
    if (url === undefined) issues.push(`${at}.solrUrls[${index}] must be an http or https URL with no credentials, query or fragment`);
    else urls.push(url);
  });
  return { collection, urls: urls.length === given.length ? urls : undefined };
}

/** The settings both components have: the target, the timeouts, the authentication, and what ripstream refuses of the HTTP client. */
function parseConnection(config: Record<string, unknown>, context: SolrParseContext): SolrConnectionSettings | undefined {
  const { at, issues, notices } = context;
  const before = issues.length;
  const { collection, urls } = parseTarget(config, context);

  // Tika: a socket timeout of 0 or less is 60000.
  let socketTimeoutMillis = DEFAULT_SOCKET_TIMEOUT_MILLIS;
  const socket = config.socketTimeoutMillis;
  if (!absent(socket)) {
    if (typeof socket !== "number" || !Number.isInteger(socket) || socket > MAX_TIMER) issues.push(`${at}.socketTimeoutMillis must be an integer of at most ${MAX_TIMER}`);
    else if (socket > 0) socketTimeoutMillis = socket;
  }
  const connect = config.connectionTimeoutMillis;
  if (!absent(connect)) {
    if (typeof connect !== "number" || !Number.isInteger(connect)) issues.push(`${at}.connectionTimeoutMillis must be an integer`);
    else if (connect > 0) notices.push(`${at}.connectionTimeoutMillis bounds connecting alone in Tika; ripstream bounds the whole request with socketTimeoutMillis`);
  }

  let userName: string | undefined;
  let password: string | undefined;
  for (const key of ["userName", "password"] as const) {
    if (!absent(config[key]) && typeof config[key] !== "string") issues.push(`${at}.${key} must be a string`);
  }
  if (typeof config.userName === "string" && config.userName.trim() !== "") userName = config.userName;
  if (typeof config.password === "string" && config.password.trim() !== "") password = config.password;
  const scheme = config.authScheme;
  if (userName === undefined) {
    // Tika skips authentication when the user name is blank, whatever else is set.
    if (password !== undefined) notices.push(`${at}.password is not used without a userName: Tika skips authentication then`);
    if (text(scheme)) notices.push(`${at}.authScheme is not used without a userName: Tika skips authentication then`);
    password = undefined;
  } else {
    const passwordHasWrongType = !absent(config.password) && typeof config.password !== "string";
    if (password === undefined && !passwordHasWrongType) issues.push(`${at}.userName and password go together`);
    if (text(scheme) && scheme.trim().toLowerCase() !== "basic") {
      issues.push(`${at}.authScheme ${JSON.stringify(scheme)} is not supported: ripstream sends basic authentication, which is all Tika's Solr client takes`);
    }
  }

  const proxyHost = config.proxyHost;
  if (!absent(proxyHost) && proxyHost !== "") {
    issues.push(`${at}.proxyHost is not supported: Node's fetch has no per-client proxy setting, so a proxy has to be the process's own (its network or environment)`);
  }
  const proxyPort = config.proxyPort;
  if (!absent(proxyPort) && proxyPort !== 0) issues.push(`${at}.proxyPort is not supported: see proxyHost`);
  if (!absent(config.verifySsl) && typeof config.verifySsl !== "boolean") issues.push(`${at}.verifySsl must be a boolean`);
  if (config.verifySsl === false) {
    issues.push(`${at}.verifySsl false is refused: ripstream does not turn certificate checking off for one connection; trust the server's CA with NODE_EXTRA_CA_CERTS instead`);
  }

  if (collection === undefined || urls === undefined || issues.length > before) return undefined;
  return { urls, collection, ...(userName === undefined ? {} : { userName, password: password ?? "" }), socketTimeoutMillis };
}

function choice<T extends string>(config: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T, at: string, issues: string[]): T {
  const value = config[key];
  if (absent(value)) return fallback;
  const found = typeof value === "string" ? allowed.find((name) => name === value.toUpperCase()) : undefined;
  if (found !== undefined) return found;
  issues.push(`${at}.${key} must be ${allowed.slice(0, -1).join(", ")} or ${allowed[allowed.length - 1]} (in any case)`);
  return fallback;
}

export function parseSolrEmitter(id: string, config: Record<string, unknown>, context: SolrParseContext): SolrEmitterSettings | undefined {
  const { at, issues, notices } = context;
  const before = issues.length;
  unknownKeys(config, EMITTER_KEYS, at, issues);
  const solr = parseConnection(config, context);
  const idField = optionalText(config, "idField", "id", at, issues);
  let commitWithin = DEFAULT_COMMIT_WITHIN;
  if (!absent(config.commitWithin)) {
    if (typeof config.commitWithin !== "number" || !Number.isInteger(config.commitWithin)) issues.push(`${at}.commitWithin must be an integer`);
    else if (config.commitWithin > 0) commitWithin = config.commitWithin;
    else notices.push(`${at}.commitWithin of ${config.commitWithin} is ${DEFAULT_COMMIT_WITHIN}, as in Tika`);
  }
  const attachmentStrategy = choice(config, "attachmentStrategy", ["SEPARATE_DOCUMENTS", "PARENT_CHILD"] as const, "PARENT_CHILD", at, issues);
  const updateStrategy = choice(config, "updateStrategy", ["ADD", "UPDATE_MUST_EXIST", "UPDATE_MUST_NOT_EXIST"] as const, "ADD", at, issues);
  const embeddedFileFieldName = optionalText(config, "embeddedFileFieldName", "embedded", at, issues);
  if (solr === undefined || issues.length > before) return undefined;
  return { id, type: "solr-emitter", solr, idField, commitWithin, attachmentStrategy, updateStrategy, embeddedFileFieldName };
}

export function parseSolrIterator(config: Record<string, unknown>, context: SolrParseContext): SolrIteratorSettings | undefined {
  const { at, issues } = context;
  const before = issues.length;
  unknownKeys(config, ITERATOR_KEYS, at, issues);
  const fetcherId = requiredText(config, "fetcherId", at, issues);
  const emitterId = requiredText(config, "emitterId", at, issues);
  const idField = requiredText(config, "idField", at, issues);
  const parsingIdField = requiredText(config, "parsingIdField", at, issues);
  const failCountField = requiredText(config, "failCountField", at, issues);
  const sizeFieldName = requiredText(config, "sizeFieldName", at, issues);
  const filters = stringList(config, "filters", at, issues);
  const additionalFields = stringList(config, "additionalFields", at, issues);
  let rows = 5000;
  if (!absent(config.rows)) {
    if (typeof config.rows !== "number" || !Number.isInteger(config.rows) || config.rows < 1) issues.push(`${at}.rows must be a whole number of 1 or more`);
    else rows = config.rows;
  }
  const solr = parseConnection(config, context);
  if (solr === undefined || issues.length > before || fetcherId === undefined || emitterId === undefined) return undefined;
  if (idField === undefined || parsingIdField === undefined || failCountField === undefined || sizeFieldName === undefined) return undefined;
  return { type: "solr-pipes-iterator", solr, filters, idField, parsingIdField, failCountField, sizeFieldName, additionalFields, rows, fetcherId, emitterId };
}
