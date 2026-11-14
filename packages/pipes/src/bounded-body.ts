import { LimitExceededError } from "@spikedpunch/ripstream-core";

/** What a fetcher reads of one object at most when it is not told: more than any document is meant to be, and bounded. */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024 * 1024;

/** The error a body over its cap fails with: the object it was, and the cap. */
export const overCap = (what: string, maxBytes: number): ((declared: number | null) => Error) => {
  return (declared) =>
    new LimitExceededError(`${what} ${declared === null ? "exceeds" : `is ${declared} bytes, over`} the cap of ${maxBytes} bytes`);
};

/**
 * The body of a response, refused (with `over`'s error) as soon as it is known to be longer than `maxBytes`: from its
 * declared length before a byte is read, or from the bytes themselves as they arrive, since a length can be absent or
 * wrong. A body that is refused, and one with no use because the signal ended, is cancelled so its connection is released.
 */
export async function readBounded(
  response: Response,
  maxBytes: number,
  over: (declared: number | null) => Error,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (response.headers.get("content-length") !== null && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw over(declared);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  // A body that ignores the signal still ends with it.
  const stop = (): void => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted === true) throw signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw over(null);
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
