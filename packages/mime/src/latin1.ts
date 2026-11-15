import { Buffer } from "node:buffer";

/**
 * The bytes as a string with one char per byte (U+0000 to U+00FF). This is ISO-8859-1 proper, not the windows-1252 that
 * `TextDecoder("latin1")` answers. A view onto the same memory, so nothing is copied before the string is built.
 */
export function latin1(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");
}
