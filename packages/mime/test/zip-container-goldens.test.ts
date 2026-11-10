import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";
import { zip } from "./zip-fixture.ts";

interface Golden {
  readonly id: string;
  readonly filename: string;
  readonly entries: readonly { name: string; data: string | null }[];
  /** Tika 4.2.0's answer when the name is the typical one for the format, and when it is `x.bin`. */
  readonly typical: string;
  readonly neutral: string;
}

const goldens = JSON.parse(
  readFileSync(new URL("./zip-container-goldens.json", import.meta.url), "utf8"),
) as { tikaVersion: string; cases: readonly Golden[] };

const detector = new DefaultDetector();

async function detect(golden: Golden, filename: string): Promise<string> {
  // A directory entry is a name ending in "/" with no content.
  const bytes = zip(
    golden.entries.map((entry) => ({
      name: entry.name,
      bytes: entry.data === null ? new Uint8Array() : new Uint8Array(Buffer.from(entry.data, "base64")),
    })),
  );
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    const metadata = new Metadata();
    metadata.set("tk:resource-name", filename);
    return (await detector.detect(stream, metadata, new ParseContext())).toString();
  } finally {
    await stream.close();
  }
}

test("ZIP container detection matches Tika 4.2.0 on every measured fixture", async () => {
  assert.equal(goldens.tikaVersion, "4.2.0");
  const failures: string[] = [];
  for (const golden of goldens.cases) {
    for (const [variant, filename, expected] of [
      ["typical", golden.filename, golden.typical],
      ["neutral", "x.bin", golden.neutral],
    ] as const) {
      const actual = await detect(golden, filename);
      if (actual !== expected) failures.push(`${golden.id} (${variant}, ${filename}): expected ${expected}, got ${actual}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("the goldens cover each container family", () => {
  const ids = new Set(goldens.cases.map((golden) => golden.id));
  for (const id of ["docx", "xlsb", "vsdx", "odt", "sxw", "epub", "idml", "war", "apk", "aab", "ipa", "kmz", "ggb", "wacz", "iw13-keynote-slide", "iw18-pages", "opc-3mf"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
});
