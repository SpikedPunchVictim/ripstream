import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";
import { ole2, type Ole2Entry } from "./ole2-fixture.ts";

interface Golden {
  readonly id: string;
  readonly filename: string;
  /** A real Tika corpus file, base64; absent for a synthetic compound file. */
  readonly file?: string;
  /** Root-level entries of a synthetic compound file. */
  readonly tree?: readonly Ole2Entry[];
  /** Tika 4.2.0's answer when the name is the typical one for the format, and when it is `x.bin`. */
  readonly typical: string;
  readonly neutral: string;
}

const goldens = JSON.parse(
  readFileSync(new URL("./ole2-encrypted-goldens.json", import.meta.url), "utf8"),
) as { tikaVersion: string; cases: readonly Golden[] };

const detector = new DefaultDetector();

async function detect(golden: Golden, filename: string): Promise<string> {
  const bytes =
    golden.file !== undefined
      ? new Uint8Array(Buffer.from(golden.file, "base64"))
      : ole2(golden.tree ?? []);
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    const metadata = new Metadata();
    metadata.set("resourceName", filename);
    return (await detector.detect(stream, metadata, new ParseContext())).toString();
  } finally {
    await stream.close();
  }
}

test("encrypted OLE2 detection agrees with the Tika 4.2.0 oracle", async () => {
  assert.equal(goldens.tikaVersion, "4.2.0");
  const failures: string[] = [];
  for (const golden of goldens.cases) {
    const typical = await detect(golden, golden.filename);
    if (typical !== golden.typical) failures.push(`${golden.id} (${golden.filename}): ${typical} != ${golden.typical}`);
    const neutral = await detect(golden, "x.bin");
    if (neutral !== golden.neutral) failures.push(`${golden.id} (x.bin): ${neutral} != ${golden.neutral}`);
  }
  assert.deepEqual(failures, []);
});

test("encrypted OLE2 goldens cover the decision table", () => {
  const ids = new Set(goldens.cases.map((golden) => golden.id));
  for (const id of [
    "real-protected-upper-case-docx",
    "ep+ei",
    "ep-only",
    "ep+ei-nested",
    "ep+drm-space",
    "drm-space-depth-10",
    "drm-space-depth-11",
  ]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
});
