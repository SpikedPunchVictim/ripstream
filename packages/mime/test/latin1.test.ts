import assert from "node:assert/strict";
import { test } from "node:test";
import { latin1 } from "../src/latin1.ts";

/** The helper this one replaced: the reference every result must equal. */
function chunkedFromCharCode(data: Uint8Array): string {
  let result = "";
  for (let index = 0; index < data.length; index += 4096) {
    result += String.fromCharCode(...data.subarray(index, index + 4096));
  }
  return result;
}

// A fixed-seed generator, so a failure replays.
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

test("latin1 maps each of the 256 byte values to the code point of the same number", () => {
  const all = Uint8Array.from({ length: 256 }, (_, index) => index);
  const text = latin1(all);
  assert.equal(text.length, 256);
  for (let index = 0; index < 256; index++) assert.equal(text.charCodeAt(index), index);
});

test("latin1 is not windows-1252: 0x80 to 0x9f stay C1 controls", () => {
  assert.equal(latin1(new Uint8Array([0x80, 0x93, 0x9f])), "\u0080\u0093\u009f");
});

test("latin1 of an empty view is empty", () => {
  assert.equal(latin1(new Uint8Array(0)), "");
});

test("latin1 equals the chunked fromCharCode version over random buffers, including ones over 4096 bytes", () => {
  const next = lcg(12345);
  for (const length of [1, 2, 4095, 4096, 4097, 8192, 8193, 70_000]) {
    const data = Uint8Array.from({ length }, () => next() >>> 24);
    assert.equal(latin1(data), chunkedFromCharCode(data), `length ${length}`);
  }
});

test("latin1 reads only the bytes of a subarray view, not the whole backing buffer", () => {
  const backing = Uint8Array.from({ length: 10_000 }, (_, index) => index & 0xff);
  const view = backing.subarray(5000, 9000);
  assert.equal(latin1(view), chunkedFromCharCode(view));
  assert.equal(latin1(view).length, 4000);
});

test("latin1 handles a view whose byte offset is odd", () => {
  const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  assert.equal(latin1(backing.subarray(3, 6)), "\u0004\u0005\u0006");
});
