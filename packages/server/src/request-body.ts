import type { IncomingMessage } from "node:http";
import { gunzip } from "node:zlib";
import { RipstreamError } from "@spikedpunch/ripstream-core";
import { HttpError } from "./http-error.ts";

/**
 * How much of a body over the cap is read and thrown away, and for how long, so the 413 can be answered on a
 * connection that lives on. A body past that is not read at all: the 413 closes the connection.
 */
const DRAIN_BYTES = 16 * 1024 * 1024;
const DRAIN_MILLIS = 5_000;

function isGzip(request: IncomingMessage): boolean {
  const encoding = String(request.headers["content-encoding"] ?? "").trim().toLowerCase();
  return encoding === "gzip" || encoding === "x-gzip";
}

/**
 * The request body, inflated when it is sent with `Content-Encoding: gzip`, as Tika's server does. `limit` bounds the
 * body on the wire and again what it inflates to, so a small gzip cannot become a large document.
 */
export async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const raw = await readRawBody(request, limit);
  if (!isGzip(request) || raw.length === 0) return raw;
  return new Promise((resolve, reject) => {
    gunzip(raw, { maxOutputLength: limit }, (error, inflated) => {
      if (error === null) {
        resolve(new Uint8Array(inflated));
      } else if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        reject(new RipstreamError("REQUEST_TOO_LARGE", `Request exceeds ${limit} bytes once decoded`));
      } else {
        reject(new HttpError(400, "Request body is not valid gzip"));
      }
    });
  });
}

/**
 * The start of the request body, for a route that reads no more than `keep` bytes of it. The whole body still counts
 * against `limit`, but what is past `keep` is dropped as it arrives instead of held until the request ends. A gzip
 * body is inflated whole and returned whole: its start cannot be had without it.
 */
export function readBodyPrefix(request: IncomingMessage, limit: number, keep: number): Promise<Uint8Array> {
  return isGzip(request) ? readBody(request, limit) : readRawBody(request, limit, keep);
}

/**
 * The request body as it came, or `REQUEST_TOO_LARGE` when it is over `limit`. With `keep`, only its first `keep`
 * bytes are kept (all of it, when it is no longer); the limit is still checked against the whole. A body over the
 * limit is not kept: it is read and discarded up to `DRAIN_BYTES` more, then the error is raised with the request read
 * to its end (`request.complete`), or, when the client sends more than that or too slowly, with the request left
 * unread (`!request.complete`). Never destroys the request: that would take the connection with it before the 413 is
 * written.
 */
export function readRawBody(request: IncomingMessage, limit: number, keep: number = Infinity): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (request.readableEnded) {
      resolve(new Uint8Array());
      return;
    }
    const tooLarge = (): RipstreamError => new RipstreamError("REQUEST_TOO_LARGE", `Request exceeds ${limit} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    let kept = 0;
    let discarding = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (error: Error | null): void => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("close", onClose);
      if (error === null) {
        resolve(new Uint8Array(Buffer.concat(chunks)));
        return;
      }
      request.pause();
      reject(error);
    };
    const startDiscarding = (): void => {
      discarding = true;
      chunks.length = 0;
      timer = setTimeout(() => settle(tooLarge()), DRAIN_MILLIS);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (!discarding && total > limit) startDiscarding();
      if (discarding) {
        if (total > limit + DRAIN_BYTES) settle(tooLarge());
        return;
      }
      const take = Math.min(chunk.length, keep - kept);
      if (take > 0) {
        chunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
        kept += take;
      }
    };
    const onEnd = (): void => settle(discarding ? tooLarge() : null);
    const onError = (error: Error): void => settle(error);
    const onClose = (): void => {
      if (!request.readableEnded) settle(new Error("Request aborted before its body was read"));
    };

    const declared = Number(request.headers["content-length"]);
    if (declared > limit + DRAIN_BYTES) {
      reject(tooLarge());
      return;
    }
    if (declared > limit) startDiscarding();
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("close", onClose);
  });
}
