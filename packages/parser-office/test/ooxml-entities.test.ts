import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { OoxmlParser } from "../src/index.ts";
import { entityDocxFixture } from "./ooxml-fixtures.ts";

test("an XML part that declares DTD entities is refused as an expansion limit, never expanded", async () => {
  const stream = await RipstreamInputStream.from(entityDocxFixture());
  await assert.rejects(
    new OoxmlParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    (error: unknown) => error instanceof LimitExceededError && /expanded-size limit/.test(error.message),
  );
  await stream.close();
});
