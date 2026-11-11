import type { RipstreamInputStream } from "@spikedpunch/ripstream-core";

/** The whole of a stream. The caller bounds what it does with the bytes (boundedUnzip counts what it inflates). */
export async function readAll(stream: RipstreamInputStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

/** UTF-8 text, a byte-order mark dropped and a malformed byte becoming U+FFFD. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
