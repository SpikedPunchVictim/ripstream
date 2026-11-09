import assert from "node:assert/strict";
import { test } from "node:test";
import { extractXmlRoot } from "../src/xml-root.ts";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

test("extracts Atom root with namespace", () => {
  const root = extractXmlRoot(
    utf8('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'),
  );
  assert.deepEqual(root, {
    localName: "feed",
    namespaceURI: "http://www.w3.org/2005/Atom",
  });
});

test("handles comments, processing instructions, and prefixes", () => {
  const root = extractXmlRoot(
    utf8('<!-- c --><?pi x?><svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>'),
  );
  assert.deepEqual(root, {
    localName: "svg",
    namespaceURI: "http://www.w3.org/2000/svg",
  });
});

test("reads the root past a DOCTYPE without expanding or fetching anything", () => {
  assert.deepEqual(
    extractXmlRoot(
      utf8(
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://127.0.0.1:1/x.dtd">' +
          '<html xmlns="http://www.w3.org/1999/xhtml"></html>',
      ),
    ),
    { localName: "html", namespaceURI: "http://www.w3.org/1999/xhtml" },
  );
  const laughs =
    '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
    '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol3;</lolz>';
  assert.equal(extractXmlRoot(utf8(laughs))?.localName, "lolz");
});

test("returns null for malformed XML", () => {
  assert.equal(extractXmlRoot(utf8("<not xml")), null);
  assert.equal(extractXmlRoot(utf8("plain text")), null);
});

test("decodes UTF-16LE with BOM", () => {
  const text = '<root xmlns="urn:test"/>';
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < text.length; index++) {
    bytes[2 + index * 2] = text.charCodeAt(index) & 0xff;
    bytes[3 + index * 2] = text.charCodeAt(index) >> 8;
  }
  assert.equal(extractXmlRoot(bytes)?.namespaceURI, "urn:test");
});
