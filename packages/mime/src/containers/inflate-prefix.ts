import { createGunzip, createInflateRaw } from "node:zlib";

/**
 * Inflates the leading bytes of a compressed stream, stopping once `maxBytes` of output exist. A truncated or corrupt
 * input ends in an error; what inflated before it is the prefix.
 */
function inflatePrefix(
  compressed: Uint8Array,
  maxBytes: number,
  createStream: typeof createInflateRaw | typeof createGunzip,
): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const inflate = createStream();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      inflate.destroy();
      resolve(new Uint8Array(Buffer.concat(chunks).subarray(0, maxBytes)));
    };
    inflate.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) finish();
    });
    inflate.on("error", finish);
    inflate.on("end", finish);
    inflate.end(compressed);
  });
}

export function inflateRawPrefix(compressed: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  return inflatePrefix(compressed, maxBytes, createInflateRaw);
}

export function gunzipPrefix(compressed: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  return inflatePrefix(compressed, maxBytes, createGunzip);
}
