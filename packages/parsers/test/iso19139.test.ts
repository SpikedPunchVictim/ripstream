import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BodyContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  ToXMLContentHandler,
} from "@spikedpunch/ripstream-core";
import { GeographicInformationParser } from "../src/iso19139.ts";

/*
 * Tika's GeographicInformationParser (tika-parser-scientific-module) and GeographicInformationParserTest. Tika hands the file to
 * Apache SIS, which unmarshals ISO 19139 into its ISO 19115 model, and reads that model; SIS is not in the Tika tree, so the
 * values Tika's test asserts (the type, UTF-8, the https / browser / name of the online resource, the four bounding-box rows,
 * the title in the text) are asserted as they are, and everything else is derived by reading GeographicInformationParser.java
 * against the ISO 19139 schema. Read from Tika source, not run against a Tika, and not run against SIS.
 */

const fixture = (name: string): Uint8Array => readFileSync(fileURLToPath(new URL(`./fixtures/scientific/${name}`, import.meta.url)));
const encoder = new TextEncoder();

async function parseXml(
  bytes: Uint8Array | string,
  parser: GeographicInformationParser = new GeographicInformationParser(),
): Promise<{ xml: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(typeof bytes === "string" ? encoder.encode(bytes) : bytes);
  const handler = new ToXMLContentHandler();
  const metadata = new Metadata();
  try {
    await parser.parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { xml: handler.toString(), metadata };
}

const NAMESPACES =
  'xmlns:gmd="http://www.isotc211.org/2005/gmd" xmlns:gco="http://www.isotc211.org/2005/gco" xmlns:gmx="http://www.isotc211.org/2005/gmx" ' +
  'xmlns:srv="http://www.isotc211.org/2005/srv" xmlns:xlink="http://www.w3.org/1999/xlink"';
const cs = (text: string): string => `<gco:CharacterString>${text}</gco:CharacterString>`;
const code = (element: string, value: string): string => `<gmd:${element} codeListValue="${value}">${value}</gmd:${element}>`;
const citation = (title: string | null): string =>
  `<gmd:citation><gmd:CI_Citation>${title === null ? "" : `<gmd:title>${cs(title)}</gmd:title>`}</gmd:CI_Citation></gmd:citation>`;
const BASIC = `${citation("T")}<gmd:abstract>${cs("A")}</gmd:abstract>`;
const DISTRIBUTION = "<gmd:distributionInfo><gmd:MD_Distribution/></gmd:distributionInfo>";
const identification = (inner: string): string =>
  `<gmd:identificationInfo><gmd:MD_DataIdentification>${inner}</gmd:MD_DataIdentification></gmd:identificationInfo>`;
const document = (body: string, distribution: string = DISTRIBUTION): string =>
  `<?xml version="1.0" encoding="UTF-8"?><gmd:MD_Metadata ${NAMESPACES}>${body}${distribution}</gmd:MD_Metadata>`;
/** One MD_DataIdentification holding `inner` after a title and an abstract. */
const withIdentification = (inner: string): string => document(identification(BASIC + inner));

const all = (metadata: Metadata, key: string): string[] => [...metadata.getAll(key)];


test("the parser claims text/iso19139+xml", () => {
  assert.deepEqual([...new GeographicInformationParser().getSupportedTypes()].map(String), ["text/iso19139+xml"]);
});

test("GeographicInformationParserTest.testISO19139: sampleFile.iso19139", async () => {
  const { xml, metadata } = await parseXml(fixture("sampleFile.iso19139"));
  assert.equal(metadata.get("Content-Type"), "text/iso19139+xml");
  assert.equal(metadata.get("iso19115:character-set"), "UTF-8");
  assert.equal(metadata.get("iso19115:transfer-options-online-protocol"), "https");
  assert.equal(metadata.get("iso19115:transfer-options-online-profile"), "browser");
  assert.equal(metadata.get("iso19115:transfer-options-online-name"), "Barrow Atqasuk ARCSS Plant");

  assert.ok(xml.includes("Barrow Atqasuk ARCSS Plant"));
  assert.ok(xml.includes("<td>GeographicElementWestBoundLatitude</td>\t<td>-157.24</td>"), xml.slice(-900));
  assert.ok(xml.includes("<td>GeographicElementEastBoundLatitude</td>\t<td>-156.4</td>"));
  assert.ok(xml.includes("<td>GeographicElementNorthBoundLatitude</td>\t<td>71.18</td>"));
  assert.ok(xml.includes("<td>GeographicElementSouthBoundLatitude</td>\t<td>70.27</td>"));
});

test("sampleFile.iso19139: every other iso19115: key GeographicInformationParser.java writes (derived, not asserted by Tika's test)", async () => {
  const { metadata } = await parseXml(fixture("sampleFile.iso19139"));
  const REVISION = (date: string): string => `REVISION-->${date}T00:00:00Z`;
  const expected: Record<string, string[]> = {
    "dc:title": ["Barrow Atqasuk ARCSS Plant"],
    "dc:language": ["English"],
    "iso19115:character-set": ["UTF-8"],
    "iso19115:contact-role": ["RESOURCE_PROVIDER"],
    "iso19115:contact-party-name": ["UCAR/NCAR - CISL - ACADIS"],
    "iso19115:citation-date": ["CREATION-->2013-12-16T00:00:00Z", "MODIFIED-->2015-03-11T00:00:00Z"],
    "iso19115:cited-responsible-party-role": ["POINT_OF_CONTACT", "AUTHOR"],
    "iso19115:cited-responsible-party-name": ["Robert Hollister", "Robert Hollister"],
    "iso19115:cited-responsible-party-email": ["hollistr@gvsu.edu"],
    "iso19115:identification-info-status": ["ON_GOING"],
    "iso19115:resource-format-specification-alternative-title": ["Other ASCII"],
    "iso19115:identification-info-topic-category": ["BIOTA"],
    // The keyword groups are numbered from 2: Tika increments its counter before it uses it.
    "iso19115:keywords:2": ["EARTH SCIENCE > BIOSPHERE > TERRESTRIAL ECOSYSTEMS > ALPINE/TUNDRA"],
    "iso19115:keywords:3": ["FIELD SURVEY"],
    "iso19115:keywords:4": ["POINT"],
    "iso19115:keywords:5": ["LESS THAN 1 METER"],
    "iso19115:keywords:6": ["DAILY TO WEEKLY"],
    "iso19115:keywords-type:2": ["THEME"],
    "iso19115:keywords-type:6": ["THEME"],
    "iso19115:thesaurus-name-title:2": ["NASA/GCMD Earth Science Keywords"],
    "iso19115:thesaurus-name-title:3": ["ACADIS Keywords"],
    // The alternate titles are written as the collection prints: in square brackets.
    "iso19115:thesaurus-name-alternative-title:2": ["[Science and Services Keywords]"],
    "iso19115:thesaurus-name-alternative-title:6": ["[Temporal Data Resolution]"],
    "iso19115:thesaurus-name-date": [
      REVISION("2014-05-21"),
      REVISION("2014-10-07"),
      REVISION("2014-10-07"),
      REVISION("2014-05-21"),
      REVISION("2014-05-21"),
    ],
    "iso19115:access-constraints": ["OTHER_RESTRICTIONS"],
    "iso19115:other-constraints": ["Access Constraints: No Access Constraints. Use Constraints: No Use Constraints."],
    "iso19115:use-constraints": ["OTHER_RESTRICTIONS"],
    "iso19115:geographic-identifier-code": ["UNITED STATES OF AMERICA > ALASKA"],
    "iso19115:geographic-identifier-authority-title": ["NASA/GCMD Earth Science Keywords"],
    "iso19115:geographic-identifier-authority-alternative-title": ["Locations"],
    "iso19115:geographic-identifier-authority-date": ["REVISION 2014-08-28T00:00:00Z"],
    "iso19115:distribution-format-specification-alternative-title": ["Other ASCII"],
    "iso19115:distributor-contact": ["RESOURCE_PROVIDER"],
    "iso19115:distributor-organization-name": ["UCAR/NCAR - CISL - ACADIS"],
    "iso19115:transfer-options-online-linkage": ["https://www.aoncadis.org/dataset/id/4c1a919d-6690-11e3-9147-00c0f03d5b7c.html"],
    "iso19115:transfer-options-online-description": ["Metadata Link"],
    "iso19115:transfer-options-online-function": ["DOWNLOAD"],
    "iso19115:date-info": ["CREATION 2013-12-16T13:26:08Z"],
    "iso19115:metadata-resource-scope": ["DATASET"],
    "iso19115:parent-metadata-title": ["urn:x-wmo:md:org.aoncadis.www::d2e4e808-6830-11df-abb3-00c0f03d5b7c"],
    "iso19115:metadata-identifier-code": ["urn:x-wmo:md:org.aoncadis.www::4c1a919d-6690-11e3-9147-00c0f03d5b7c"],
    "iso19115:metadata-standard-title": ["ISO 19115 Geographic information - Metadata"],
    "iso19115:metadata-standard-edition": ["ISO 19115:2003(E)"],
  };
  for (const [key, values] of Object.entries(expected)) assert.deepEqual(all(metadata, key), values, key);
  assert.match(metadata.get("dc:description") ?? "", /^These files contain data representing the periodic plant measures/);
});

test("sampleFile.iso19139: the text is the title, one heading per cited party, the abstract and the four bounding-box rows", async () => {
  const { xml } = await parseXml(fixture("sampleFile.iso19139"));
  assert.ok(xml.includes("<h1>Barrow Atqasuk ARCSS Plant</h1>"));
  // The role and the name run together: Tika writes the two strings with no separator.
  assert.ok(xml.includes("CitedResponsiblePartyRole POINT_OF_CONTACTCitedResponsiblePartyName Robert Hollister"));
  assert.ok(xml.includes("CitedResponsiblePartyRole AUTHORCitedResponsiblePartyName Robert Hollister"));
  assert.ok(xml.includes("IdentificationInfoAbstract These files contain data"));
  assert.equal(xml.match(/<tr>/g)?.length, 4);
  assert.ok(xml.indexOf("WestBound") < xml.indexOf("EastBound") && xml.indexOf("EastBound") < xml.indexOf("NorthBound"));
  assert.ok(xml.indexOf("NorthBound") < xml.indexOf("SouthBound"));
});

test("a bare document: a title and an abstract, and an empty distribution", async () => {
  const { xml, metadata } = await parseXml(document(identification(BASIC)));
  assert.equal(metadata.get("dc:title"), "T");
  assert.equal(metadata.get("dc:description"), "A");
  assert.equal(metadata.get("Content-Type"), "text/iso19139+xml");
  assert.ok(xml.includes("<h1>T</h1>") && xml.includes("IdentificationInfoAbstract A"));
  assert.deepEqual(metadata.names().filter((name) => name.startsWith("iso19115:")), []);
});

test("what Tika dereferences without a null check is a malformed document here (its NullPointerException)", async () => {
  // no distributionInfo: getDistributionFormats() on null
  await assert.rejects(parseXml(document(identification(BASIC), "")), MalformedDocumentError);
  // no abstract: getAbstract().toString() in the text
  await assert.rejects(parseXml(document(identification(citation("T")))), MalformedDocumentError);
  // no title: getTitle().toString() for the heading
  await assert.rejects(parseXml(document(identification(`${citation(null)}<gmd:abstract>${cs("A")}</gmd:abstract>`))), MalformedDocumentError);
  // no citation: getCitation().getDates()
  await assert.rejects(parseXml(document(identification(`<gmd:abstract>${cs("A")}</gmd:abstract>`))), MalformedDocumentError);
  // a keyword group with no thesaurus: getThesaurusName().getDates()
  await assert.rejects(
    parseXml(withIdentification(`<gmd:descriptiveKeywords><gmd:MD_Keywords><gmd:keyword>${cs("k")}</gmd:keyword></gmd:MD_Keywords></gmd:descriptiveKeywords>`)),
    MalformedDocumentError,
  );
  // a geographic description with no authority: getAuthority().getAlternateTitles()
  await assert.rejects(
    parseXml(
      withIdentification(
        `<gmd:extent><gmd:EX_Extent><gmd:geographicElement><gmd:EX_GeographicDescription><gmd:geographicIdentifier><gmd:MD_Identifier><gmd:code>${cs("c")}</gmd:code></gmd:MD_Identifier></gmd:geographicIdentifier></gmd:EX_GeographicDescription></gmd:geographicElement></gmd:EX_Extent></gmd:extent>`,
      ),
    ),
    MalformedDocumentError,
  );
  // contact information with no address: getAddress().getElectronicMailAddresses()
  const noAddress = `<gmd:CI_ResponsibleParty><gmd:contactInfo><gmd:CI_Contact/></gmd:contactInfo><gmd:role>${code("CI_RoleCode", "author")}</gmd:role></gmd:CI_ResponsibleParty>`;
  await assert.rejects(
    parseXml(document(identification(`<gmd:citation><gmd:CI_Citation><gmd:title>${cs("T")}</gmd:title><gmd:citedResponsibleParty>${noAddress}</gmd:citedResponsibleParty></gmd:CI_Citation></gmd:citation><gmd:abstract>${cs("A")}</gmd:abstract>`))),
    MalformedDocumentError,
  );
  // a cited party with no role: getRole().toString() in the text
  const noRole = `<gmd:CI_ResponsibleParty><gmd:individualName>${cs("N")}</gmd:individualName></gmd:CI_ResponsibleParty>`;
  await assert.rejects(
    parseXml(document(identification(`<gmd:citation><gmd:CI_Citation><gmd:title>${cs("T")}</gmd:title><gmd:citedResponsibleParty>${noRole}</gmd:citedResponsibleParty></gmd:CI_Citation></gmd:citation><gmd:abstract>${cs("A")}</gmd:abstract>`))),
    MalformedDocumentError,
  );
});

test("a keyword group without alternate titles writes the empty collection, [], as Tika's toString does", async () => {
  const keywords =
    `<gmd:descriptiveKeywords><gmd:MD_Keywords><gmd:keyword>${cs("a")}</gmd:keyword><gmd:keyword>${cs("b")}</gmd:keyword>` +
    `<gmd:thesaurusName><gmd:CI_Citation><gmd:title>${cs("Thes")}</gmd:title></gmd:CI_Citation></gmd:thesaurusName></gmd:MD_Keywords></gmd:descriptiveKeywords>`;
  const { metadata } = await parseXml(withIdentification(keywords));
  assert.deepEqual(all(metadata, "iso19115:keywords:2"), ["a", "b"]);
  assert.deepEqual(all(metadata, "iso19115:thesaurus-name-alternative-title:2"), ["[]"]);
  assert.equal(metadata.get("iso19115:keywords-type:2"), null);
});

test("an identification that is not a data identification, or a constraint that is not a legal one, is a ClassCastException in Tika", async () => {
  await assert.rejects(
    parseXml(document(`<gmd:identificationInfo><srv:SV_ServiceIdentification>${BASIC}</srv:SV_ServiceIdentification></gmd:identificationInfo>`)),
    MalformedDocumentError,
  );
  await assert.rejects(
    parseXml(withIdentification("<gmd:resourceConstraints><gmd:MD_Constraints/></gmd:resourceConstraints>")),
    MalformedDocumentError,
  );
});

test("code lists are written as GeoAPI names, and the ones Tika keeps in a CodeListSet come out in code order without repeats", async () => {
  const body =
    `<gmd:status>${code("MD_ProgressCode", "underDevelopment")}</gmd:status><gmd:status>${code("MD_ProgressCode", "completed")}</gmd:status><gmd:status>${code("MD_ProgressCode", "underDevelopment")}</gmd:status>` +
    `<gmd:topicCategory><gmd:MD_TopicCategoryCode>oceans</gmd:MD_TopicCategoryCode></gmd:topicCategory><gmd:topicCategory><gmd:MD_TopicCategoryCode>farming</gmd:MD_TopicCategoryCode></gmd:topicCategory>` +
    `<gmd:resourceConstraints><gmd:MD_LegalConstraints>` +
    `<gmd:accessConstraints>${code("MD_RestrictionCode", "otherRestrictions")}</gmd:accessConstraints><gmd:accessConstraints>${code("MD_RestrictionCode", "copyright")}</gmd:accessConstraints>` +
    `<gmd:otherConstraints>${cs("first")}</gmd:otherConstraints><gmd:otherConstraints>${cs("second")}</gmd:otherConstraints>` +
    `</gmd:MD_LegalConstraints></gmd:resourceConstraints>`;
  const { metadata } = await parseXml(withIdentification(body));
  assert.deepEqual(all(metadata, "iso19115:identification-info-status"), ["COMPLETED", "UNDER_DEVELOPMENT"]);
  assert.deepEqual(all(metadata, "iso19115:identification-info-topic-category"), ["FARMING", "OCEANS"]);
  assert.deepEqual(all(metadata, "iso19115:access-constraints"), ["COPYRIGHT", "OTHER_RESTRICTIONS"]);
  // A collection of strings keeps the file's order.
  assert.deepEqual(all(metadata, "iso19115:other-constraints"), ["first", "second"]);
});

test("a code takes its value from codeListValue, and from the element's text when there is none", async () => {
  const party = (role: string): string => `<gmd:contact><gmd:CI_ResponsibleParty><gmd:role>${role}</gmd:role></gmd:CI_ResponsibleParty></gmd:contact>`;
  const { metadata } = await parseXml(
    document(
      party('<gmd:CI_RoleCode codeListValue="pointOfContact">ignored</gmd:CI_RoleCode>') +
        party("<gmd:CI_RoleCode>coAuthor</gmd:CI_RoleCode>") +
        party("<gmd:CI_RoleCode/>") +
        identification(BASIC),
    ),
  );
  assert.deepEqual(all(metadata, "iso19115:contact-role"), ["POINT_OF_CONTACT", "CO_AUTHOR"]);
});

test("the dates: a date is midnight UTC, a date-time keeps its time and zone, written to the second in UTC as DateUtils.formatDate does", async () => {
  const date = (value: string, type: string): string =>
    `<gmd:date><gmd:CI_Date><gmd:date>${value}</gmd:date><gmd:dateType>${code("CI_DateTypeCode", type)}</gmd:dateType></gmd:CI_Date></gmd:date>`;
  const dates =
    date("<gco:Date>2013-12-16</gco:Date>", "creation") +
    date("<gco:DateTime>2013-12-16T13:26:08.987Z</gco:DateTime>", "publication") +
    date("<gco:DateTime>2013-12-16T13:26:08+02:00</gco:DateTime>", "revision") +
    date("<gco:DateTime>2013-12-16T13:26:08</gco:DateTime>", "inForce");
  const { metadata } = await parseXml(
    document(identification(`<gmd:citation><gmd:CI_Citation><gmd:title>${cs("T")}</gmd:title>${dates}</gmd:CI_Citation></gmd:citation><gmd:abstract>${cs("A")}</gmd:abstract>`)),
  );
  assert.deepEqual(all(metadata, "iso19115:citation-date"), [
    "CREATION-->2013-12-16T00:00:00Z",
    "PUBLICATION-->2013-12-16T13:26:08Z",
    "REVISION-->2013-12-16T11:26:08Z",
    "IN_FORCE-->2013-12-16T13:26:08Z",
  ]);
});

test("a citation date that is not a date is Tika's NullPointerException in DateUtils.formatDate", async () => {
  const bad = `<gmd:date><gmd:CI_Date><gmd:date><gco:Date>soon</gco:Date></gmd:date><gmd:dateType>${code("CI_DateTypeCode", "creation")}</gmd:dateType></gmd:CI_Date></gmd:date>`;
  await assert.rejects(
    parseXml(document(identification(`<gmd:citation><gmd:CI_Citation><gmd:title>${cs("T")}</gmd:title>${bad}</gmd:CI_Citation></gmd:citation><gmd:abstract>${cs("A")}</gmd:abstract>`))),
    MalformedDocumentError,
  );
});

test("languages and character sets: the identification's language names are English display names, and the last wins", async () => {
  const { metadata } = await parseXml(
    document(
      `<gmd:language>${cs("fra")}</gmd:language><gmd:characterSet>${code("MD_CharacterSetCode", "utf8")}</gmd:characterSet>` +
        `<gmd:locale><gmd:PT_Locale><gmd:languageCode>${code("LanguageCode", "deu")}</gmd:languageCode><gmd:characterEncoding>${code("MD_CharacterSetCode", "8859part1")}</gmd:characterEncoding></gmd:PT_Locale></gmd:locale>` +
        identification(`${BASIC}<gmd:language>${cs("eng")}</gmd:language><gmd:language>${cs("spa")}</gmd:language>`),
    ),
  );
  assert.deepEqual(all(metadata, "iso19115:character-set"), ["UTF-8", "ISO-8859-1"]);
  assert.equal(metadata.get("dc:language"), "Spanish");
});

test("the bounding box is written as Java's String.valueOf(double): a missing side is NaN, and a number has a digit after the point", async () => {
  const box = `<gmd:extent><gmd:EX_Extent><gmd:geographicElement><gmd:EX_GeographicBoundingBox><gmd:westBoundLongitude><gco:Decimal>-10</gco:Decimal></gmd:westBoundLongitude><gmd:eastBoundLongitude><gco:Decimal>1e-4</gco:Decimal></gmd:eastBoundLongitude></gmd:EX_GeographicBoundingBox></gmd:geographicElement></gmd:EX_Extent></gmd:extent>`;
  const { xml } = await parseXml(withIdentification(box));
  assert.ok(xml.includes("<td>GeographicElementWestBoundLatitude</td>\t<td>-10.0</td>"), xml);
  assert.ok(xml.includes("<td>GeographicElementEastBoundLatitude</td>\t<td>1.0E-4</td>"));
  assert.ok(xml.includes("<td>GeographicElementNorthBoundLatitude</td>\t<td>NaN</td>"));
});

test("text is trimmed, and a gmx:Anchor stands in for a character string", async () => {
  const { metadata } = await parseXml(
    document(identification(`${citation("  Title\n  ")}<gmd:abstract><gmx:Anchor xlink:href="http://example.invalid/a">An anchor</gmx:Anchor></gmd:abstract>`)),
  );
  assert.equal(metadata.get("dc:title"), "Title");
  assert.equal(metadata.get("dc:description"), "An anchor");
});

test("a root that is not gmd:MD_Metadata, and text that is not XML, is a malformed document (Tika's UnsupportedStorageException)", async () => {
  await assert.rejects(parseXml('<?xml version="1.0"?><root/>'), MalformedDocumentError);
  await assert.rejects(parseXml(`<?xml version="1.0"?><gmd:Other ${NAMESPACES}/>`), MalformedDocumentError);
  await assert.rejects(parseXml("not xml at all"), MalformedDocumentError);
  await assert.rejects(parseXml(""), MalformedDocumentError);
});

test("GeographicInformationXxeTest: no DOCTYPE, entity, xlink or schemaLocation is fetched or leaks (nothing here can open one)", async () => {
  const xml = new TextDecoder().decode(fixture("sampleFile.iso19139"));
  const afterDeclaration = (insert: string): string => xml.replace("?>", `?>${insert}`);
  const SECRET = "SECRET_CONTENT_19139";
  const variants = [
    afterDeclaration('<!DOCTYPE gmd:MD_Metadata SYSTEM "http://127.0.0.1:9/x.dtd">'),
    afterDeclaration('<!DOCTYPE gmd:MD_Metadata SYSTEM "file:///couldnt_possibly_exist/x.dtd">'),
    afterDeclaration(`<!DOCTYPE gmd:MD_Metadata [<!ENTITY x SYSTEM "file:///etc/hosts">]>`).replace("<gco:CharacterString>", "<gco:CharacterString>&x;"),
    afterDeclaration('<!DOCTYPE gmd:MD_Metadata [<!ENTITY % p SYSTEM "http://127.0.0.1:9/p.dtd">%p;]>'),
    xml.replace("<gmd:contact>", '<gmd:contact xlink:href="http://127.0.0.1:9/contact.xml">'),
    xml.replace(/<gmd:parentIdentifier>[\s\S]*?<\/gmd:parentIdentifier>/, '<gmd:parentIdentifier xlink:href="http://127.0.0.1:9/parent.xml"/>'),
    xml.replace(/xsi:schemaLocation="[^"]*"/, 'xsi:schemaLocation="http://www.isotc211.org/2005/gmd http://127.0.0.1:9/gmd.xsd"'),
  ];
  for (const variant of variants) {
    try {
      const { xml: text } = await parseXml(variant);
      assert.ok(!text.includes(SECRET) && !text.includes("localhost"));
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, String(error));
    }
  }
  // An xlink with no body leaves the property empty, as Tika's test expects: the parent identifier is simply not there.
  const parentless = await parseXml(variants[5]!);
  assert.equal(parentless.metadata.get("iso19115:parent-metadata-title"), null);
});

test("an entity bomb is refused at once: a declared entity is never expanded", async () => {
  const bomb =
    '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
    '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>' +
    `<gmd:MD_Metadata ${NAMESPACES}><gmd:fileIdentifier>${cs("&lol3;")}</gmd:fileIdentifier></gmd:MD_Metadata>`;
  await assert.rejects(parseXml(bomb), MalformedDocumentError);
});

test("every prefix of a valid ISO 19139 file parses or is refused as malformed", async () => {
  const bytes = fixture("sampleFile.iso19139");
  const parser = new GeographicInformationParser();
  let parsed = 0;
  let refused = 0;
  // The file ends with a newline after the root's end tag, so the last two prefixes are complete documents; the rest are cut.
  for (let length = 0; length < bytes.length - 1; length += length < 400 ? 1 : 211) {
    try {
      await parseXml(bytes.subarray(0, length), parser);
      parsed++;
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix of ${length} bytes: ${String(error)}`);
      refused++;
    }
  }
  assert.equal(parsed, 0, `parsed ${parsed}`);
  assert.ok(refused > 400, `refused ${refused}`);
  await parseXml(bytes.subarray(0, bytes.length - 1), parser);
  await parseXml(bytes, parser);
});

test("a document nested deeper than maxDepth is a LimitExceededError", async () => {
  const deep = `<gmd:MD_Metadata ${NAMESPACES}>${"<gmd:x>".repeat(60)}`;
  await assert.rejects(parseXml(deep, new GeographicInformationParser({ maxDepth: 50 })), LimitExceededError);
  // And by default, before saxes' per-element namespace work turns quadratic in the depth.
  await assert.rejects(parseXml(`<a>${"<b>".repeat(20_000)}`), LimitExceededError);
});

test("a document of more elements than maxNodes is a LimitExceededError", async () => {
  const wide = `<gmd:MD_Metadata ${NAMESPACES}>${"<gmd:x/>".repeat(200)}</gmd:MD_Metadata>`;
  await assert.rejects(parseXml(wide, new GeographicInformationParser({ maxNodes: 100 })), LimitExceededError);
});

test("a file over maxBytes is a LimitExceededError, and the input is read no further than the cap", async () => {
  const parser = new GeographicInformationParser({ maxBytes: 256 });
  let pulled = 0;
  async function* endless(): AsyncGenerator<Uint8Array> {
    for (let chunks = 0; chunks < 1000; chunks++) {
      pulled += 1;
      yield encoder.encode("<gmd:x/>".repeat(100));
    }
    throw new Error("the parser read an endless input to its end");
  }
  const stream = await RipstreamInputStream.from(endless());
  await assert.rejects(parser.parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()), LimitExceededError);
  await stream.close();
  assert.ok(pulled < 5, `pulled ${pulled} chunks`);
});

test("the options are positive integers", () => {
  assert.throws(() => new GeographicInformationParser({ maxBytes: 0 }), RangeError);
  assert.throws(() => new GeographicInformationParser({ maxDepth: 1.5 }), RangeError);
  assert.throws(() => new GeographicInformationParser({ maxNodes: -1 }), RangeError);
});

test("a single-valued property that is already set is Tika's PropertyTypeException, a malformed document here", async () => {
  const parent = document(identification(BASIC).concat(`<gmd:parentIdentifier>${cs("parent")}</gmd:parentIdentifier>`));
  const stream = await RipstreamInputStream.from(encoder.encode(parent));
  const metadata = new Metadata();
  metadata.set("iso19115:parent-metadata-title", "set before the parse");
  await assert.rejects(
    new GeographicInformationParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
  // the same record parses when nothing is set
  const { metadata: fresh } = await parseXml(parent);
  assert.equal(fresh.get("iso19115:parent-metadata-title"), "parent");
});
