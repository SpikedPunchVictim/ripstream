import assert from "node:assert/strict";
import { test } from "node:test";
import { UnsupportedFormatError } from "@spikedpunch/ripstream-core";
import { createRipstream } from "../src/index.ts";

const encoder = new TextEncoder();
const ripstream = createRipstream();

test("detects text and named PDF", async () => {
  assert.equal((await ripstream.detect(encoder.encode("hello"))).toString(), "text/plain");
  assert.equal(
    (
      await ripstream.detect(encoder.encode("%PDF-1.7"), { filename: "x.pdf" })
    ).toString(),
    "application/pdf",
  );
});

test("parses plain text end to end", async () => {
  const result = await ripstream.parse(encoder.encode("hello\nworld"));
  assert.equal(result.text, "hello\nworld\n");
  // Tika's TXTParser writes `<incoming type>; charset=<detected>`, and Mojibuster detects pure ASCII as windows-1252.
  assert.equal(result.metadata.get("Content-Type"), "text/plain; charset=windows-1252");
  assert.equal(result.metadata.get("Content-Encoding"), "windows-1252");
});

test("parses UTF-8 text", async () => {
  assert.equal(await ripstream.parseToString(encoder.encode("héllo")), "héllo\n");
});

test("UTF-8 text with a non-ASCII character is reported as UTF-8", async () => {
  const result = await ripstream.parse(encoder.encode("héllo"));
  assert.equal(result.metadata.get("Content-Type"), "text/plain; charset=UTF-8");
  assert.equal(result.metadata.get("Content-Encoding"), "UTF-8");
});

test("a text subtype keeps its own type and gains the charset", async () => {
  const json = await ripstream.parse(encoder.encode('{"a":1}'), { filename: "data.json" });
  assert.equal(json.metadata.get("Content-Type"), "application/json; charset=windows-1252");
  const python = await ripstream.parse(encoder.encode("print(1)\n"), { filename: "a.py" });
  assert.equal(python.metadata.get("Content-Type"), "text/x-python; charset=windows-1252");
});

test("Java and C++ source keep the bare type: Tika's SourceCodeParser writes no charset to Content-Type", async () => {
  const java = await ripstream.parse(encoder.encode("class A {}\n"), { filename: "A.java" });
  assert.equal(java.metadata.get("Content-Type"), "text/x-java-source");
  assert.equal(java.metadata.get("Content-Encoding"), "windows-1252");
  const cpp = await ripstream.parse(encoder.encode("int main() {}\n"), { filename: "a.cpp" });
  assert.equal(cpp.metadata.get("Content-Type"), "text/x-c++src");
});

test("a recursive record's mediaType is the bare type while its metadata carries the charset", async () => {
  const [container] = await ripstream.parseRecursive(encoder.encode("hello"));
  assert.equal(container?.mediaType.toString(), "text/plain");
  assert.equal(container?.metadata.get("Content-Type"), "text/plain; charset=windows-1252");
});

test("withCharset replaces the incoming charset and keeps its other parameters", async () => {
  const { withCharset } = await import("../src/charset.ts");
  assert.equal(withCharset("text/plain; charset=utf-16; format=flowed", "text/plain", "windows-1252"), "text/plain; charset=windows-1252; format=flowed");
  assert.equal(withCharset(null, "text/plain", "UTF-8"), "text/plain; charset=UTF-8");
  assert.equal(withCharset("not a type", "text/plain", "UTF-8"), "text/plain; charset=UTF-8");
});

test("unsupported binary throws", async () => {
  const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
  await assert.rejects(ripstream.parseToString(binary), UnsupportedFormatError);
});

test("parseToStream yields text chunks", async () => {
  const reader = ripstream.parseToStream(encoder.encode("streamed")).getReader();
  let output = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  assert.equal(output, "streamed\n");
});

test("passes structured text and source types through", async () => {
  for (const [filename, body] of [
    ["data.json", '{"a":1}'],
    ["config.yaml", "a: 1"],
    ["Main.java", "class Main {}"],
  ] as const) {
    const result = await ripstream.parse(new TextEncoder().encode(body), { filename });
    assert.match(result.text, new RegExp(body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("passes vCard and iCalendar text through", async () => {
  const vcard = "BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nEND:VCARD";
  const card = await ripstream.parse(new TextEncoder().encode(vcard), { filename: "a.vcf" });
  assert.match(card.text, /Ada Lovelace/);
  const ics = "BEGIN:VCALENDAR\nSUMMARY:Meeting\nEND:VCALENDAR";
  const calendar = await ripstream.parse(new TextEncoder().encode(ics), { filename: "a.ics" });
  assert.match(calendar.text, /Meeting/);
});

test("splits lines across chunk boundaries including split CRLF", async () => {
  const input = new TextEncoder().encode("ab\r\ncd\ref\n\ngh");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // chunk boundaries fall mid-line and between \r and \n
      controller.enqueue(input.slice(0, 3));
      controller.enqueue(input.slice(3, 4));
      controller.enqueue(input.slice(4, 8));
      controller.enqueue(input.slice(8));
      controller.close();
    },
  });
  const result = await ripstream.parse(stream);
  assert.equal(result.text, "ab\ncd\nef\n\ngh\n");
});

test("falls back to UTF-8 for an unsupported charset label", async () => {
  const doc = '<?xml version="1.0" encoding="UTF-32"?><rss version="2.0"><channel><title>t</title></channel></rss>';
  const result = await ripstream.parse(encoder.encode(doc));
  assert.equal(result.metadata.get("Content-Encoding"), "utf-8");
});

test("createDecoder falls back to utf-8 for labels TextDecoder rejects", async () => {
  const { createDecoder } = await import("../src/charset.ts");
  const fallback = createDecoder("utf-32");
  assert.equal(fallback.charset, "utf-8");
  assert.equal(fallback.decoder.decode(encoder.encode("ok")), "ok");
  assert.equal(createDecoder("utf-16le").charset, "utf-16le");
});

test("unregistered text/* subtypes fall back to the text parser", async () => {
  for (const filename of ["a.log", "a.ini", "a.rb"]) {
    const result = await ripstream.parse(encoder.encode("echo hi\n"), { filename });
    assert.match(String(result.metadata.get("Content-Type")), /^text\/x-/, filename);
    assert.equal(result.text.trim(), "echo hi", filename);
  }
});

test("text/* fallback does not take over specialized text parsers", async () => {
  const html = await ripstream.parse(encoder.encode("<html><body><p>hi</p></body></html>"), {
    filename: "a.html",
  });
  assert.equal(html.text.trim(), "hi");
  const csv = await ripstream.parse(encoder.encode("a,b\n1,2\n"), { filename: "a.csv" });
  assert.match(csv.text, /a\tb/, "csv must be parsed as a table, not raw text");
});

test("shell scripts (application/x-sh) parse as text", async () => {
  const result = await ripstream.parse(encoder.encode("#!/bin/sh\necho hi\n"), { filename: "run.sh" });
  assert.match(result.text, /echo hi/);
});
