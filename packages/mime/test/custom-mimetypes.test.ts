import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MediaType, Metadata, ParseContext, RipstreamConfigError, RipstreamInputStream, loadConfig } from "@spikedpunch/ripstream-core";
import { DefaultDetector, parseCustomMimeTypes } from "../src/index.ts";

/*
 * A custom-mimetypes file is Tika's: the same freedesktop mime-info XML as tika-mimetypes.xml, read after it, so a type
 * that is already there gains the new globs, aliases, root elements and magic and a new type is added
 * (MimeTypesFactory and MimeTypesReader, tika-core 4.2.0). Where Tika is lenient and the mistake would change nothing
 * (a misspelled element, a glob without a pattern) or fail at the first detect (a match of an unknown type), the file
 * is refused by name. The behaviour below is read from Tika's source, not run against a Tika.
 */

const encoder = new TextEncoder();
/** Not text, so the name is what decides: a name only specialises what the content already says. */
const BINARY = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]);
const info = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?><mime-info>${body}</mime-info>`;

const SAMPLE = info(`
  <mime-type type="application/x-acme-report">
    <_comment>Acme report</_comment>
    <alias type="application/x-acme"/>
    <sub-class-of type="application/xml"/>
    <glob pattern="*.acme"/>
    <glob pattern="ACME-INDEX"/>
    <glob pattern="report-\\d{4}\\.rpt" isregex="true"/>
    <root-XML localName="acme-report" namespaceURI="urn:acme"/>
    <magic priority="60">
      <match value="ACMERPT" type="string" offset="0"/>
    </magic>
  </mime-type>`);

async function detect(detector: DefaultDetector, bytes: Uint8Array, filename?: string): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 128 });
  try {
    const metadata = new Metadata();
    if (filename !== undefined) metadata.set("resourceName", filename);
    return (await detector.detect(stream, metadata, new ParseContext())).toString();
  } finally {
    await stream.close();
  }
}

const withTypes = (xml: string): DefaultDetector => new DefaultDetector({ customMimeTypes: xml });
const issuesOf = (xml: string): readonly string[] => {
  try {
    parseCustomMimeTypes(xml, "types.xml");
  } catch (error) {
    if (error instanceof RipstreamConfigError) return error.issues;
    throw error;
  }
  assert.fail("the definitions were accepted");
};

test("a custom type is found by magic, by every kind of name, by alias and by XML root", async () => {
  const detector = withTypes(SAMPLE);
  assert.equal(await detect(detector, encoder.encode("ACMERPT 1.0 ...")), "application/x-acme-report");
  assert.equal(await detect(detector, BINARY, "q.acme"), "application/x-acme-report");
  assert.equal(await detect(detector, BINARY, "ACME-INDEX"), "application/x-acme-report");
  assert.equal(await detect(detector, BINARY, "report-2024.rpt"), "application/x-acme-report");
  assert.equal(await detect(detector, BINARY, "report-24.rpt"), "application/octet-stream");
  assert.equal(await detect(detector, encoder.encode(`<?xml version="1.0"?><acme-report xmlns="urn:acme"/>`)), "application/x-acme-report");
  const registry = detector.getMediaTypeRegistry();
  assert.equal(registry.normalize(MediaType.parseOrThrow("application/x-acme"))?.toString(), "application/x-acme-report");
  assert.equal(registry.getSupertype(MediaType.parseOrThrow("application/x-acme-report"))?.toString(), "application/xml");
});

test("without the file nothing of it exists", async () => {
  const detector = new DefaultDetector();
  assert.notEqual(await detect(detector, BINARY, "q.acme"), "application/x-acme-report");
});

test("a type Tika already has gains the new definitions and keeps its own", async () => {
  const detector = withTypes(
    info(`<mime-type type="application/pdf"><glob pattern="*.mypdf"/><magic priority="50"><match value="%MYPDF" type="string" offset="0"/></magic></mime-type>`),
  );
  assert.equal(await detect(detector, BINARY, "x.mypdf"), "application/pdf");
  assert.equal(await detect(detector, encoder.encode("%MYPDF-1.0")), "application/pdf");
  assert.equal(await detect(detector, encoder.encode("%PDF-1.7\n")), "application/pdf");
  assert.equal(await detect(detector, BINARY, "x.pdf"), "application/pdf");
});

test("a type named by an alias of an existing type merges into that type", async () => {
  // application/x-pdf is an alias of application/pdf in Tika's registry; forName normalizes through aliases.
  const detector = withTypes(info(`<mime-type type="application/x-pdf"><glob pattern="*.zpdf"/></mime-type>`));
  assert.equal(await detect(detector, BINARY, "x.zpdf"), "application/pdf");
});

test("custom magic obeys priority: a higher band beats Tika's lower one", async () => {
  const detector = withTypes(
    info(`<mime-type type="application/x-loud"><magic priority="90"><match value="%PDF-" type="string" offset="0"/></magic></mime-type>`),
  );
  assert.equal(await detect(detector, encoder.encode("%PDF-1.7\n")), "application/x-loud");
});

test("a match can be a masked number or a range, with sub-matches", async () => {
  const detector = withTypes(
    info(`<mime-type type="application/x-bin">
      <magic priority="70">
        <match value="0xCAFE" type="big16" offset="0" mask="0xFFFF"><match value="Z" type="string" offset="2:6"/></match>
      </magic></mime-type>`),
  );
  assert.equal(await detect(detector, Uint8Array.from([0xca, 0xfe, 0, 0, 0x5a])), "application/x-bin");
  assert.notEqual(await detect(detector, Uint8Array.from([0xca, 0xfe, 0, 0, 0, 0, 0, 0x5a])), "application/x-bin");
});

test("a byte order mark and an XML declaration are read through", () => {
  assert.equal(parseCustomMimeTypes(`﻿${SAMPLE}`, "types.xml").length, 1);
});

test("a glob a custom type shares with an unrelated type is a conflict; with a general type the general type keeps it", () => {
  assert.throws(() => withTypes(info(`<mime-type type="application/x-mine"><glob pattern="*.pdf"/></mime-type>`)), (error) => {
    assert.ok(error instanceof RipstreamConfigError);
    assert.match(error.message, /Conflicting extension pattern: \.pdf/);
    return true;
  });
  const detector = withTypes(
    info(`<mime-type type="application/x-mine+xml"><sub-class-of type="application/xml"/><glob pattern="*.xml"/></mime-type>`),
  );
  // The more general type holds the pattern, as in Tika's Patterns.add.
  return detect(detector, BINARY, "a.xml").then((type) => assert.equal(type, "application/xml"));
});

test("a regular expression a runtime cannot run is refused with its type", () => {
  assert.throws(
    () => withTypes(info(`<mime-type type="application/x-bad"><glob pattern="(unclosed" isregex="true"/></mime-type>`)),
    /glob regular expression "\(unclosed" of application\/x-bad cannot be run/,
  );
  assert.throws(
    () => withTypes(info(`<mime-type type="application/x-bad"><magic><match type="regex" value="(unclosed" offset="0"/></magic></mime-type>`)),
    /magic regular expression of application\/x-bad/,
  );
});

test("a malformed file is refused by name, every mistake in one error", () => {
  const issues = issuesOf(
    info(`
    <mime-type><glob pattern="*.a"/></mime-type>
    <mime-type type="not a type"/>
    <mime-type type="application/x-one">
      <glop pattern="*.b"/>
      <glob/>
      <glob pattern="*.c" isregex="maybe"/>
      <alias/>
      <sub-class-of type="///"/>
      <root-XML namespaceURI="urn:x"/>
      <magic priority="high">
        <match value="x" type="wide" offset="0"/>
        <match value="x" offset="left"/>
        <match type="big16" value="12AB" offset="0"/>
        <match offset="0"/>
        <glob pattern="*.d"/>
      </magic>
    </mime-type>
    <other/>`),
  );
  const text = issues.join("\n");
  for (const expected of [
    "<mime-type> needs a type attribute",
    '<mime-type> type "not a type" is not a media type',
    "<glop> is not a <mime-type> child ripstream knows",
    "<glob> needs a pattern attribute",
    '<glob> isregex "maybe" is neither true nor false',
    "<alias> needs a type attribute",
    '<sub-class-of> type "///" is not a media type',
    "<root-XML> needs a localName attribute",
    '<magic> priority "high" is not a non-negative integer',
    '<match> type "wide" is not one of',
    '<match> offset "left" is not N or N:M',
    '<match> value "12AB" is not octal (or 0x hexadecimal) for type big16',
    "<match> needs a value attribute",
    "<glob> is not a <magic> child (expected <match>)",
    "<other> is not a <mime-info> child ripstream knows (expected <mime-type>)",
  ]) {
    assert.ok(text.includes(expected), `missing "${expected}" in:\n${text}`);
  }
  assert.match(issues[0] ?? "", /^types\.xml:\d+: /);
});

test("text that is not XML, a wrong root, an empty document and a truncated one are refused", () => {
  assert.match(issuesOf("this is not xml").join(), /not well-formed XML/);
  assert.match(issuesOf(`<types/>`).join(), /root element is <types>, not <mime-info>/);
  assert.match(issuesOf("").join(), /not well-formed XML: .*root element/);
  assert.match(issuesOf(`<mime-info><mime-type type="a/b">`).join(), /not well-formed XML/);
});

test("the descriptive elements of Tika's own file are read and have no effect", () => {
  const [entry] = parseCustomMimeTypes(
    info(`<mime-type type="application/x-doc"><_comment>Doc</_comment><acronym>D</acronym><expanded-acronym>Document</expanded-acronym><tika:link>http://x</tika:link><tika:uti>public.x</tika:uti></mime-type>`),
    "types.xml",
  );
  assert.equal(entry?.description, "Doc");
});

test("a configuration names the file; it is read from the working directory's path and its types apply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "custom-mimetypes-"));
  const path = join(directory, "custom-mimetypes.xml");
  await writeFile(path, SAMPLE);
  const config = loadConfig({ "custom-mimetypes": path });
  assert.equal(config.customMimeTypes, path);
  assert.equal(await detect(new DefaultDetector({ config }), BINARY, "q.acme"), "application/x-acme-report");
  // The text given beside it is used instead of reading the path.
  const text = info(`<mime-type type="application/x-other"><glob pattern="*.other"/></mime-type>`);
  const instead = new DefaultDetector({ config, customMimeTypes: text });
  assert.equal(await detect(instead, BINARY, "q.other"), "application/x-other");
  assert.notEqual(await detect(instead, BINARY, "q.acme"), "application/x-acme-report");
});

test("a file that is missing, and a value that is not a path, are refused", () => {
  const missing = loadConfig({ "custom-mimetypes": "/nonexistent/custom-mimetypes.xml" });
  assert.throws(() => new DefaultDetector({ config: missing }), /custom-mimetypes: the file "\/nonexistent\/custom-mimetypes\.xml" does not exist/);
  for (const value of ["", 3, null, ["a.xml"], { path: "a.xml" }]) {
    assert.throws(() => loadConfig({ "custom-mimetypes": value }), /"custom-mimetypes" must be the path of a custom-mimetypes\.xml/);
  }
});
