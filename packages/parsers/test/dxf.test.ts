import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DxfParser } from "../src/index.ts";

test("extracts DXF text entities", async () => {
  const dxf = ["0","SECTION","2","ENTITIES","0","TEXT","1","Hello DXF","0","ENDSEC","0","EOF"].join("\n");
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(dxf));
  const handler = new BodyContentHandler();
  await new DxfParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /Hello DXF/);
});
