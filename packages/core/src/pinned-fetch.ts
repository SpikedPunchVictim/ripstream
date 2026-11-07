import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

const NULL_BODY_STATUSES = [101, 204, 205, 304];

/** A `lookup` that only ever answers with the already-validated addresses. */
export function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = typeof options === "object" ? (options.family ?? 0) : 0;
    const usable = addresses.filter((a) => wanted === 0 || a.family === wanted);
    const first = usable[0];
    if (first === undefined) {
      callback(Object.assign(new Error("No validated address for requested family"), { code: "ENOTFOUND" }), "", 4);
    } else if (typeof options === "object" && options.all === true) {
      (callback as unknown as (e: null, all: ResolvedAddress[]) => void)(null, usable.map((a) => ({ ...a })));
    } else {
      callback(null, first.address, first.family);
    }
  };
}

/**
 * fetch-shaped request over node:http(s) whose socket can only connect to `addresses`.
 * TLS SNI and certificate checks still use the URL hostname. Redirects are never followed.
 * The response body is streamed, not buffered.
 */
export async function pinnedFetch(
  url: URL,
  init: RequestInit,
  addresses: readonly ResolvedAddress[],
  signal?: AbortSignal,
  /** Internal, test-only: extra trusted CA for TLS verification (verification stays on). */
  tls?: { readonly ca: string | Buffer },
): Promise<Response> {
  const req = new Request(url, { ...init, redirect: "manual" });
  const body = req.body === null ? undefined : Buffer.from(await req.arrayBuffer());
  const signals = [init.signal, signal].filter((s): s is AbortSignal => s != null);
  const combined = signals.length === 0 ? undefined : AbortSignal.any(signals);
  combined?.throwIfAborted();

  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers: Record<string, string> = {};
  req.headers.forEach((value, name) => {
    headers[name] = value;
  });
  if (body !== undefined) headers["content-length"] = String(body.length);

  const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = send(url, {
      method: req.method,
      headers,
      agent: false,
      ...(tls === undefined ? {} : { ca: tls.ca }),
      // No addresses means an IP literal or the private-network opt-in: nothing to pin.
      ...(addresses.length === 0 ? {} : { lookup: pinnedLookup(addresses) }),
      ...(combined === undefined ? {} : { signal: combined }),
    });
    outgoing.once("response", resolve);
    outgoing.once("error", reject);
    outgoing.end(body);
  });

  const responseHeaders = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    responseHeaders.append(incoming.rawHeaders[i] as string, incoming.rawHeaders[i + 1] as string);
  }
  const raw = incoming.statusCode ?? 502;
  const status = raw >= 200 && raw <= 599 ? raw : 502;
  const init2 = { status, statusText: incoming.statusMessage ?? "", headers: responseHeaders };
  if (NULL_BODY_STATUSES.includes(status) || req.method === "HEAD") {
    incoming.resume();
    return new Response(null, init2);
  }
  return new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, init2);
}
