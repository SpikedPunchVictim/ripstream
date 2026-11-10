/** The endpoints of Tika's server that `ripstream serve` serves, by Tika's names. */
export const SERVER_ENDPOINTS = ["tika", "rmeta", "meta", "unpack", "detect", "language", "mime-types", "version", "status", "async"] as const;

export type ServerEndpoint = (typeof SERVER_ENDPOINTS)[number];

/**
 * What the server serves when no endpoints are named: Tika's default set, less the endpoints ripstream does not serve.
 * `status` and `async` are opt-in, as `status`, `pipes` and `async` are in Tika (TikaServerProcess.DEFAULT_ENDPOINTS).
 */
export const DEFAULT_SERVER_ENDPOINTS: readonly ServerEndpoint[] = ["tika", "rmeta", "meta", "unpack", "detect", "language", "mime-types", "version"];

/** The `server` section as ripstream applies it. A key the section leaves out is absent here. */
export interface ServerSettings {
  readonly port?: number;
  /** `*` is already `0.0.0.0`, as Tika reads it. */
  readonly host?: string;
  /** Exactly the endpoints to serve; absent means `DEFAULT_SERVER_ENDPOINTS`. */
  readonly endpoints?: readonly ServerEndpoint[];
  readonly cors?: string;
  readonly maxRequestSizeBytes?: number;
  readonly requestLogLevel?: "debug" | "info";
  /** Negative disables the deadline, as in Tika. */
  readonly maxRequestReadMillis?: number;
  readonly idleTimeoutMillis?: number;
}

const INT_MAX = 2 ** 31 - 1;

/** Tika endpoints (TikaServerProcess.VALID_ENDPOINTS) that ripstream does not serve from a configuration. */
const NOT_SERVED = new Set(["detectors", "parsers", "pipes"]);

/** Switches that open a Tika feature ripstream does not have. Off is what ripstream does, so off is accepted. */
const SWITCHES: Readonly<Record<string, string>> = {
  allowPipes: "ripstream's /pipes needs an authenticate function and path roots, which only code can give (createRipstreamServer)",
  allowPerRequestConfig: "ripstream does not take configuration with a request",
  allowHttp2: "ripstream serves HTTP/1.1 only",
};

/** Settings with no ripstream counterpart, and why. */
const REFUSED: Readonly<Record<string, string>> = {
  maxQueuePauseMillis: "ripstream answers 503 at once when its queue is full; it does not pause first",
  maxResponseWriteMillis: "ripstream sets no deadline on writing a response",
  maxInFlightRequestBytes: "ripstream bounds requests by their number (maxConcurrent, maxQueue), not by the bytes in flight",
  id: "ripstream has no server id; isolation replaces fork mode and its watchdog",
  tlsConfig: "ripstream serves plain HTTP; terminate TLS in front of it",
  metricsPort: "ripstream has no metrics listener",
};

const APPLIED = ["port", "host", "endpoints", "cors", "maxRequestSizeBytes", "requestLogLevel", "maxRequestReadMillis", "idleTimeoutMillis"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A whole number in [min, max], and not -0, which `JSON.parse` writes for `-0`. */
const whole = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;

function endpointList(value: unknown, issues: string[]): ServerEndpoint[] | undefined {
  if (!Array.isArray(value)) {
    issues.push("server.endpoints must be an array of endpoint names");
    return undefined;
  }
  const names: ServerEndpoint[] = [];
  value.forEach((item: unknown, index) => {
    const where = `server.endpoints[${index}]`;
    if (typeof item !== "string") issues.push(`${where} must be an endpoint name`);
    else if (item === "mime") {
      // Tika's `mime` and `mime-types` are the one resource (TikaServerProcess), so naming either serves it.
      if (!names.includes("mime-types")) names.push("mime-types");
    } else if (NOT_SERVED.has(item)) {
      issues.push(`${where} ${JSON.stringify(item)} is a Tika endpoint that ripstream does not serve (it serves ${SERVER_ENDPOINTS.join(", ")})`);
    } else if (!(SERVER_ENDPOINTS as readonly string[]).includes(item)) {
      issues.push(`${where} ${JSON.stringify(item)} is not an endpoint; ripstream serves ${SERVER_ENDPOINTS.join(", ")}`);
    } else if (!names.includes(item as ServerEndpoint)) names.push(item as ServerEndpoint);
  });
  return names;
}

/**
 * Reads a `server` section in Tika's shape (`TikaServerConfig`, tika-server 4.2.0). A setting ripstream's server has no
 * counterpart for is an issue naming it, where Tika's own loader would never see it; a switch for a feature ripstream
 * lacks is refused only when it turns the feature on. An empty list of endpoints, an empty `cors` and `host: "*"`
 * mean what they mean in Tika.
 */
export function parseServerSection(value: unknown): { settings: ServerSettings; issues: string[] } {
  const issues: string[] = [];
  if (!isObject(value)) return { settings: {}, issues: ["server must be an object"] };

  const settings: { -readonly [K in keyof ServerSettings]: ServerSettings[K] } = {};
  for (const [key, raw] of Object.entries(value)) {
    switch (key) {
      case "port":
        if (whole(raw, 0, 65_535)) settings.port = raw;
        else issues.push("server.port must be an integer from 0 to 65535");
        break;
      case "host":
        if (typeof raw === "string" && raw.length > 0) settings.host = raw === "*" ? "0.0.0.0" : raw;
        else issues.push("server.host must be a host name, a non-empty string");
        break;
      case "endpoints": {
        const names = endpointList(raw, issues);
        if (names !== undefined && names.length > 0) settings.endpoints = Object.freeze(names);
        break;
      }
      case "cors":
        if (typeof raw !== "string") issues.push("server.cors must be an origin, a string");
        else if (raw.length > 0) settings.cors = raw;
        break;
      case "maxRequestSizeBytes":
        if (whole(raw, 1, Number.MAX_SAFE_INTEGER)) settings.maxRequestSizeBytes = raw;
        else issues.push("server.maxRequestSizeBytes must be a positive number of bytes: ripstream always bounds a request body");
        break;
      case "requestLogLevel":
        if (raw === "debug" || raw === "info") settings.requestLogLevel = raw;
        else issues.push('server.requestLogLevel must be "debug" or "info"');
        break;
      case "maxRequestReadMillis":
        if (whole(raw, -INT_MAX, INT_MAX) && raw !== 0) settings.maxRequestReadMillis = raw;
        else {
          issues.push(
            `server.maxRequestReadMillis must be a whole number of milliseconds up to ${INT_MAX}, or negative to disable the deadline; not zero`,
          );
        }
        break;
      case "idleTimeoutMillis":
        if (whole(raw, 1, INT_MAX)) settings.idleTimeoutMillis = raw;
        else issues.push(`server.idleTimeoutMillis must be a whole number of milliseconds from 1 to ${INT_MAX}`);
        break;
      default:
        if (Object.hasOwn(SWITCHES, key)) {
          if (raw === true) issues.push(`server.${key} is not supported: ${SWITCHES[key]}`);
          else if (raw !== false) issues.push(`server.${key} must be true or false`);
        } else if (Object.hasOwn(REFUSED, key)) {
          issues.push(`server.${key} is not supported: ${REFUSED[key]}`);
        } else {
          issues.push(`server.${key} is not a server setting; ripstream applies ${APPLIED.join(", ")}`);
        }
    }
  }
  return { settings: Object.freeze(settings), issues };
}
