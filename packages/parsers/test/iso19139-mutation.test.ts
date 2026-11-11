import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  ToXMLContentHandler,
} from "@spikedpunch/ripstream-core";
import {
  DEFAULT_MAX_ISO19139_BYTES,
  DEFAULT_MAX_ISO19139_DEPTH,
  DEFAULT_MAX_ISO19139_NODES,
  GeographicInformationParser,
} from "../src/iso19139.ts";

/*
 * Behaviour of the ISO 19139 parser that iso19139.test.ts leaves open, found by mutation testing of src/iso19139.ts (a swapped
 * element name, a dropped guard, a changed table entry or limit that left iso19139.test.ts green). What Tika's
 * GeographicInformationParser.java does with the model is read from its source (cited where a test turns on a line); what Apache
 * SIS puts in that model is not in the Tika tree. Where a test pins a mapping only SIS's source could settle, the test says it
 * is an assumption: it fixes today's behaviour, it is not a reading of SIS.
 */

const encoder = new TextEncoder();

async function run(
  bytes: Uint8Array | string,
  metadata: Metadata = new Metadata(),
  parser: GeographicInformationParser = new GeographicInformationParser(),
): Promise<{ xml: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(typeof bytes === "string" ? encoder.encode(bytes) : bytes);
  const handler = new ToXMLContentHandler();
  try {
    await parser.parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { xml: handler.toString(), metadata };
}

const NAMESPACES =
  'xmlns:gmd="http://www.isotc211.org/2005/gmd" xmlns:gco="http://www.isotc211.org/2005/gco" xmlns:gmx="http://www.isotc211.org/2005/gmx" ' +
  'xmlns:srv="http://www.isotc211.org/2005/srv" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:other="urn:other"';
const cs = (text: string): string => `<gco:CharacterString>${text}</gco:CharacterString>`;
const code = (element: string, value: string): string => `<gmd:${element} codeListValue="${value}">${value}</gmd:${element}>`;
const prop = (name: string, inner: string): string => `<gmd:${name}>${inner}</gmd:${name}>`;
const citation = (inner: string): string => prop("citation", `<gmd:CI_Citation>${inner}</gmd:CI_Citation>`);
const title = (text: string): string => prop("title", cs(text));
const BASIC = `${citation(title("T"))}${prop("abstract", cs("A"))}`;
const DISTRIBUTION = "<gmd:distributionInfo><gmd:MD_Distribution/></gmd:distributionInfo>";
const identification = (inner: string): string => prop("identificationInfo", `<gmd:MD_DataIdentification>${inner}</gmd:MD_DataIdentification>`);
const record = (body: string, distribution: string = DISTRIBUTION): string =>
  `<?xml version="1.0" encoding="UTF-8"?><gmd:MD_Metadata ${NAMESPACES}>${body}${distribution}</gmd:MD_Metadata>`;
/** A record whose one identification holds `inner` after a title and an abstract. */
const withIdentification = (inner: string): string => record(identification(BASIC + inner));
const dateEntry = (value: string, type: string | null): string =>
  prop("date", `<gmd:CI_Date>${prop("date", value)}${type === null ? "" : prop("dateType", code("CI_DateTypeCode", type))}</gmd:CI_Date>`);
const party = (inner: string): string => `<gmd:CI_ResponsibleParty>${inner}</gmd:CI_ResponsibleParty>`;
const role = (value: string): string => prop("role", code("CI_RoleCode", value));
const email = (text: string): string => prop("contactInfo", `<gmd:CI_Contact>${prop("address", `<gmd:CI_Address>${prop("electronicMailAddress", cs(text))}</gmd:CI_Address>`)}</gmd:CI_Contact>`);
/** An identification whose citation carries `inner` after the title. */
const withCitation = (inner: string): string => record(identification(`${citation(title("T") + inner)}${prop("abstract", cs("A"))}`));
const names = (metadata: Metadata): string[] => metadata.names().filter((name) => name.startsWith("iso19115:"));
const all = (metadata: Metadata, key: string): string[] => [...metadata.getAll(key)];

// ---- limits ----

test("the default limits: 16 MiB, 2000 open elements, one million elements", () => {
  assert.equal(DEFAULT_MAX_ISO19139_BYTES, 16 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_ISO19139_DEPTH, 2000);
  assert.equal(DEFAULT_MAX_ISO19139_NODES, 1_000_000);
});

test("the default depth: 2000 open elements are read (and found unclosed), the 2001st is a LimitExceededError", async () => {
  const open = (count: number): string => `<gmd:MD_Metadata ${NAMESPACES}>${"<gmd:x>".repeat(count - 1)}`;
  await assert.rejects(run(open(2000)), (error: unknown) => error instanceof MalformedDocumentError && !(error instanceof LimitExceededError));
  await assert.rejects(run(open(2001)), LimitExceededError);
});

test("maxDepth counts the root: with 3, three nested elements are read and a fourth is refused", async () => {
  const parser = new GeographicInformationParser({ maxDepth: 3 });
  const nested = (count: number): string => `<gmd:MD_Metadata ${NAMESPACES}>${"<gmd:x>".repeat(count - 1)}`;
  await assert.rejects(run(nested(3), new Metadata(), parser), (error: unknown) => error instanceof MalformedDocumentError && !(error instanceof LimitExceededError));
  await assert.rejects(run(nested(4), new Metadata(), parser), LimitExceededError);
});

test("maxNodes counts every element including the root: 100 are read, the 101st is refused", async () => {
  const parser = new GeographicInformationParser({ maxNodes: 100 });
  const siblings = (count: number): string => `<gmd:MD_Metadata ${NAMESPACES}>${"<gmd:x/>".repeat(count - 1)}</gmd:MD_Metadata>`;
  // 100 elements parse as XML and then fail the NullPointerException check for the missing distributionInfo, not the cap.
  await assert.rejects(run(siblings(100), new Metadata(), parser), (error: unknown) => error instanceof MalformedDocumentError && !(error instanceof LimitExceededError));
  await assert.rejects(run(siblings(101), new Metadata(), parser), LimitExceededError);
});

test("the default element cap is one million", async () => {
  const wide = (count: number): string => `<gmd:MD_Metadata ${NAMESPACES}>${"<a/>".repeat(count - 1)}</gmd:MD_Metadata>`;
  await assert.rejects(run(wide(1_000_001)), LimitExceededError);
});

test("the byte cap is exact: a file of maxBytes bytes is read, one more byte is a LimitExceededError", async () => {
  const text = record(identification(BASIC));
  const size = encoder.encode(text).length;
  await run(text, new Metadata(), new GeographicInformationParser({ maxBytes: size }));
  await assert.rejects(run(text, new Metadata(), new GeographicInformationParser({ maxBytes: size - 1 })), LimitExceededError);
});

// ---- the root, the text, the tree ----

test("a document with no root element is malformed (empty, blank, or only a declaration or a comment)", async () => {
  for (const text of ["", "   ", '<?xml version="1.0"?>', "<!-- c -->"]) {
    await assert.rejects(run(text), (error: unknown) => error instanceof MalformedDocumentError && /Malformed XML/.test((error as Error).message), JSON.stringify(text));
  }
});


test("the root must be gmd:MD_Metadata in the gmd namespace: another namespace or another name is refused", async () => {
  const body = `${identification(BASIC)}${DISTRIBUTION}`;
  await run(`<gmd:MD_Metadata ${NAMESPACES}>${body}</gmd:MD_Metadata>`);
  await assert.rejects(run(`<MD_Metadata>${body}</MD_Metadata>`), MalformedDocumentError);
  await assert.rejects(run(`<o:MD_Metadata xmlns:o="urn:other">${body}</o:MD_Metadata>`), MalformedDocumentError);
  // The right namespace and another name: the record would otherwise read in full, so only the root check can refuse it.
  await assert.rejects(run(`<gmd:MD_Metadata2 ${NAMESPACES}>${body}</gmd:MD_Metadata2>`), (error: unknown) => error instanceof MalformedDocumentError && /root element/.test((error as Error).message));
  await assert.rejects(run(`<o:MD_Metadata xmlns:o="urn:other" ${NAMESPACES}>${body}</o:MD_Metadata>`), (error: unknown) => error instanceof MalformedDocumentError && /root element/.test((error as Error).message));
});

test("a namespace declaration is not an attribute: a prefix named codeListValue cannot supply a code", async () => {
  const withDeclaration = `<gmd:contact><gmd:CI_ResponsibleParty><gmd:role><gmd:CI_RoleCode xmlns:codeListValue="urn:not-a-code">author</gmd:CI_RoleCode></gmd:role></gmd:CI_ResponsibleParty></gmd:contact>`;
  const { metadata } = await run(record(withDeclaration + identification(BASIC)));
  assert.deepEqual(all(metadata, "iso19115:contact-role"), ["AUTHOR"]);
});

test("a declared character set is honoured wherever the XML declaration sits in the first bytes", async () => {
  const text = record(identification(`${citation(title("café été"))}${prop("abstract", cs("A"))}`)).replace('encoding="UTF-8"', 'encoding="ISO-8859-1"');
  const bytes = Uint8Array.from(Array.from(text, (character) => character.charCodeAt(0)));
  assert.equal((await run(bytes)).metadata.get("dc:title"), "café été");
});

test("CDATA is text", async () => {
  const { metadata } = await run(record(identification(`${citation(prop("title", "<gco:CharacterString><![CDATA[T & <U>]]></gco:CharacterString>"))}${prop("abstract", cs("A"))}`)));
  assert.equal(metadata.get("dc:title"), "T & <U>");
});

test("the first error saxes finds is the cause of the malformed document", async () => {
  try {
    await run(`<gmd:MD_Metadata ${NAMESPACES}><a></b></gmd:MD_Metadata>`);
    assert.fail("read");
  } catch (error) {
    assert.ok(error instanceof MalformedDocumentError);
    assert.ok(error.cause instanceof Error);
    assert.match(error.cause.message, /unexpected close tag|<a>|b/i);
  }
});

test("elements are found by name, in any order among their siblings", async () => {
  const reversed = record(
    identification(
      [
        prop("topicCategory", "<gmd:MD_TopicCategoryCode>oceans</gmd:MD_TopicCategoryCode>"),
        prop("status", code("MD_ProgressCode", "planned")),
        prop("abstract", cs("A")),
        citation(prop("alternateTitle", cs("alt")) + title("T")),
      ].join(""),
    ),
    DISTRIBUTION,
  );
  const { metadata } = await run(`<?xml version="1.0"?>${reversed.replace('<?xml version="1.0" encoding="UTF-8"?>', "")}`);
  assert.equal(metadata.get("dc:title"), "T");
  assert.equal(metadata.get("dc:description"), "A");
  assert.deepEqual(all(metadata, "iso19115:identification-info-status"), ["PLANNED"]);
  assert.deepEqual(all(metadata, "iso19115:identification-info-topic-category"), ["OCEANS"]);
});

test("a property that occurs twice where one is allowed reads the first (an assumption: SIS's JAXB binding may keep the last)", async () => {
  const { metadata } = await run(
    record(identification(`${citation(title("First") + title("Second"))}${prop("abstract", cs("A1"))}${prop("abstract", cs("A2"))}`)),
  );
  assert.equal(metadata.get("dc:title"), "First");
  assert.equal(metadata.get("dc:description"), "A1");
});

test("an element in another namespace is not the ISO element of that name", async () => {
  const foreign = (name: string, inner = ""): string => `<other:${name}>${inner}</other:${name}>`;
  // An object element in a foreign namespace wraps no object: the citation is missing, which is Tika's NullPointerException.
  await assert.rejects(run(record(identification(`${prop("citation", foreign("CI_Citation", title("T")))}${prop("abstract", cs("A"))}`))), MalformedDocumentError);
  // A foreign CharacterString and a foreign Anchor are no text.
  await assert.rejects(run(record(identification(`${citation(prop("title", foreign("CharacterString", "T")))}${prop("abstract", cs("A"))}`))), MalformedDocumentError);
  await assert.rejects(run(record(identification(`${citation(prop("title", foreign("Anchor", "T")))}${prop("abstract", cs("A"))}`))), MalformedDocumentError);
  // A foreign Date is no date: Tika's DateUtils.formatDate(null).
  await assert.rejects(
    run(withCitation(dateEntry("<other:Date>2013-12-16</other:Date>", "creation"))),
    MalformedDocumentError,
  );
  // A foreign Decimal is not a number.
  const box = `<gmd:extent><gmd:EX_Extent><gmd:geographicElement><gmd:EX_GeographicBoundingBox>${prop("westBoundLongitude", foreign("Decimal", "5"))}</gmd:EX_GeographicBoundingBox></gmd:geographicElement></gmd:EX_Extent></gmd:extent>`;
  assert.match((await run(withIdentification(box))).xml, /WestBoundLatitude<\/td>\s*<td>NaN<\/td>/);
  // A foreign MD_DataIdentification and a foreign MD_LegalConstraints are not the ISO ones: Tika's ClassCastException.
  await assert.rejects(run(record(prop("identificationInfo", `<other:MD_DataIdentification>${BASIC}</other:MD_DataIdentification>`))), MalformedDocumentError);
  await assert.rejects(run(withIdentification(prop("resourceConstraints", "<other:MD_LegalConstraints/>"))), MalformedDocumentError);
  // A foreign URL is no linkage.
  const online = (url: string): string =>
    `<gmd:distributionInfo><gmd:MD_Distribution><gmd:transferOptions><gmd:MD_DigitalTransferOptions><gmd:onLine><gmd:CI_OnlineResource>${prop("linkage", url)}${prop("protocol", cs("https"))}</gmd:CI_OnlineResource></gmd:onLine></gmd:MD_DigitalTransferOptions></gmd:transferOptions></gmd:MD_Distribution></gmd:distributionInfo>`;
  const foreignUrl = await run(record(identification(BASIC), online("<other:URL>http://x/</other:URL>")));
  assert.equal(foreignUrl.metadata.has("iso19115:transfer-options-online-linkage"), false);
  assert.equal(foreignUrl.metadata.get("iso19115:transfer-options-online-protocol"), "https");
});

test("a property in another namespace is not the gmd property of that name", async () => {
  const foreign = (name: string, inner: string): string => `<other:${name}>${inner}</other:${name}>`;
  // A foreign identificationInfo is not read as an identification.
  const noIdentification = await run(record(foreign("identificationInfo", `<gmd:MD_DataIdentification>${BASIC}</gmd:MD_DataIdentification>`)));
  assert.equal(noIdentification.metadata.has("dc:title"), false);
  // Foreign status, topicCategory, language and abstract beside the real ones add nothing.
  const beside = await run(
    withIdentification(
      `${foreign("status", code("MD_ProgressCode", "planned"))}${foreign("topicCategory", "<gmd:MD_TopicCategoryCode>oceans</gmd:MD_TopicCategoryCode>")}` +
        `${foreign("language", cs("deu"))}${foreign("abstract", cs("Foreign"))}`,
    ),
  );
  assert.equal(beside.metadata.has("iso19115:identification-info-status"), false);
  assert.equal(beside.metadata.has("iso19115:identification-info-topic-category"), false);
  assert.equal(beside.metadata.has("dc:language"), false);
  assert.equal(beside.metadata.get("dc:description"), "A");
  // A foreign distributionInfo is no distribution: Tika's NullPointerException.
  await assert.rejects(run(`<gmd:MD_Metadata ${NAMESPACES}>${identification(BASIC)}${foreign("distributionInfo", "<gmd:MD_Distribution/>")}</gmd:MD_Metadata>`), MalformedDocumentError);
});

// ---- text values ----

test("a blank character string is no value, so no metadata is written for it", async () => {
  const { metadata } = await run(
    record(
      `<gmd:contact>${party(`${role("author")}${prop("organisationName", cs("   \n "))}`)}</gmd:contact>${identification(BASIC)}`,
    ),
  );
  assert.deepEqual(all(metadata, "iso19115:contact-role"), ["AUTHOR"]);
  assert.equal(metadata.has("iso19115:contact-party-name"), false);
  // A blank title is no title: the identification has none, which is Tika's NullPointerException.
  await assert.rejects(run(record(identification(`${citation(title("  "))}${prop("abstract", cs("A"))}`))), MalformedDocumentError);
});

test("a text may be a gmd:PT_FreeText: the first localised string of its text group, trimmed", async () => {
  const free = (inner: string): string => prop("title", `<gmd:PT_FreeText>${inner}</gmd:PT_FreeText>`);
  const localised = (text: string): string => `<gmd:LocalisedCharacterString locale="#fr">${text}</gmd:LocalisedCharacterString>`;
  const text = (inner: string): string => `<gmd:textGroup>${inner}</gmd:textGroup>`;
  const read = async (property: string): Promise<string | null> =>
    (await run(record(identification(`${citation(property)}${prop("abstract", cs("A"))}`)).replace(/^/, ""))).metadata.get("dc:title");
  assert.equal(await read(free(text(localised("  Titre  ")))), "Titre");
  assert.equal(await read(free(text(localised("Un") + localised("Deux")))), "Un");
  assert.equal(await read(free(text(localised("Un")) + text(localised("Deux")))), "Un");
  // A gco:CharacterString beside the free text wins.
  assert.equal(await read(prop("title", `${cs("Plain")}<gmd:PT_FreeText>${text(localised("Libre"))}</gmd:PT_FreeText>`)), "Plain");
  // Names that are not PT_FreeText, textGroup or LocalisedCharacterString give no text.
  await assert.rejects(read(prop("title", `<gmd:PT_Free>${text(localised("x"))}</gmd:PT_Free>`)), MalformedDocumentError);
  await assert.rejects(read(prop("title", `<gmd:PT_FreeText><gmd:textGrp>${localised("x")}</gmd:textGrp></gmd:PT_FreeText>`)), MalformedDocumentError);
  await assert.rejects(read(prop("title", `<gmd:PT_FreeText>${text("<gmd:LocalizedCharacterString>x</gmd:LocalizedCharacterString>")}</gmd:PT_FreeText>`)), MalformedDocumentError);
  // A localised string of blanks is no text either.
  await assert.rejects(read(free(text(localised("   ")))), MalformedDocumentError);
});

test("a gmx:Anchor stands in for a character string and is trimmed", async () => {
  const { metadata } = await run(record(identification(`${citation(prop("title", "<gmx:Anchor>\n  Anchored  \n</gmx:Anchor>"))}${prop("abstract", cs("A"))}`)));
  assert.equal(metadata.get("dc:title"), "Anchored");
});

// ---- codes ----

test("a code read from its text is trimmed, and a code with no value is no code", async () => {
  const contact = (inner: string): string => `<gmd:contact><gmd:CI_ResponsibleParty><gmd:role>${inner}</gmd:role></gmd:CI_ResponsibleParty></gmd:contact>`;
  const { metadata } = await run(
    record(
      contact("<gmd:CI_RoleCode>\n  author\n</gmd:CI_RoleCode>") +
        contact('<gmd:CI_RoleCode codeListValue="  publisher  "/>') +
        contact('<gmd:CI_RoleCode codeListValue="   ">user</gmd:CI_RoleCode>') +
        contact("<gmd:CI_RoleCode>   </gmd:CI_RoleCode>") +
        identification(BASIC),
    ),
  );
  assert.deepEqual(all(metadata, "iso19115:contact-role"), ["AUTHOR", "PUBLISHER"]);
});

test("a code in camel case is written in upper case with an underscore at each word (an assumption: GeoAPI's CodeList.name())", async () => {
  const contact = (value: string): string => `<gmd:contact><gmd:CI_ResponsibleParty>${role(value)}</gmd:CI_ResponsibleParty></gmd:contact>`;
  const { metadata } = await run(record(contact("resourceProvider") + contact("pointOfContact") + contact("a2B") + contact("ALLCAPS") + identification(BASIC)));
  assert.deepEqual(all(metadata, "iso19115:contact-role"), ["RESOURCE_PROVIDER", "POINT_OF_CONTACT", "A2_B", "ALLCAPS"]);
});

test("progress codes come out in GeoAPI's order, each once, whatever order the file gives them", async () => {
  const statuses = ["underDevelopment", "required", "planned", "onGoing", "obsolete", "historicalArchive", "completed", "planned"];
  const { metadata } = await run(withIdentification(statuses.map((value) => prop("status", code("MD_ProgressCode", value))).join("")));
  assert.deepEqual(all(metadata, "iso19115:identification-info-status"), [
    "COMPLETED",
    "HISTORICAL_ARCHIVE",
    "OBSOLETE",
    "ON_GOING",
    "PLANNED",
    "REQUIRED",
    "UNDER_DEVELOPMENT",
  ]);
});

test("a code outside its list follows the listed ones, in file order", async () => {
  const statuses = ["zeta", "underDevelopment", "alpha", "completed"];
  const { metadata } = await run(withIdentification(statuses.map((value) => prop("status", code("MD_ProgressCode", value))).join("")));
  assert.deepEqual(all(metadata, "iso19115:identification-info-status"), ["COMPLETED", "UNDER_DEVELOPMENT", "ZETA", "ALPHA"]);
});

test("topic categories come out in ISO 19115's order, whatever order the file gives them", async () => {
  const inOrder = [
    "farming",
    "biota",
    "boundaries",
    "climatologyMeteorologyAtmosphere",
    "economy",
    "elevation",
    "environment",
    "geoscientificInformation",
    "health",
    "imageryBaseMapsEarthCover",
    "intelligenceMilitary",
    "inlandWaters",
    "location",
    "oceans",
    "planningCadastre",
    "society",
    "structure",
    "transportation",
    "utilitiesCommunication",
  ];
  const topics = [...inOrder].reverse().map((value) => prop("topicCategory", `<gmd:MD_TopicCategoryCode>${value}</gmd:MD_TopicCategoryCode>`)).join("");
  const { metadata } = await run(withIdentification(topics));
  assert.deepEqual(
    all(metadata, "iso19115:identification-info-topic-category"),
    inOrder.map((value) => value.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()),
  );
});

test("restrictions come out in ISO 19115's order for access and for use, each once, and other constraints keep the file's order", async () => {
  const inOrder = ["copyright", "patent", "patentPending", "trademark", "license", "intellectualPropertyRights", "restricted", "otherRestrictions"];
  const restrictions = (element: string, values: string[]): string => values.map((value) => prop(element, code("MD_RestrictionCode", value))).join("");
  const constraints = prop(
    "resourceConstraints",
    `<gmd:MD_LegalConstraints>${restrictions("accessConstraints", [...inOrder].reverse())}${restrictions("useConstraints", [...inOrder].reverse().concat(["patent"]))}${prop("otherConstraints", cs("z"))}${prop("otherConstraints", cs("a"))}</gmd:MD_LegalConstraints>`,
  );
  const { metadata } = await run(withIdentification(constraints));
  const expected = ["COPYRIGHT", "PATENT", "PATENT_PENDING", "TRADEMARK", "LICENSE", "INTELLECTUAL_PROPERTY_RIGHTS", "RESTRICTED", "OTHER_RESTRICTIONS"];
  assert.deepEqual(all(metadata, "iso19115:access-constraints"), expected);
  assert.deepEqual(all(metadata, "iso19115:use-constraints"), expected);
  assert.deepEqual(all(metadata, "iso19115:other-constraints"), ["z", "a"]);
});

test("access and use constraints are told apart, and each constraint group is written in turn", async () => {
  const group = (access: string, use: string, other: string): string =>
    prop(
      "resourceConstraints",
      `<gmd:MD_LegalConstraints>${prop("accessConstraints", code("MD_RestrictionCode", access))}${prop("useConstraints", code("MD_RestrictionCode", use))}${prop("otherConstraints", cs(other))}</gmd:MD_LegalConstraints>`,
    );
  const { metadata } = await run(withIdentification(group("copyright", "trademark", "o1") + group("patent", "license", "o2")));
  assert.deepEqual(all(metadata, "iso19115:access-constraints"), ["COPYRIGHT", "PATENT"]);
  assert.deepEqual(all(metadata, "iso19115:use-constraints"), ["TRADEMARK", "LICENSE"]);
  assert.deepEqual(all(metadata, "iso19115:other-constraints"), ["o1", "o2"]);
});

test("an empty property (a nilReason with no object) is skipped, not a crash", async () => {
  const { metadata } = await run(
    record(
      `<gmd:identificationInfo gco:nilReason="missing"/>${identification(BASIC + '<gmd:resourceConstraints gco:nilReason="missing"/><gmd:descriptiveKeywords gco:nilReason="missing"/>')}`,
    ),
  );
  assert.equal(metadata.get("dc:title"), "T");
});

// ---- languages and character sets ----

const locale = (language: string, characterSet: string): string =>
  prop("locale", `<gmd:PT_Locale>${prop("languageCode", code("LanguageCode", language))}${prop("characterEncoding", code("MD_CharacterSetCode", characterSet))}</gmd:PT_Locale>`);

test("every Java charset name the table knows, for the codes of MD_CharacterSetCode", async () => {
  const table: Array<[string, string, string]> = [
    ["eng", "utf8", "UTF-8"],
    ["fra", "utf16", "UTF-16"],
    ["deu", "usAscii", "US-ASCII"],
    ["spa", "shiftJIS", "Shift_JIS"],
    ["ita", "eucJP", "EUC-JP"],
    ["por", "eucKR", "EUC-KR"],
    ["nld", "big5", "Big5"],
    ["swe", "gb2312", "GB2312"],
    ["dan", "8859part1", "ISO-8859-1"],
    ["fin", "8859part2", "ISO-8859-2"],
    ["pol", "8859part3", "ISO-8859-3"],
    ["ces", "8859part4", "ISO-8859-4"],
    ["rus", "8859part5", "ISO-8859-5"],
    ["ara", "8859part6", "ISO-8859-6"],
    ["ell", "8859part7", "ISO-8859-7"],
    ["heb", "8859part8", "ISO-8859-8"],
    ["tur", "8859part9", "ISO-8859-9"],
    ["lav", "8859part13", "ISO-8859-13"],
    ["est", "8859part15", "ISO-8859-15"],
  ];
  const { metadata } = await run(record(table.map(([language, set]) => locale(language, set)).join("") + identification(BASIC)));
  assert.deepEqual(all(metadata, "iso19115:character-set"), table.map(([, , name]) => name));
});

test("a character set with no Java charset here gives none: 8859 parts 10 to 12, 14 and 16, and codes outside the list", async () => {
  const unknown = ["8859part10", "8859part11", "8859part12", "8859part14", "8859part16", "8859part0", "8859part100", "8859part", "ucs2", "ucs4", "jis", "ebcdic", "utf7", "x"];
  const languages = ["eng", "fra", "deu", "spa", "ita", "por", "nld", "swe", "dan", "fin", "pol", "ces", "rus", "ara"];
  const { metadata } = await run(record(unknown.map((set, index) => locale(languages[index]!, set)).join("") + identification(BASIC)));
  assert.equal(metadata.has("iso19115:character-set"), false);
});

test("a character set code is read in any case (an assumption: SIS's code list lookup ignores case)", async () => {
  const { metadata } = await run(record(locale("eng", "UTF8") + locale("fra", "Utf16") + identification(BASIC)));
  assert.deepEqual(all(metadata, "iso19115:character-set"), ["UTF-8", "UTF-16"]);
});

test("a language and a character set make an entry together: either alone makes none", async () => {
  const onlyLanguage = prop("locale", `<gmd:PT_Locale>${prop("languageCode", code("LanguageCode", "eng"))}</gmd:PT_Locale>`);
  const onlyCharset = prop("locale", `<gmd:PT_Locale>${prop("characterEncoding", code("MD_CharacterSetCode", "utf8"))}</gmd:PT_Locale>`);
  const { metadata } = await run(record(onlyLanguage + onlyCharset + identification(BASIC)));
  assert.equal(metadata.has("iso19115:character-set"), false);
  const rootOnly = await run(record(`${prop("characterSet", code("MD_CharacterSetCode", "utf8"))}${identification(BASIC)}`));
  assert.equal(rootOnly.metadata.has("iso19115:character-set"), false);
  const rootLanguageOnly = await run(record(`${prop("language", cs("eng"))}${identification(BASIC)}`));
  assert.equal(rootLanguageOnly.metadata.has("iso19115:character-set"), false);
});

test("the character sets are kept by the English name of their language: two codes of one language are one entry, the later value stays", async () => {
  const { metadata } = await run(
    record(`${prop("language", cs("eng"))}${prop("characterSet", code("MD_CharacterSetCode", "utf8"))}${locale("en", "8859part1")}${locale("fra", "utf8")}${identification(BASIC)}`),
  );
  assert.deepEqual(all(metadata, "iso19115:character-set"), ["ISO-8859-1", "UTF-8"]);
});

test("a locale's languageCode reads codeListValue before its text, and a gmd:language reads its character string", async () => {
  const viaAttribute = prop("locale", `<gmd:PT_Locale><gmd:languageCode><gmd:LanguageCode codeListValue="fra">eng</gmd:LanguageCode></gmd:languageCode>${prop("characterEncoding", code("MD_CharacterSetCode", "utf8"))}</gmd:PT_Locale>`);
  const viaText = prop("locale", `<gmd:PT_Locale><gmd:languageCode><gmd:LanguageCode>deu</gmd:LanguageCode></gmd:languageCode>${prop("characterEncoding", code("MD_CharacterSetCode", "utf16"))}</gmd:PT_Locale>`);
  const { metadata } = await run(record(viaAttribute + viaText + identification(`${BASIC}${prop("language", `<gmd:LanguageCode codeListValue="fra">x</gmd:LanguageCode>`)}`)));
  assert.deepEqual(all(metadata, "iso19115:character-set"), ["UTF-8", "UTF-16"]);
  assert.equal(metadata.get("dc:language"), "French");
});

test("language codes: two or three letters, case does not matter, a region after them is dropped, longer words are no code", async () => {
  const languageOf = async (value: string): Promise<string | null> =>
    (await run(record(identification(`${BASIC}${prop("language", cs(value))}`)))).metadata.get("dc:language");
  assert.equal(await languageOf("eng"), "English");
  assert.equal(await languageOf("en"), "English");
  assert.equal(await languageOf("ENG"), "English");
  assert.equal(await languageOf("  fra  "), "French");
  assert.equal(await languageOf("eng; USA"), "English");
  assert.equal(await languageOf("eng-US"), "English");
  assert.equal(await languageOf("english"), null);
  assert.equal(await languageOf("abcd"), null);
  assert.equal(await languageOf("e"), null);
  assert.equal(await languageOf("123"), null);
  // A code with no name is its own display name, in lower case (Locale's language is lower-cased).
  assert.equal(await languageOf("XYZ"), "xyz");
});

test("a gmd:LanguageCode's text is read after its leading whitespace", async () => {
  const locale = (text: string): string =>
    prop("locale", `<gmd:PT_Locale><gmd:languageCode><gmd:LanguageCode>${text}</gmd:LanguageCode></gmd:languageCode>${prop("characterEncoding", code("MD_CharacterSetCode", "utf8"))}</gmd:PT_Locale>`);
  const viaLocale = await run(record(locale("\n   fra") + identification(BASIC)));
  assert.deepEqual(all(viaLocale.metadata, "iso19115:character-set"), ["UTF-8"]);
  const viaLanguage = await run(record(identification(`${BASIC}${prop("language", "<gmd:LanguageCode>\n  deu</gmd:LanguageCode>")}`)));
  assert.equal(viaLanguage.metadata.get("dc:language"), "German");
});

test("an identification's languages: each name once in file order, the last distinct one stays; a missing language leaves dc:language alone", async () => {
  const metadata = new Metadata();
  metadata.set("dc:language", "set before");
  await run(record(identification(BASIC)), metadata);
  assert.equal(metadata.get("dc:language"), "set before");
  const { metadata: two } = await run(record(identification(`${BASIC}${prop("language", cs("eng"))}${prop("language", cs("deu"))}${prop("language", cs("eng"))}`)));
  // eng, deu, eng is the two names English and German (a map's keys), and Tika sets the property once for each.
  assert.equal(two.get("dc:language"), "German");
  assert.equal(all(two, "dc:language").length, 1);
});

// ---- dates ----

const citationDates = async (...entries: string[]): Promise<string[]> =>
  all((await run(withCitation(entries.join("")))).metadata, "iso19115:citation-date");
const gcoDate = (text: string): string => `<gco:Date>${text}</gco:Date>`;
const gcoDateTime = (text: string): string => `<gco:DateTime>${text}</gco:DateTime>`;

test("a date reads between whitespace and nothing else may surround it", async () => {
  assert.deepEqual(await citationDates(dateEntry(gcoDate("\n  2013-12-16  \n"), "creation")), ["CREATION-->2013-12-16T00:00:00Z"]);
  for (const bad of ["2013-12-16x", "x2013-12-16", "2013-12-16 12:00:00", "2013-12-16T12:00", "13-12-16", "2013/12/16", "2013-12-16T12:00:00+0200"]) {
    await assert.rejects(citationDates(dateEntry(gcoDateTime(bad), "creation")), MalformedDocumentError, bad);
  }
});

test("a date that does not exist is no date: month 13, day 0 and 32, February 30, hour 24, minute 60, second 60", async () => {
  for (const bad of ["2013-13-01", "2013-00-10", "2013-01-00", "2013-01-32", "2013-02-30", "2013-02-29", "2013-04-31", "2013-12-16T24:00:00", "2013-12-16T10:60:00", "2013-12-16T10:00:60", "2013-12-16T99:99:99"]) {
    await assert.rejects(citationDates(dateEntry(gcoDateTime(bad), "creation")), MalformedDocumentError, bad);
  }
  // The edges that do exist.
  assert.deepEqual(await citationDates(dateEntry(gcoDateTime("2012-02-29T23:59:59"), "creation")), ["CREATION-->2012-02-29T23:59:59Z"]);
  assert.deepEqual(await citationDates(dateEntry(gcoDateTime("2013-01-31T00:00:00"), "creation")), ["CREATION-->2013-01-31T00:00:00Z"]);
  assert.deepEqual(await citationDates(dateEntry(gcoDateTime("2013-12-31T23:59:00"), "creation")), ["CREATION-->2013-12-31T23:59:00Z"]);
});

test("a zone shifts the time by its hours and minutes, east of UTC earlier and west later, and across midnight", async () => {
  assert.deepEqual(
    await citationDates(
      dateEntry(gcoDateTime("2013-12-16T10:00:00+05:30"), "creation"),
      dateEntry(gcoDateTime("2013-12-16T10:00:00-03:45"), "creation"),
      dateEntry(gcoDateTime("2013-12-16T01:00:00+02:00"), "creation"),
      dateEntry(gcoDateTime("2013-12-16T23:00:00-02:00"), "creation"),
      dateEntry(gcoDate("2013-12-16+01:00"), "creation"),
      dateEntry(gcoDateTime("2013-12-16T10:00:00Z"), "creation"),
      dateEntry(gcoDateTime("2013-12-16T10:11:12.123456"), "creation"),
    ),
    [
      "CREATION-->2013-12-16T04:30:00Z",
      "CREATION-->2013-12-16T13:45:00Z",
      "CREATION-->2013-12-15T23:00:00Z",
      "CREATION-->2013-12-17T01:00:00Z",
      "CREATION-->2013-12-15T23:00:00Z",
      "CREATION-->2013-12-16T10:00:00Z",
      "CREATION-->2013-12-16T10:11:12Z",
    ],
  );
});

test("a date written as gco:Date or gco:DateTime is read, and no other element is", async () => {
  assert.deepEqual(
    await citationDates(dateEntry(gcoDate("2013-12-16"), "creation"), dateEntry(gcoDateTime("2013-12-16T00:00:01"), "revision")),
    ["CREATION-->2013-12-16T00:00:00Z", "REVISION-->2013-12-16T00:00:01Z"],
  );
  await assert.rejects(citationDates(dateEntry("<gco:Time>2013-12-16</gco:Time>", "creation")), MalformedDocumentError);
});

test("a citation date with no type is skipped, and so is its date even when that cannot be read", async () => {
  assert.deepEqual(await citationDates(dateEntry(gcoDate("soon"), null), dateEntry(gcoDate("2013-12-16"), "creation")), ["CREATION-->2013-12-16T00:00:00Z"]);
});

test("the date type and the date of an entry are not each other", async () => {
  const { metadata } = await run(withCitation(dateEntry(gcoDate("2013-01-02"), "publication")));
  assert.deepEqual(all(metadata, "iso19115:citation-date"), ["PUBLICATION-->2013-01-02T00:00:00Z"]);
});

test("the metadata date stamp is CREATION and a stamp that cannot be read is not written (no error: the record has none)", async () => {
  const stamp = (value: string): string => prop("dateStamp", value);
  assert.deepEqual(all((await run(record(stamp(gcoDateTime("2014-03-04T05:06:07")) + identification(BASIC)))).metadata, "iso19115:date-info"), ["CREATION 2014-03-04T05:06:07Z"]);
  assert.equal((await run(record(stamp(gcoDate("2014-03-04")) + identification(BASIC)))).metadata.get("iso19115:date-info"), "CREATION 2014-03-04T00:00:00Z");
  assert.equal((await run(record(stamp(gcoDate("2014-02-30")) + identification(BASIC)))).metadata.has("iso19115:date-info"), false);
  assert.equal((await run(record(stamp("<other:Date>2014-03-04</other:Date>") + identification(BASIC)))).metadata.has("iso19115:date-info"), false);
  assert.equal((await run(record(identification(BASIC)))).metadata.has("iso19115:date-info"), false);
});

test("a record whose identification has no abstract leaves a dc:description that was already there, though the parse then fails", async () => {
  const metadata = new Metadata();
  metadata.set("dc:description", "set before");
  await assert.rejects(run(record(identification(citation(title("T")))), metadata), MalformedDocumentError);
  assert.equal(metadata.get("dc:description"), "set before");
});

// ---- parties ----

test("a cited party writes its role, individual name, organisation and position, each under its own key, and its addresses", async () => {
  const cited = party(
    `${role("author")}${prop("individualName", cs("Ann"))}${prop("organisationName", cs("Org"))}${prop("positionName", cs("Chief"))}` +
      prop(
        "contactInfo",
        `<gmd:CI_Contact>${prop("address", `<gmd:CI_Address>${prop("electronicMailAddress", cs("a@x.example"))}${prop("electronicMailAddress", cs("b@x.example"))}${prop("deliveryPoint", cs("not an email"))}</gmd:CI_Address>`)}</gmd:CI_Contact>`,
      ),
  );
  const { metadata } = await run(withCitation(prop("citedResponsibleParty", cited)));
  assert.deepEqual(all(metadata, "iso19115:cited-responsible-party-role"), ["AUTHOR"]);
  assert.deepEqual(all(metadata, "iso19115:cited-responsible-party-name"), ["Ann"]);
  assert.deepEqual(all(metadata, "iso19115:cited-responsible-party-organization-name"), ["Org"]);
  assert.deepEqual(all(metadata, "iso19115:cited-responsible-party-position-name"), ["Chief"]);
  assert.deepEqual(all(metadata, "iso19115:cited-responsible-party-email"), ["a@x.example", "b@x.example"]);
});

test("a cited party that has only a role writes only the role", async () => {
  const { metadata, xml } = await run(withCitation(prop("citedResponsibleParty", party(role("author")))));
  assert.deepEqual(names(metadata), ["iso19115:cited-responsible-party-role"]);
  // The heading names the missing individual as Java's string concatenation does.
  assert.ok(xml.includes("CitedResponsiblePartyRole AUTHORCitedResponsiblePartyName null"));
});

test("the heading of a cited party names the individual, not the organisation", async () => {
  const { xml } = await run(withCitation(prop("citedResponsibleParty", party(`${role("author")}${prop("organisationName", cs("Org"))}`))));
  assert.ok(xml.includes("CitedResponsiblePartyName null"));
  // The organisation is in the metadata (a meta element of the head), not in the text.
  assert.ok(!/<body>[\s\S]*Org[\s\S]*<\/body>/.test(xml));
});

test("a cited party whose contact information has an address with no emails writes none, and one with emails writes them", async () => {
  const contact = (address: string): string => prop("contactInfo", `<gmd:CI_Contact>${address}</gmd:CI_Contact>`);
  const none = await run(withCitation(prop("citedResponsibleParty", party(role("author") + contact(prop("address", "<gmd:CI_Address/>"))))));
  assert.equal(none.metadata.has("iso19115:cited-responsible-party-email"), false);
  // Only the first address counts (SIS's legacy getAddress()).
  const two = await run(
    withCitation(
      prop(
        "citedResponsibleParty",
        party(
          role("author") +
            contact(
              prop("address", `<gmd:CI_Address>${prop("electronicMailAddress", cs("first@x.example"))}</gmd:CI_Address>`) +
                prop("address", `<gmd:CI_Address>${prop("electronicMailAddress", cs("second@x.example"))}</gmd:CI_Address>`),
            ),
        ),
      ),
    ),
  );
  assert.deepEqual(all(two.metadata, "iso19115:cited-responsible-party-email"), ["first@x.example"]);
});

test("contacts of the record write their role and organisation, and nothing for a part they lack", async () => {
  const contacts =
    `<gmd:contact>${party(`${role("custodian")}${prop("organisationName", cs("Org A"))}`)}</gmd:contact>` +
    `<gmd:contact>${party(role("owner"))}</gmd:contact>` +
    `<gmd:contact>${party(prop("organisationName", cs("Org B")))}</gmd:contact>` +
    `<gmd:contact>${party(prop("individualName", cs("Only a name")))}</gmd:contact>`;
  const { metadata } = await run(record(contacts + identification(BASIC)));
  assert.deepEqual(all(metadata, "iso19115:contact-role"), ["CUSTODIAN", "OWNER"]);
  assert.deepEqual(all(metadata, "iso19115:contact-party-name"), ["Org A", "Org B"]);
});

test("what Tika fails on: a missing role, title or abstract leaves no metadata of that part; a failure in the text still leaves the metadata written", async () => {
  const failing = async (xml: string, keys: string[]): Promise<void> => {
    const metadata = new Metadata();
    await assert.rejects(run(xml, metadata), MalformedDocumentError);
    for (const key of keys) assert.equal(metadata.has(key), false, key);
  };
  await failing(withCitation(prop("citedResponsibleParty", party(prop("individualName", cs("N"))))), ["iso19115:cited-responsible-party-role"]);
  await failing(record(identification(`${citation("")}${prop("abstract", cs("A"))}`)), ["dc:title"]);
  await failing(record(identification(citation(title("T")))), ["dc:description"]);
  // The role is missing: Tika's getMetaDataIdentificationInfo skips it (line 273) and extractContent fails on it (line 167), after
  // the metadata of the whole record was written. So the position name is there although the parse failed.
  const late = new Metadata();
  await assert.rejects(run(withCitation(prop("citedResponsibleParty", party(prop("positionName", cs("P"))))), late), MalformedDocumentError);
  assert.deepEqual(all(late, "iso19115:cited-responsible-party-position-name"), ["P"]);
});

// ---- keywords, thesaurus, geographic description, constraints, distribution ----

const thesaurus = (inner: string): string => prop("thesaurusName", `<gmd:CI_Citation>${inner}</gmd:CI_Citation>`);
const keywordGroup = (inner: string): string => prop("descriptiveKeywords", `<gmd:MD_Keywords>${inner}</gmd:MD_Keywords>`);

test("a thesaurus writes its title, its alternate titles as Java prints a list, and its dates", async () => {
  const group = keywordGroup(
    `${prop("keyword", cs("k1"))}${prop("keyword", cs("k2"))}${prop("type", code("MD_KeywordTypeCode", "theme"))}` +
      thesaurus(`${title("Thes")}${prop("alternateTitle", cs("alt one"))}${prop("alternateTitle", cs("alt two"))}${dateEntry(gcoDate("2014-05-21"), "revision")}${dateEntry(gcoDate("2014-05-22"), null)}`),
  );
  const { metadata } = await run(withIdentification(group));
  assert.deepEqual(all(metadata, "iso19115:keywords:2"), ["k1", "k2"]);
  assert.deepEqual(all(metadata, "iso19115:keywords-type:2"), ["THEME"]);
  assert.deepEqual(all(metadata, "iso19115:thesaurus-name-title:2"), ["Thes"]);
  assert.deepEqual(all(metadata, "iso19115:thesaurus-name-alternative-title:2"), ["[alt one, alt two]"]);
  assert.deepEqual(all(metadata, "iso19115:thesaurus-name-date"), ["REVISION-->2014-05-21T00:00:00Z"]);
});

test("a thesaurus with no title writes no title, keyword groups are numbered from 2 across identifications' groups, and a group with no keywords writes none", async () => {
  const group = (keyword: string | null): string => keywordGroup(`${keyword === null ? "" : prop("keyword", cs(keyword))}${thesaurus(prop("alternateTitle", cs("a")))}`);
  const { metadata } = await run(withIdentification(group("one") + group(null) + group("three")));
  assert.deepEqual(all(metadata, "iso19115:keywords:2"), ["one"]);
  assert.deepEqual(all(metadata, "iso19115:keywords:3"), []);
  assert.deepEqual(all(metadata, "iso19115:keywords:4"), ["three"]);
  assert.equal(metadata.has("iso19115:thesaurus-name-title:2"), false);
  assert.deepEqual(all(metadata, "iso19115:thesaurus-name-alternative-title:3"), ["[a]"]);
});

test("a thesaurus date with no type is skipped, and one whose date cannot be read is Tika's NullPointerException", async () => {
  const group = (date: string): string => keywordGroup(`${prop("keyword", cs("k"))}${thesaurus(`${title("Thes")}${date}`)}`);
  const skipped = await run(withIdentification(group(dateEntry(gcoDate("soon"), null))));
  assert.equal(skipped.metadata.has("iso19115:thesaurus-name-date"), false);
  await assert.rejects(run(withIdentification(group(dateEntry(gcoDate("soon"), "revision")))), MalformedDocumentError);
});

const geographicDescription = (identifier: string): string =>
  `<gmd:extent><gmd:EX_Extent><gmd:geographicElement><gmd:EX_GeographicDescription>${prop("geographicIdentifier", identifier)}</gmd:EX_GeographicDescription></gmd:geographicElement></gmd:EX_Extent></gmd:extent>`;

test("a geographic description writes its code, its authority's title and alternate titles, and dates with a space after the type", async () => {
  const authority = prop(
    "authority",
    `<gmd:CI_Citation>${title("Auth")}${prop("alternateTitle", cs("A1"))}${prop("alternateTitle", cs("A2"))}${dateEntry(gcoDate("2014-08-28"), "revision")}${dateEntry(gcoDate("2014-08-29"), null)}${dateEntry(gcoDate("never"), "creation")}</gmd:CI_Citation>`,
  );
  for (const identifier of ["MD_Identifier", "RS_Identifier"]) {
    const { metadata } = await run(withIdentification(geographicDescription(`<gmd:${identifier}>${prop("code", cs("Alaska"))}${authority}</gmd:${identifier}>`)));
    assert.deepEqual(all(metadata, "iso19115:geographic-identifier-code"), ["Alaska"], identifier);
    assert.deepEqual(all(metadata, "iso19115:geographic-identifier-authority-title"), ["Auth"]);
    assert.deepEqual(all(metadata, "iso19115:geographic-identifier-authority-alternative-title"), ["A1", "A2"]);
    // Tika skips a date whose type or value is missing here (cd.getDateType() != null && cd.getDate() != null).
    assert.deepEqual(all(metadata, "iso19115:geographic-identifier-authority-date"), ["REVISION 2014-08-28T00:00:00Z"]);
  }
});

test("a geographic description with an authority but no code or title writes only what it has", async () => {
  const { metadata } = await run(
    withIdentification(geographicDescription(`<gmd:MD_Identifier>${prop("authority", `<gmd:CI_Citation>${prop("alternateTitle", cs("Only alt"))}</gmd:CI_Citation>`)}</gmd:MD_Identifier>`)),
  );
  assert.deepEqual(names(metadata), ["iso19115:geographic-identifier-authority-alternative-title"]);
});

test("a geographic element that is neither a box nor a description is skipped", async () => {
  const polygon = "<gmd:extent><gmd:EX_Extent><gmd:geographicElement><gmd:EX_BoundingPolygon/></gmd:geographicElement></gmd:EX_Extent></gmd:extent>";
  const { metadata, xml } = await run(withIdentification(polygon));
  assert.deepEqual(names(metadata), []);
  assert.ok(!xml.includes("<tr>"));
});

test("every bounding box of every extent is written, four rows each, in the order west, east, north, south", async () => {
  const side = (name: string, value: string): string => prop(name, `<gco:Decimal>${value}</gco:Decimal>`);
  const box = (west: string, east: string, south: string, north: string): string =>
    `<gmd:geographicElement><gmd:EX_GeographicBoundingBox>${side("southBoundLatitude", south)}${side("northBoundLatitude", north)}${side("eastBoundLongitude", east)}${side("westBoundLongitude", west)}</gmd:EX_GeographicBoundingBox></gmd:geographicElement>`;
  const extents = `<gmd:extent><gmd:EX_Extent>${box("1", "2", "3", "4")}${box("5", "6", "7", "8")}</gmd:EX_Extent></gmd:extent><gmd:extent><gmd:EX_Extent>${box("9", "10", "11", "12")}</gmd:EX_Extent></gmd:extent>`;
  const { xml } = await run(withIdentification(extents));
  const rows = [...xml.matchAll(/<td>(Geographic[A-Za-z]+)<\/td>\s*<td>([^<]*)<\/td>/g)].map((match) => `${match[1]}=${match[2]}`);
  const sides = (west: string, east: string, north: string, south: string): string[] => [
    `GeographicElementWestBoundLatitude=${west}`,
    `GeographicElementEastBoundLatitude=${east}`,
    `GeographicElementNorthBoundLatitude=${north}`,
    `GeographicElementSouthBoundLatitude=${south}`,
  ];
  assert.deepEqual(rows, [...sides("1.0", "2.0", "4.0", "3.0"), ...sides("5.0", "6.0", "8.0", "7.0"), ...sides("9.0", "10.0", "12.0", "11.0")]);
});

test("a bounding box side that is not a number is NaN (an assumption: SIS reads an unreadable gco:Decimal as no number)", async () => {
  const box = `<gmd:extent><gmd:EX_Extent><gmd:geographicElement><gmd:EX_GeographicBoundingBox>${prop("westBoundLongitude", "<gco:Decimal>abc</gco:Decimal>")}${prop("eastBoundLongitude", "<gco:Decimal> 7.5 </gco:Decimal>")}</gmd:EX_GeographicBoundingBox></gmd:geographicElement></gmd:EX_Extent></gmd:extent>`;
  const { xml } = await run(withIdentification(box));
  assert.match(xml, /WestBoundLatitude<\/td>\s*<td>NaN<\/td>/);
  assert.match(xml, /EastBoundLatitude<\/td>\s*<td>7\.5<\/td>/);
});

test("online resources write each part they have under its own key, and a resource with only a linkage writes only that", async () => {
  const resource = (inner: string): string =>
    `<gmd:transferOptions><gmd:MD_DigitalTransferOptions><gmd:onLine><gmd:CI_OnlineResource>${inner}</gmd:CI_OnlineResource></gmd:onLine></gmd:MD_DigitalTransferOptions></gmd:transferOptions>`;
  const full = resource(
    `${prop("linkage", "<gmd:URL>\n  http://example.invalid/a  \n</gmd:URL>")}${prop("protocol", cs("P"))}${prop("applicationProfile", cs("Prof"))}${prop("name", cs("N"))}${prop("description", cs("D"))}${prop("function", code("CI_OnLineFunctionCode", "download"))}`,
  );
  const linkageOnly = resource(prop("linkage", "<gmd:URL>http://example.invalid/b</gmd:URL>"));
  const blank = resource(prop("linkage", "<gmd:URL>   </gmd:URL>") + prop("protocol", cs("only protocol")));
  const distribution = `<gmd:distributionInfo><gmd:MD_Distribution>${full}${linkageOnly}${blank}</gmd:MD_Distribution></gmd:distributionInfo>`;
  const { metadata } = await run(record(identification(BASIC), distribution));
  assert.deepEqual(all(metadata, "iso19115:transfer-options-online-linkage"), ["http://example.invalid/a", "http://example.invalid/b"]);
  assert.deepEqual(all(metadata, "iso19115:transfer-options-online-protocol"), ["P", "only protocol"]);
  assert.deepEqual(all(metadata, "iso19115:transfer-options-online-profile"), ["Prof"]);
  assert.deepEqual(all(metadata, "iso19115:transfer-options-online-name"), ["N"]);
  assert.deepEqual(all(metadata, "iso19115:transfer-options-online-description"), ["D"]);
  assert.deepEqual(all(metadata, "iso19115:transfer-options-online-function"), ["DOWNLOAD"]);
});

test("a distribution writes its formats and its distributors' role and organisation, skipping what a distributor lacks", async () => {
  const format = (name: string): string => prop("distributionFormat", `<gmd:MD_Format>${prop("name", cs(name))}${prop("version", cs("ignored"))}</gmd:MD_Format>`);
  const distributor = (inner: string): string => prop("distributor", `<gmd:MD_Distributor>${prop("distributorContact", party(inner))}</gmd:MD_Distributor>`);
  const distribution =
    `<gmd:distributionInfo><gmd:MD_Distribution>${format("GeoTIFF")}${format("Shapefile")}` +
    `${distributor(role("distributor") + prop("organisationName", cs("Org D")))}${distributor(role("publisher"))}${distributor(prop("organisationName", cs("Org E")))}` +
    `</gmd:MD_Distribution></gmd:distributionInfo>`;
  const { metadata } = await run(record(identification(BASIC), distribution));
  assert.deepEqual(all(metadata, "iso19115:distribution-format-specification-alternative-title"), ["GeoTIFF", "Shapefile"]);
  assert.deepEqual(all(metadata, "iso19115:distributor-contact"), ["DISTRIBUTOR", "PUBLISHER"]);
  assert.deepEqual(all(metadata, "iso19115:distributor-organization-name"), ["Org D", "Org E"]);
});

test("a resource format is read by its name, not by its version", async () => {
  const format = prop("resourceFormat", `<gmd:MD_Format>${prop("version", cs("2.0"))}${prop("name", cs("NetCDF"))}</gmd:MD_Format>`);
  const { metadata } = await run(withIdentification(format));
  assert.deepEqual(all(metadata, "iso19115:resource-format-specification-alternative-title"), ["NetCDF"]);
});

// ---- the record itself ----

test("the scope, the parent title, the identifier code and the standard are written from their own elements", async () => {
  const body =
    prop("hierarchyLevel", code("MD_ScopeCode", "dataset")) +
    prop("hierarchyLevel", code("MD_ScopeCode", "series")) +
    prop("parentIdentifier", cs("parent")) +
    prop("fileIdentifier", cs("id-1")) +
    prop("metadataStandardName", cs("Std")) +
    prop("metadataStandardVersion", cs("Ed 2")) +
    identification(BASIC);
  const { metadata } = await run(record(body));
  assert.deepEqual(all(metadata, "iso19115:metadata-resource-scope"), ["DATASET", "SERIES"]);
  assert.equal(metadata.get("iso19115:parent-metadata-title"), "parent");
  assert.equal(metadata.get("iso19115:metadata-identifier-code"), "id-1");
  assert.equal(metadata.get("iso19115:metadata-standard-title"), "Std");
  assert.equal(metadata.get("iso19115:metadata-standard-edition"), "Ed 2");
});

test("a standard with only a name, or only a version, writes only that one", async () => {
  const onlyName = await run(record(prop("metadataStandardName", cs("Std")) + identification(BASIC)));
  assert.equal(onlyName.metadata.get("iso19115:metadata-standard-title"), "Std");
  assert.equal(onlyName.metadata.has("iso19115:metadata-standard-edition"), false);
  const onlyVersion = await run(record(prop("metadataStandardVersion", cs("Ed 2")) + identification(BASIC)));
  assert.equal(onlyVersion.metadata.get("iso19115:metadata-standard-edition"), "Ed 2");
  assert.equal(onlyVersion.metadata.has("iso19115:metadata-standard-title"), false);
  const neither = await run(record(identification(BASIC)));
  assert.equal(neither.metadata.has("iso19115:metadata-standard-title"), false);
});

test("a record with no parent title or identifier leaves a value that was already there alone", async () => {
  const metadata = new Metadata();
  metadata.set("iso19115:parent-metadata-title", "preset parent");
  metadata.set("iso19115:metadata-identifier-code", "preset id");
  await run(record(identification(BASIC)), metadata);
  assert.equal(metadata.get("iso19115:parent-metadata-title"), "preset parent");
  assert.equal(metadata.get("iso19115:metadata-identifier-code"), "preset id");
  // And the second one is Tika's PropertyTypeException too.
  const again = new Metadata();
  again.set("iso19115:metadata-identifier-code", "preset id");
  await assert.rejects(run(record(prop("fileIdentifier", cs("id")) + identification(BASIC)), again), MalformedDocumentError);
});

test("a title is read from the identification's citation, and the parent's title from parentIdentifier, not the other way", async () => {
  const { metadata } = await run(record(prop("parentIdentifier", cs("P")) + prop("fileIdentifier", cs("F")) + identification(BASIC)));
  assert.equal(metadata.get("iso19115:parent-metadata-title"), "P");
  assert.equal(metadata.get("iso19115:metadata-identifier-code"), "F");
});

// ---- the text output, exactly ----

test("the text is the head, then per identification a heading, a heading per cited party, the abstract and the box rows, then a last newline", async () => {
  const side = (name: string, value: string): string => prop(name, `<gco:Decimal>${value}</gco:Decimal>`);
  const box = `<gmd:extent><gmd:EX_Extent><gmd:geographicElement><gmd:EX_GeographicBoundingBox>${side("westBoundLongitude", "-1")}${side("eastBoundLongitude", "2.5")}${side("southBoundLatitude", "3")}${side("northBoundLatitude", "4")}</gmd:EX_GeographicBoundingBox></gmd:geographicElement></gmd:EX_Extent></gmd:extent>`;
  const cited = prop("citedResponsibleParty", party(`${role("author")}${prop("individualName", cs("Ann"))}`));
  const { xml } = await run(record(identification(`${citation(title("Title") + cited)}${prop("abstract", cs("Abstract"))}${box}`)));
  // The two newlines Tika's extractContent writes after startDocument come out before the html element (ToXMLContentHandler).
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n\n<html>'), xml.slice(0, 60));
  const body = /<body>([\s\S]*)<\/body>/.exec(xml)?.[1];
  assert.equal(
    body,
    "<h1>Title</h1>\n\n" +
      "<h3>\nCitedResponsiblePartyRole AUTHORCitedResponsiblePartyName Ann</h3>\n\n" +
      "<p>\nIdentificationInfoAbstract Abstract</p>\n\n" +
      "<tr>\t<td>GeographicElementWestBoundLatitude</td>\t<td>-1.0</td></tr>\n" +
      "<tr>\t<td>GeographicElementEastBoundLatitude</td>\t<td>2.5</td></tr>\n" +
      "<tr>\t<td>GeographicElementNorthBoundLatitude</td>\t<td>4.0</td></tr>\n" +
      "<tr>\t<td>GeographicElementSouthBoundLatitude</td>\t<td>3.0</td></tr>\n" +
      "\n",
  );
});

test("a record with two identifications writes both in turn", async () => {
  const two = record(identification(`${citation(title("One"))}${prop("abstract", cs("First"))}`) + identification(`${citation(title("Two"))}${prop("abstract", cs("Second"))}`));
  const { xml, metadata } = await run(two);
  assert.ok(xml.indexOf("<h1>One</h1>") < xml.indexOf("IdentificationInfoAbstract First"));
  assert.ok(xml.indexOf("IdentificationInfoAbstract First") < xml.indexOf("<h1>Two</h1>"));
  assert.ok(xml.indexOf("<h1>Two</h1>") < xml.indexOf("IdentificationInfoAbstract Second"));
  // dc:title and dc:description are set once per identification: the last stays.
  assert.equal(metadata.get("dc:title"), "Two");
  assert.equal(metadata.get("dc:description"), "Second");
});

test("the keys that carry a keyword group's index are written under their own prefixes and nothing else", async () => {
  const group = keywordGroup(`${prop("keyword", cs("k"))}${prop("type", code("MD_KeywordTypeCode", "place"))}${thesaurus(`${title("Th")}${prop("alternateTitle", cs("al"))}`)}`);
  const { metadata } = await run(withIdentification(group));
  assert.deepEqual(names(metadata).sort(), [
    "iso19115:keywords-type:2",
    "iso19115:keywords:2",
    "iso19115:thesaurus-name-alternative-title:2",
    "iso19115:thesaurus-name-title:2",
  ]);
});

test("the keys of a full record are exactly the ones the Tika parser writes", async () => {
  // One record that fills every part, then the set of keys: a key renamed or dropped in the parser shows here.
  const cited = prop(
    "citedResponsibleParty",
    party(`${role("author")}${prop("individualName", cs("I"))}${prop("organisationName", cs("O"))}${prop("positionName", cs("P"))}${email("e@x.example")}`),
  );
  const keywords = keywordGroup(`${prop("keyword", cs("k"))}${prop("type", code("MD_KeywordTypeCode", "theme"))}${thesaurus(`${title("Th")}${dateEntry(gcoDate("2014-05-21"), "revision")}`)}`);
  const constraints = prop(
    "resourceConstraints",
    `<gmd:MD_LegalConstraints>${prop("accessConstraints", code("MD_RestrictionCode", "copyright"))}${prop("otherConstraints", cs("o"))}${prop("useConstraints", code("MD_RestrictionCode", "license"))}</gmd:MD_LegalConstraints>`,
  );
  const geographic = geographicDescription(
    `<gmd:MD_Identifier>${prop("code", cs("c"))}${prop("authority", `<gmd:CI_Citation>${title("a")}${prop("alternateTitle", cs("b"))}${dateEntry(gcoDate("2014-08-28"), "revision")}</gmd:CI_Citation>`)}</gmd:MD_Identifier>`,
  );
  const body =
    prop("language", cs("eng")) +
    prop("characterSet", code("MD_CharacterSetCode", "utf8")) +
    `<gmd:contact>${party(role("author") + prop("organisationName", cs("Org")))}</gmd:contact>` +
    prop("hierarchyLevel", code("MD_ScopeCode", "dataset")) +
    prop("parentIdentifier", cs("pa")) +
    prop("fileIdentifier", cs("fi")) +
    prop("metadataStandardName", cs("sn")) +
    prop("metadataStandardVersion", cs("sv")) +
    prop("dateStamp", gcoDate("2014-03-04")) +
    identification(
      `${citation(title("T") + dateEntry(gcoDate("2013-12-16"), "creation") + cited)}${prop("abstract", cs("A"))}${prop("status", code("MD_ProgressCode", "completed"))}` +
        `${prop("resourceFormat", `<gmd:MD_Format>${prop("name", cs("f"))}</gmd:MD_Format>`)}${prop("language", cs("eng"))}${prop("topicCategory", "<gmd:MD_TopicCategoryCode>biota</gmd:MD_TopicCategoryCode>")}` +
        `${keywords}${constraints}${geographic}`,
    );
  const distribution =
    `<gmd:distributionInfo><gmd:MD_Distribution>${prop("distributionFormat", `<gmd:MD_Format>${prop("name", cs("df"))}</gmd:MD_Format>`)}` +
    prop("distributor", `<gmd:MD_Distributor>${prop("distributorContact", party(role("distributor") + prop("organisationName", cs("DO"))))}</gmd:MD_Distributor>`) +
    `<gmd:transferOptions><gmd:MD_DigitalTransferOptions><gmd:onLine><gmd:CI_OnlineResource>${prop("linkage", "<gmd:URL>http://x/</gmd:URL>")}${prop("protocol", cs("p"))}${prop("applicationProfile", cs("ap"))}${prop("name", cs("n"))}${prop("description", cs("d"))}${prop("function", code("CI_OnLineFunctionCode", "download"))}</gmd:CI_OnlineResource></gmd:onLine></gmd:MD_DigitalTransferOptions></gmd:transferOptions></gmd:MD_Distribution></gmd:distributionInfo>`;
  const { metadata } = await run(record(body, distribution));
  assert.deepEqual(metadata.names().sort(), [
    "Content-Type",
    "dc:description",
    "dc:language",
    "dc:title",
    "iso19115:access-constraints",
    "iso19115:character-set",
    "iso19115:citation-date",
    "iso19115:cited-responsible-party-email",
    "iso19115:cited-responsible-party-name",
    "iso19115:cited-responsible-party-organization-name",
    "iso19115:cited-responsible-party-position-name",
    "iso19115:cited-responsible-party-role",
    "iso19115:contact-party-name",
    "iso19115:contact-role",
    "iso19115:date-info",
    "iso19115:distribution-format-specification-alternative-title",
    "iso19115:distributor-contact",
    "iso19115:distributor-organization-name",
    "iso19115:geographic-identifier-authority-alternative-title",
    "iso19115:geographic-identifier-authority-date",
    "iso19115:geographic-identifier-authority-title",
    "iso19115:geographic-identifier-code",
    "iso19115:identification-info-status",
    "iso19115:identification-info-topic-category",
    "iso19115:keywords-type:2",
    "iso19115:keywords:2",
    "iso19115:metadata-identifier-code",
    "iso19115:metadata-resource-scope",
    "iso19115:metadata-standard-edition",
    "iso19115:metadata-standard-title",
    "iso19115:other-constraints",
    "iso19115:parent-metadata-title",
    "iso19115:resource-format-specification-alternative-title",
    "iso19115:thesaurus-name-alternative-title:2",
    "iso19115:thesaurus-name-date",
    "iso19115:thesaurus-name-title:2",
    "iso19115:transfer-options-online-description",
    "iso19115:transfer-options-online-function",
    "iso19115:transfer-options-online-linkage",
    "iso19115:transfer-options-online-name",
    "iso19115:transfer-options-online-profile",
    "iso19115:transfer-options-online-protocol",
    "iso19115:use-constraints",
  ]);
});
