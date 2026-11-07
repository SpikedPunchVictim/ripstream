import { lookup } from "node:dns/promises";
import { pinnedFetch, type ResolvedAddress } from "./pinned-fetch.ts";

export class UrlSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlSecurityError";
  }
}

export interface SafeFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly lookupImpl?: typeof lookup;
  readonly maxRedirects?: number;
  readonly allowedSchemes?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly allowPrivateNetworks?: boolean;
  readonly signal?: AbortSignal;
}

const DEFAULT_SCHEMES = ["http:", "https:"];

/** Rejects schemes and hosts that enable SSRF, including DNS-resolved IPs. */
export async function assertUrlAllowed(
  value: string | URL,
  options: SafeFetchOptions = {},
): Promise<URL> {
  return (await resolveAllowedUrl(value, options)).url;
}

interface AllowedUrl {
  readonly url: URL;
  /** Validated DNS answers for a hostname URL; empty for IP literals and private-network opt-in. */
  readonly addresses: readonly ResolvedAddress[];
}

async function resolveAllowedUrl(value: string | URL, options: SafeFetchOptions): Promise<AllowedUrl> {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    throw new UrlSecurityError(`Invalid URL: ${String(value)}`);
  }

  const schemes = options.allowedSchemes ?? DEFAULT_SCHEMES;
  if (!schemes.includes(url.protocol)) {
    throw new UrlSecurityError(`URL scheme ${url.protocol} is not allowed`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new UrlSecurityError("URLs with embedded credentials are not allowed");
  }

  if (options.allowedHosts !== undefined) {
    const host = url.hostname.toLowerCase();
    if (!options.allowedHosts.some((allowed) => host === allowed.toLowerCase())) {
      throw new UrlSecurityError(`Host ${host} is not in the allowlist`);
    }
  }

  if (options.allowPrivateNetworks !== true) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIpLiteral(host)) {
      if (isBlockedAddress(host)) {
        throw new UrlSecurityError(`Address ${host} is blocked`);
      }
      return { url, addresses: [] };
    }
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await (options.lookupImpl ?? lookup)(host, { all: true });
    } catch (error) {
      throw new UrlSecurityError(
        `Unable to resolve host ${host}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const resolved of addresses) {
      if (isBlockedAddress(resolved.address)) {
        throw new UrlSecurityError(
          `Host ${host} resolves to blocked address ${resolved.address}`,
        );
      }
    }
    return { url, addresses };
  }
  return { url, addresses: [] };
}

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * Fetch that validates every hop, caps redirects and re-checks hosts.
 * Credential headers (Authorization, Cookie, Proxy-Authorization) are dropped when a redirect
 * changes origin, and the body is dropped when a redirect downgrades the method to GET.
 *
 * DNS rebinding: when no `fetchImpl` is injected, the request goes through node:http(s) with a
 * `lookup` that returns only the addresses that were validated, so the socket connects to the
 * IP that was checked (TLS still verifies the original hostname). An injected `fetchImpl` is
 * called as-is and is responsible for its own pinning.
 */
export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  let { url, addresses } = await resolveAllowedUrl(input, options);
  let hopInit: RequestInit = init;

  for (let redirects = 0; ; redirects++) {
    const response =
      options.fetchImpl === undefined
        ? await pinnedFetch(url, hopInit, addresses, options.signal)
        : await options.fetchImpl(url, {
            ...hopInit,
            redirect: "manual",
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
    if (!REDIRECT_STATUSES.includes(response.status)) return response;
    if (redirects >= maxRedirects) {
      throw new UrlSecurityError(`Too many redirects (max ${maxRedirects})`);
    }
    const location = response.headers.get("location");
    if (location === null) return response;
    const next = await resolveAllowedUrl(new URL(location, url), options);
    hopInit = nextHopInit(hopInit, response.status, url, next.url);
    url = next.url;
    addresses = next.addresses;
  }
}

function nextHopInit(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  let next: RequestInit = init;
  const method = (init.method ?? "GET").toUpperCase();
  if (status === 303 ? method !== "GET" && method !== "HEAD" : (status === 301 || status === 302) && method === "POST") {
    const { body: _body, ...rest } = next;
    next = { ...rest, method: "GET" };
  }
  if (from.origin !== to.origin && next.headers !== undefined) {
    const headers = new Headers(next.headers);
    for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    next = { ...next, headers };
  }
  return next;
}

/** True for loopback, private, link-local, multicast, reserved and cloud-metadata addresses. */
export function isBlockedAddress(address: string): boolean {
  const bytes = parseIp(address);
  // Anything that is not a parseable IP literal is refused (fail closed).
  if (bytes === null) return true;
  return bytes.length === 4 ? isBlockedIpv4(bytes) : isBlockedIpv6(bytes);
}

type Cidr4 = readonly [string, number];
const BLOCKED_V4: readonly Cidr4[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["168.63.129.16", 32], // Azure wire server
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedIpv4(bytes: readonly number[]): boolean {
  const value = toUint32(bytes);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((toUint32(parseIpv4(base) ?? [0, 0, 0, 0]) & mask) >>> 0);
  });
}

function toUint32(bytes: readonly number[]): number {
  return (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
}

function isBlockedIpv6(b: readonly number[]): boolean {
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((v) => v === 0);
  // ::/96 covers unspecified, loopback and deprecated IPv4-compatible addresses.
  if (zeros(0, 12)) return true;
  // ::ffff:0:0/96 IPv4-mapped.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIpv4(b.slice(12));
  // 64:ff9b::/96 NAT64 (embedded IPv4) and 64:ff9b:1::/48 local-use NAT64.
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zeros(4, 12)) return isBlockedIpv4(b.slice(12));
    if (b[4] === 0 && b[5] === 1) return true;
  }
  // 2002::/16 6to4 with embedded IPv4.
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIpv4(b.slice(2, 6));
  // 2001::/32 Teredo, 2001:db8::/32 documentation.
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))) {
    return true;
  }
  const first = b[0] ?? 0;
  const second = b[1] ?? 0;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local (incl. fd00:ec2::254)
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (first === 0xff) return true; // ff00::/8 multicast
  return false;
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/** Parses an IPv4 (4 bytes) or IPv6 (16 bytes) literal; null when not an IP literal. */
function parseIp(value: string): number[] | null {
  let text = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(":")) return parseIpv4(text);

  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = v4;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (head === null || rest === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function isIpLiteral(host: string): boolean {
  return host.includes(":") || /^[\d.]+$/.test(host);
}
