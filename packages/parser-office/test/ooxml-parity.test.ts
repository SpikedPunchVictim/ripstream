import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { textSimilarity } from "@spikedpunch/ripstream-parity";
import { OoxmlParser } from "../src/index.ts";
import { docxFixture, pptxFixture, xlsxFixture } from "./ooxml-fixtures.ts";

interface Goldens {
  readonly tikaVersion: string;
  readonly entries: readonly {
    id: string;
    text: string;
    metadata: Record<string, string>;
  }[];
}

const goldens = JSON.parse(
  readFileSync(new URL("./ooxml-goldens.json", import.meta.url), "utf8"),
) as Goldens;
const fixtures = {
  docx: docxFixture(),
  xlsx: xlsxFixture(),
  pptx: pptxFixture(),
} as const;

test("OOXML output is close to Tika 4.2 goldens", async () => {
  assert.equal(goldens.tikaVersion, "4.2.0");
  for (const golden of goldens.entries) {
    const bytes = fixtures[golden.id as keyof typeof fixtures];
    assert.ok(bytes !== undefined, `missing fixture ${golden.id}`);
    const stream = await RipstreamInputStream.from(bytes);
    const handler = new BodyContentHandler();
    const metadata = new Metadata();
    try {
      await new OoxmlParser().parse(
        stream,
        handler,
        metadata,
        new ParseContext(),
      );
    } finally {
      await stream.close();
    }
    const text = handler.toString();
    const similarity = textSimilarity(text, golden.text);
    assert.ok(
      similarity >= 0.5,
      `${golden.id} similarity ${similarity.toFixed(3)}; actual=${JSON.stringify(text)}`,
    );
    for (const [key, value] of Object.entries(golden.metadata)) {
      if (value === undefined || key === "Content-Type") continue;
      assert.equal(metadata.get(key), value, `${golden.id} ${key}`);
    }
  }
});
