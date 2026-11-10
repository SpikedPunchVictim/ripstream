import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";

const XHTML_DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n';
const XHTML_BODY = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>hi</body></html>';

/** [name, content, Tika 4.2.0's answer measured against the parity oracle]. */
const CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["x.html", XHTML_DOCTYPE + XHTML_BODY, "application/xhtml+xml"],
  ["x.html", XHTML_BODY, "application/xhtml+xml"],
  ["x.xhtml", XHTML_BODY, "application/xhtml+xml"],
  ["x.bin", XHTML_DOCTYPE + XHTML_BODY, "application/xhtml+xml"],
  ["x.xml", '<?xml version="1.0"?><root><a></root>', "application/xml"],
  ["x.html", '<?xml version="1.0"?><html><body><p>unclosed', "text/html"],
  ["x.bin", '<?xml version="1.0"?><html><body><p>unclosed', "text/html"],
  ["x.xml", '<?xml version="1.0"?>', "application/xml"],
  ["x.bin", '<?xml version="1.0"?>', "text/plain"],
  ["x.html", "<html><body>hi</body></html>", "text/html"],
  ["x.bin", "<!DOCTYPE html><html><body>hi</body></html>", "text/html"],
];

test("XML and HTML magic hits are refined by the root element, as Tika 4.2.0 does", async () => {
  const detector = new DefaultDetector();
  const failures: string[] = [];
  for (const [name, content, expected] of CASES) {
    const stream = await RipstreamInputStream.from(new TextEncoder().encode(content));
    try {
      const metadata = new Metadata();
      metadata.set("tk:resource-name", name);
      const actual = (await detector.detect(stream, metadata, new ParseContext())).toString();
      if (actual !== expected) failures.push(`${name} ${content.slice(0, 40)}: expected ${expected}, got ${actual}`);
    } finally {
      await stream.close();
    }
  }
  assert.deepEqual(failures, []);
});
