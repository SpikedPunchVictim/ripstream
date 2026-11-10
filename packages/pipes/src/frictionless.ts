import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { crc32, deflateRaw } from "node:zlib";
import { LimitExceededError, TIKA_KEYS, type ParseRecord } from "@spikedpunch/ripstream-core";

/*
 * Tika's "frictionless" package, which `/unpack` answers and pipes' UNPACK emits: a zip of `datapackage.json`,
 * `rmeta.json` (what `/rmeta` answers for the document) and `unpacked/<file>` for every embedded document, in that order.
 * The writer is Tika's own shape (deflated entries with a data descriptor, UTF-8 names), built with what Node has. What a
 * file is called, and whether `rmeta.json` is there, is the caller's: `/unpack` names them `<id><extension>`, pipes by its
 * UnpackConfig.
 */

const deflate = promisify(deflateRaw);

/** One file of the package. */
export interface PackageFile {
  /** Its name in the zip. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface UnpackPackage {
  readonly files: readonly PackageFile[];
  /** The time written into the manifest and onto every entry. */
  readonly created: Date;
}

export interface UnpackInput {
  /** The parse records of the document, the container first, the embedded documents carrying their `bytes`. */
  readonly records: readonly ParseRecord[];
  /** The request's own document, added as `unpacked/0` (Tika's `/unpack/all`); null leaves it out. */
  readonly container: Uint8Array | null;
  /** The name the request gave the document, if any; the package is named after it. */
  readonly filename: string | undefined;
  /** What `/rmeta` answers for `records`; null leaves `rmeta.json` out (Tika's `includeMetadata` false). */
  readonly rmeta: Uint8Array | null;
  /** The name, under `unpacked/`, of the document with this embedded id (0 is the container) and its record. */
  readonly nameOf: (id: number, record: ParseRecord) => string;
  readonly now: Date;
}

const MAX_ZIP_ENTRIES = 0xffff;
const MAX_ZIP_BYTES = 0xffffffff;

/** A name as Frictionless wants one: lower case, `[a-z0-9._-]`. */
const resourceName = (path: string): string => path.toLowerCase().replace(/[^a-z0-9._-]/g, "-");

/** The package's name, from the name the request gave the document; null for none (Tika leaves the field out). */
export function packageName(filename: string | undefined): string | null {
  if (filename === undefined || filename.trim() === "") return null;
  return filename.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-");
}

/** The media type of a `Content-Type`, without its parameters; octet-stream when there is none. */
function mediaTypeOf(contentType: string | null): string {
  const bare = contentType?.split(";")[0]?.trim() ?? "";
  return bare === "" ? "application/octet-stream" : bare;
}

interface Resource {
  readonly path: string;
  readonly mediatype: string;
  readonly bytes: Uint8Array;
  readonly hash: string;
  readonly embeddedId?: number;
  readonly resourceName?: string;
}

const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * Jackson's pretty printer, which Tika writes the manifest with: `"key" : value`, two spaces a level, an array of
 * objects as `[ {` ... `}, {` ... `} ]`. No newline at the end.
 */
function manifestJson(name: string | null, created: Date, resources: readonly Resource[]): string {
  const when = `${created.toISOString().slice(0, 19)}Z`;
  const lines = (resource: Resource): string => {
    const fields: Array<[string, string]> = [
      ["name", JSON.stringify(resourceName(resource.path))],
      ["path", JSON.stringify(resource.path)],
      ["mediatype", JSON.stringify(resource.mediatype)],
      ["bytes", String(resource.bytes.length)],
      ["hash", JSON.stringify(resource.hash)],
    ];
    if (resource.embeddedId !== undefined) fields.push(["tk:embedded-id", String(resource.embeddedId)]);
    if (resource.resourceName !== undefined) fields.push(["tk:resource-name", JSON.stringify(resource.resourceName)]);
    return fields.map(([key, value]) => `    ${JSON.stringify(key)} : ${value}`).join(",\n");
  };
  const header = [...(name === null ? [] : [`  "name" : ${JSON.stringify(name)}`]), `  "created" : ${JSON.stringify(when)}`];
  return `{\n${header.join(",\n")},\n  "resources" : [ {\n${resources.map(lines).join("\n  }, {\n")}\n  } ]\n}`;
}

/** The id Tika's embedded-document counter gave a record, as its metadata says; null for a record without one. */
function embeddedIdOf(record: ParseRecord): number | null {
  const text = record.metadata.get(TIKA_KEYS.EMBEDDED_ID);
  if (text === null || !/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The files of an unpack answer. Embedded documents come in id order, whatever order their records came in; one the
 * parse did not keep the bytes of (over the budget, or never opened) is not in the package, as its record in
 * `rmeta.json` still says it was there.
 */
export function buildUnpackPackage(input: UnpackInput): UnpackPackage {
  const resources: Resource[] =
    input.rmeta === null ? [] : [{ path: "rmeta.json", mediatype: "application/json", bytes: input.rmeta, hash: sha256(input.rmeta) }];
  const parts: Array<{ id: number; resource: Resource }> = [];

  const container = input.records[0];
  if (input.container !== null && container !== undefined) {
    const contentType = container.metadata.get("Content-Type");
    parts.push({
      id: 0,
      resource: {
        path: `unpacked/${input.nameOf(0, container)}`,
        mediatype: mediaTypeOf(contentType),
        bytes: input.container,
        hash: sha256(input.container),
        embeddedId: 0,
      },
    });
  }
  for (const record of input.records.slice(1)) {
    const { bytes } = record;
    const id = embeddedIdOf(record);
    if (bytes === undefined || id === null) continue;
    const contentType = record.metadata.get("Content-Type");
    const name = record.metadata.get(TIKA_KEYS.RESOURCE_NAME);
    parts.push({
      id,
      resource: {
        path: `unpacked/${input.nameOf(id, record)}`,
        mediatype: mediaTypeOf(contentType),
        bytes,
        hash: sha256(bytes),
        embeddedId: id,
        ...(name === null || name === "" ? {} : { resourceName: name }),
      },
    });
  }
  parts.sort((a, b) => a.id - b.id);
  resources.push(...parts.map((part) => part.resource));

  const manifest = new TextEncoder().encode(manifestJson(packageName(input.filename), input.now, resources));
  const files: PackageFile[] = [
    { path: "datapackage.json", bytes: manifest },
    ...resources.map((resource) => ({ path: resource.path, bytes: resource.bytes })),
  ];
  if (files.length > MAX_ZIP_ENTRIES) {
    throw new LimitExceededError(`The package would have ${files.length} files, more than a zip holds (${MAX_ZIP_ENTRIES})`);
  }
  // Said now, before the answer starts: a zip that outgrows its 32-bit offsets cannot be reported once it is streaming.
  const worstCase = files.reduce((sum, file) => sum + zippedSizeBound(file), 0);
  if (worstCase > MAX_ZIP_BYTES) {
    throw new LimitExceededError(`The package could be larger than a zip holds (${MAX_ZIP_BYTES} bytes); lower maxUnpackBytes`);
  }
  return { files, created: input.now };
}

/** The most a file takes in the zip: deflate's worst case (stored blocks, 5 bytes each 16000), the headers, the name twice. */
function zippedSizeBound(file: PackageFile): number {
  const name = Buffer.byteLength(file.path, "utf8");
  return file.bytes.length + Math.ceil(file.bytes.length / 16000) * 5 + 16 + (30 + 16 + 46) + 2 * name;
}

/** MS-DOS date and time, from the UTC fields (a zip has no zone; UTC keeps the same request the same). */
function dosDateTime(when: Date): { date: number; time: number } {
  const year = Math.min(Math.max(when.getUTCFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate(),
    time: (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1),
  };
}

const UTF8_AND_DESCRIPTOR = 0x0808; // bit 11: UTF-8 names; bit 3: sizes and CRC follow the data
const DEFLATED = 8;

/**
 * The package as a zip, in pieces, one file deflated at a time so that what is held beyond the files themselves is the
 * compressed form of one of them. Entries carry a data descriptor after the data, as Tika's do.
 */
export async function* zipChunks(pkg: UnpackPackage): AsyncGenerator<Buffer> {
  const { date, time } = dosDateTime(pkg.created);
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of pkg.files) {
    const name = Buffer.from(file.path, "utf8");
    const packed = await deflate(file.bytes);
    const crc = crc32(file.bytes);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_AND_DESCRIPTOR, 6);
    local.writeUInt16LE(DEFLATED, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(packed.length, 8);
    descriptor.writeUInt32LE(file.bytes.length, 12);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(UTF8_AND_DESCRIPTOR, 8);
    entry.writeUInt16LE(DEFLATED, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    central.push(entry);

    offset += local.length + packed.length + descriptor.length;
    if (offset > MAX_ZIP_BYTES) throw new LimitExceededError(`The package is larger than a zip holds (${MAX_ZIP_BYTES} bytes)`);
    yield local;
    yield packed;
    yield descriptor;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(pkg.files.length, 8);
  end.writeUInt16LE(pkg.files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield directory;
  yield end;
}
