import assert from "node:assert/strict";
import { test } from "node:test";
import { importWithoutPdfjsWarnings } from "../src/pdfjs-import.ts";

/** What `console.log` writes while `run` is going, with the real one put back after. */
async function captured(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  const mine = console.log;
  try {
    await run();
    assert.equal(console.log === mine, true, "console.log is put back");
  } finally {
    console.log = real;
  }
  return lines;
}

test("pdf.js warnings written while the module loads are dropped; anything else is passed on (tikajs-08ld)", async () => {
  const lines = await captured(async () => {
    const value = await importWithoutPdfjsWarnings(async () => {
      console.log("Warning: Cannot polyfill `DOMMatrix`, rendering may be broken.");
      console.log("an application's own line");
      console.log({ not: "a string" });
      await new Promise((resolve) => setImmediate(resolve));
      console.log("Warning: Cannot load \"@napi-rs/canvas\" package");
      return 42;
    });
    assert.equal(value, 42);
  });
  assert.deepEqual(lines, ["an application's own line", "[object Object]"]);
});

test("a warning written after the load is not dropped, and a failed load puts console.log back", async () => {
  const lines = await captured(async () => {
    await assert.rejects(importWithoutPdfjsWarnings(async () => Promise.reject(new Error("no pdfjs"))), /no pdfjs/);
    console.log("Warning: after");
  });
  assert.deepEqual(lines, ["Warning: after"]);
});

test("overlapping loads drop warnings until the last is done", async () => {
  const lines = await captured(async () => {
    const slow = importWithoutPdfjsWarnings(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      console.log("Warning: from the slow load");
    });
    await importWithoutPdfjsWarnings(async () => undefined);
    console.log("Warning: while the slow one runs");
    await slow;
    console.log("Warning: after both");
  });
  assert.deepEqual(lines, ["Warning: after both"]);
});
