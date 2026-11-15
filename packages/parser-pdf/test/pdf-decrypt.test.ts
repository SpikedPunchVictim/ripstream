import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { PdfParser } from "../src/index.ts";
import { ownerPasswordMatches, streamDecryptor } from "../src/pdf-decrypt.ts";
import { indexObjects } from "../src/pdf-objects.ts";
import { preflightPdf } from "../src/pdf-preflight.ts";
import { encryptedPdf } from "./fixtures.ts";

const CONTENT = "BT /F1 24 Tf 72 700 Td (Secret AES text) Tj ET";
const PADDING = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
const FILE_ID = Buffer.from("00112233445566778899aabbccddeeff", "hex");

const md5 = (...parts: Buffer[]): Buffer => createHash("md5").update(Buffer.concat(parts)).digest();
const sha256 = (...parts: Buffer[]): Buffer => createHash("sha256").update(Buffer.concat(parts)).digest();
const filled = (length: number, seed: number): Buffer => Buffer.from(Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff));

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 0xff]!;
  }
  return out;
}

function aes(algorithm: string, key: Buffer, iv: Buffer, data: Buffer, padding = true): Buffer {
  const cipher = createCipheriv(algorithm, key, iv);
  cipher.setAutoPadding(padding);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** ISO 32000-2 Algorithm 2.B, written out here independently of the source so pdf.js can referee both. */
function hash2B(password: Buffer, salt: Buffer, userData: Buffer): Buffer {
  let key = sha256(password, salt, userData);
  for (let round = 0; ; round++) {
    const block = Buffer.concat([password, key, userData]);
    const encrypted = aes("aes-128-cbc", key.subarray(0, 16), key.subarray(16, 32), Buffer.concat(Array(64).fill(block)), false);
    const remainder = [...encrypted.subarray(0, 16)].reduce((sum, byte) => sum + byte, 0) % 3;
    key = createHash(["sha256", "sha384", "sha512"][remainder]!).update(encrypted).digest();
    if (round >= 63 && encrypted[encrypted.length - 1]! <= round - 31) return key.subarray(0, 32);
  }
}

/**
 * A one-page document whose content stream (object 4) is encrypted with the standard handler: AES-128 (revision 4) or
 * AES-256 (revisions 5 and 6), opened by `password`.
 */
function aesPdf(revision: 4 | 5 | 6, password: string, content = CONTENT): Buffer {
  const iv = filled(16, 7);
  let encrypt: string;
  let encrypted: Buffer;
  if (revision === 4) {
    const owner = filled(32, 3);
    const permissions = Buffer.alloc(4);
    permissions.writeInt32LE(-4);
    let key = md5(Buffer.concat([Buffer.from(password, "latin1"), PADDING]).subarray(0, 32), owner, permissions, FILE_ID);
    for (let i = 0; i < 50; i++) key = md5(key);
    let user = rc4(key, md5(PADDING, FILE_ID));
    for (let i = 1; i <= 19; i++) user = rc4(Buffer.from(key.map((byte) => byte ^ i)), user);
    const objectKey = md5(key, Buffer.from([4, 0, 0, 0, 0]), Buffer.from("sAlT"));
    encrypted = Buffer.concat([iv, aes("aes-128-cbc", objectKey, iv, Buffer.from(content, "latin1"))]);
    encrypt =
      "<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> " +
      `/StmF /StdCF /StrF /StdCF /P -4 /O <${owner.toString("hex")}> /U <${Buffer.concat([user, filled(16, 9)]).toString("hex")}> >>`;
  } else {
    const fileKey = filled(32, 11);
    const secret = Buffer.from(password, "utf8");
    const validationSalt = filled(8, 13);
    const keySalt = filled(8, 17);
    const hash = (salt: Buffer): Buffer => (revision === 5 ? sha256(secret, salt) : hash2B(secret, salt, Buffer.alloc(0)));
    const user = Buffer.concat([hash(validationSalt), validationSalt, keySalt]);
    const userKey = aes("aes-256-cbc", hash(keySalt), Buffer.alloc(16), fileKey, false);
    encrypted = Buffer.concat([iv, aes("aes-256-cbc", fileKey, iv, Buffer.from(content, "latin1"))]);
    encrypt =
      `<< /Filter /Standard /V 5 /R ${revision} /Length 256 /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> ` +
      `/StmF /StdCF /StrF /StdCF /P -4 /O <${filled(48, 19).toString("hex")}> /U <${user.toString("hex")}> ` +
      `/OE <${filled(32, 23).toString("hex")}> /UE <${userKey.toString("hex")}> /Perms <${filled(16, 29).toString("hex")}> >>`;
  }
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    Buffer.concat([Buffer.from(`<< /Length ${encrypted.length} >>\nstream\n`), encrypted, Buffer.from("\nendstream")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from(encrypt),
  ];
  const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n")];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const id = FILE_ID.toString("hex");
  chunks.push(
    Buffer.from(
      `xref\n0 7\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}` +
        `trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

/** Object 4's stream data as it is in the file. */
function contentData(text: string): string {
  const object = indexObjects(text).objects.get(4)!;
  return text.slice(object.stream!.start, object.stream!.end);
}

async function pdfjsText(bytes: Uint8Array, password?: string): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  try {
    const parser = new PdfParser(password === undefined ? {} : { password: { getPassword: () => password } });
    await parser.parse(stream, handler, new Metadata(), new ParseContext());
    return handler.toString();
  } finally {
    await stream.close();
  }
}

test("streamDecryptor decrypts RC4 (revision 2) with the empty user password, and refuses another password", () => {
  const open = Buffer.from(encryptedPdf("")).toString("latin1");
  assert.equal(streamDecryptor(open)?.(4, 0, contentData(open)), "BT /F1 24 Tf 72 700 Td (Secret text) Tj ET");
  const locked = Buffer.from(encryptedPdf("user-pw")).toString("latin1");
  assert.equal(streamDecryptor(locked), null);
  assert.equal(streamDecryptor(locked, "user-pw")?.(4, 0, contentData(locked)), "BT /F1 24 Tf 72 700 Td (Secret text) Tj ET");
});

for (const revision of [4, 5, 6] as const) {
  test(`streamDecryptor decrypts AES revision ${revision} the way pdf.js does`, async () => {
    const bytes = aesPdf(revision, "");
    // pdf.js referees the test file: it reads the text, so the file is encrypted as the standard says.
    assert.match(await pdfjsText(bytes), /Secret AES text/);
    const text = bytes.toString("latin1");
    assert.equal(streamDecryptor(text)?.(4, 0, contentData(text)), CONTENT);
  });

  test(`streamDecryptor takes a user password for AES revision ${revision}`, () => {
    const text = aesPdf(revision, "pässword").toString("latin1");
    assert.equal(streamDecryptor(text), null);
    assert.equal(streamDecryptor(text, "pässword")?.(4, 0, contentData(text)), CONTENT);
  });
}

test("streamDecryptor is null for a file that is not encrypted or uses another handler", () => {
  assert.equal(streamDecryptor("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"), null);
  assert.equal(streamDecryptor("%PDF-1.4\ntrailer\n<< /Encrypt << /Filter /PubSec /V 4 >> >>\n"), null);
});

/** Two forms that list each other as resources but whose content paints neither. */
function formPair(encode: (num: number, content: string) => { data: string; filter: string }): string {
  const form = (num: number, other: number): string => {
    const { data, filter } = encode(num, "q 0 0 m 1 1 l S Q");
    return `${num} 0 obj\n<< /Subtype /Form /Resources << /XObject << /X ${other} 0 R >> >>${filter} /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
  };
  return form(1, 2) + form(2, 1);
}

test("preflight reads compressed form content before calling a resource pair a cycle (tikajs-4hfu)", () => {
  const text = formPair((_num, content) => ({ data: deflateSync(Buffer.from(content)).toString("latin1"), filter: " /Filter /FlateDecode" }));
  preflightPdf(new Uint8Array(Buffer.from(`%PDF-1.4\n${text}`, "latin1")));
});

test("preflight decrypts form content before calling a resource pair a cycle (tikajs-4hfu)", () => {
  const base = aesPdf(5, "").toString("latin1");
  const encrypt = /6 0 obj\n(<<[^]*?>>)\nendobj/.exec(base)![1]!;
  const fileKey = filled(32, 11);
  const iv = filled(16, 5);
  const text = formPair((_num, content) => ({
    data: Buffer.concat([iv, aes("aes-256-cbc", fileKey, iv, Buffer.from(content))]).toString("latin1"),
    filter: "",
  }));
  const file = `%PDF-1.7\n${text}6 0 obj\n${encrypt}\nendobj\ntrailer\n<< /Root 9 0 R /Encrypt 6 0 R >>\n%%EOF\n`;
  preflightPdf(new Uint8Array(Buffer.from(file, "latin1")));
  // The same pair painting each other is still a cycle.
  const painting = file.replaceAll(
    Buffer.concat([iv, aes("aes-256-cbc", fileKey, iv, Buffer.from("q 0 0 m 1 1 l S Q"))]).toString("latin1"),
    Buffer.concat([iv, aes("aes-256-cbc", fileKey, iv, Buffer.from("/X Do     \n      \n"))]).toString("latin1"),
  );
  assert.throws(() => preflightPdf(new Uint8Array(Buffer.from(painting, "latin1"))), /paints itself/);
});

test("ownerPasswordMatches tells the owner password from the user's and from a wrong one (revision 2)", () => {
  const text = encryptedPdf("user", -3904, "owner-secret").toString("latin1");
  assert.equal(ownerPasswordMatches(text, "owner-secret"), true);
  assert.equal(ownerPasswordMatches(text, "user"), false);
  assert.equal(ownerPasswordMatches(text, ""), false);
  assert.equal(ownerPasswordMatches(encryptedPdf("", -3904, "").toString("latin1"), ""), true);
  assert.equal(ownerPasswordMatches("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n", ""), false);
});

test("ownerPasswordMatches reads /O of the AES-256 revisions (hash of the password, the owner salt and /U)", () => {
  for (const revision of [5, 6] as const) {
    const file = aesPdf(revision, "").toString("latin1");
    const userData = Buffer.from(/\/U <([0-9a-f]+)>/.exec(file)![1]!, "hex").subarray(0, 48);
    const secret = Buffer.from("owner pw", "utf8");
    const salt = filled(8, 41);
    const hash = revision === 5 ? sha256(secret, salt, userData) : hash2B(secret, salt, userData);
    const owner = Buffer.concat([hash, salt, filled(8, 43)]);
    const text = file.replace(/\/O <[0-9a-f]+>/, `/O <${owner.toString("hex")}>`);
    assert.equal(ownerPasswordMatches(text, "owner pw"), true, `revision ${revision}`);
    assert.equal(ownerPasswordMatches(text, ""), false, `revision ${revision}`);
  }
});

test("ownerPasswordMatches reads /O of the AES-128 handler (revision 4)", () => {
  // Algorithm 3 for revision 3+: /O is the user password, padded, encrypted under the owner key.
  const file = aesPdf(4, "").toString("latin1");
  const id = FILE_ID;
  let ownerKey = md5(Buffer.concat([Buffer.from("boss", "latin1"), PADDING]).subarray(0, 32));
  for (let i = 0; i < 50; i++) ownerKey = md5(ownerKey);
  ownerKey = ownerKey.subarray(0, 16);
  let owner: Buffer = PADDING;
  for (let i = 0; i <= 19; i++) owner = rc4(Buffer.from(ownerKey.map((byte) => byte ^ i)), owner);
  // /U depends on /O, so rebuild it the way aesPdf does for revision 4 with this /O.
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  let key = md5(PADDING, owner, permissions, id);
  for (let i = 0; i < 50; i++) key = md5(key);
  let user = rc4(key, md5(PADDING, id));
  for (let i = 1; i <= 19; i++) user = rc4(Buffer.from(key.map((byte) => byte ^ i)), user);
  const text = file
    .replace(/\/O <[0-9a-f]+>/, `/O <${owner.toString("hex")}>`)
    .replace(/\/U <[0-9a-f]+>/, `/U <${Buffer.concat([user, filled(16, 9)]).toString("hex")}>`);
  assert.equal(ownerPasswordMatches(text, "boss"), true);
  assert.equal(ownerPasswordMatches(text, ""), false);
});
