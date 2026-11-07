import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { PlistParser } from "../src/index.ts";

test("extracts XML plist keys and values", async () => {
  const plist = `<?xml version="1.0"?><plist version="1.0"><dict><key>Name</key><string>Ada</string><key>Age</key><integer>36</integer></dict></plist>`;
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(plist));
  const handler = new BodyContentHandler();
  await new PlistParser().parse(
    stream,
    handler,
    new Metadata(),
    new ParseContext(),
  );
  await stream.close();
  assert.match(handler.toString(), /Name/);
  assert.match(handler.toString(), /Ada/);
  assert.match(handler.toString(), /36/);
});
