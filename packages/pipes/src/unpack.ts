import { TIKA_KEYS, type ParseRecord, type RmetaValue, type UnpackSettings } from "@spikedpunch/ripstream-core";
import { buildUnpackPackage, zipChunks } from "./frictionless.ts";
import type { EmittedDocument } from "./index.ts";

/*
 * What pipes' UNPACK mode emits (tikajs-68os.6.7), as Tika's PipesWorker and UnpackHandlers do it:
 *
 * - FRICTIONLESS, ZIPPED (Tika's default): one zip, `<emitKey>-frictionless.zip`, of `datapackage.json`, `rmeta.json` and
 *   `unpacked/<file>`, the package `/unpack` answers. It replaces `<emitKey>.json`: the metadata list is `rmeta.json`.
 * - FRICTIONLESS, DIRECTORY: the same files, each emitted on its own under `<packageRoot>/`.
 * - REGULAR: the metadata list at the emit key and each embedded document's bytes at `<emitKey>-embed/<id>`.
 *
 * The name of an embedded document follows UnpackConfig: `<emitKey>-embed/<id><suffix>` (`<emitKeyBase><embeddedIdPrefix><id>`
 * with a CUSTOM key base), the id padded with `zeroPadName`. A package names its files by the last segment of that key.
 */

/** UnpackConfig with Tika's defaults filled in. */
export interface ResolvedUnpack {
  readonly outputFormat: "FRICTIONLESS" | "REGULAR";
  readonly outputMode: "ZIPPED" | "DIRECTORY";
  readonly suffixStrategy: "NONE" | "EXISTING" | "DETECTED";
  readonly zeroPadName: number;
  readonly embeddedIdPrefix: string;
  readonly keyBaseStrategy: "DEFAULT" | "CUSTOM";
  readonly emitKeyBase: string;
  readonly includeOriginal: boolean;
  /** Whether a package has `rmeta.json`: Tika's `writesMetadata()`, true for FRICTIONLESS unless set. */
  readonly includeMetadata: boolean;
  readonly packageRoot: string | undefined;
  readonly packageName: string | undefined;
}

export function resolveUnpack(settings: UnpackSettings | undefined): ResolvedUnpack {
  const given = settings ?? {};
  const outputFormat = given.outputFormat ?? "FRICTIONLESS";
  return {
    outputFormat,
    outputMode: given.outputMode ?? "ZIPPED",
    suffixStrategy: given.suffixStrategy ?? "NONE",
    zeroPadName: given.zeroPadName ?? 0,
    embeddedIdPrefix: given.embeddedIdPrefix ?? "-",
    keyBaseStrategy: given.keyBaseStrategy ?? "DEFAULT",
    emitKeyBase: given.emitKeyBase ?? "",
    includeOriginal: given.includeOriginal ?? false,
    includeMetadata: given.includeMetadata ?? outputFormat === "FRICTIONLESS",
    packageRoot: given.packageRoot,
    packageName: given.packageName,
  };
}

/** The extension, dot included, for a media type; `.bin` when there is none. What a registry says. */
export type ExtensionOf = (contentType: string | null) => string;

const DEFAULT_EXTENSION = ".bin";

/** Tika's `FilenameUtils.getSuffixFromPath`: the last name's `.ext` when it has one of 1 to 4 ASCII letters or digits. */
function suffixFromPath(path: string | null): string {
  if (path === null || path === "") return "";
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  if (dot > -1 && name.length - dot < 6 && /^\.[a-z0-9]{1,5}$/i.test(name.slice(dot))) return name.slice(dot);
  return "";
}

/** Tika's `EmbeddedDocumentUtil.normalizeMediaType`: an OCR routing type is the image type it came from. */
const normalizeMediaType = (contentType: string): string => (contentType.startsWith("image/ocr-") ? `image/${contentType.slice("image/ocr-".length)}` : contentType);

/** Tika's `AbstractUnpackHandler.getEmitKey`: the key of the embedded document with this id. */
export function embeddedKey(
  containerKey: string,
  id: number,
  metadata: ParseRecord["metadata"],
  unpack: ResolvedUnpack,
  extensionOf: ExtensionOf,
): string {
  const idText = unpack.zeroPadName > 0 ? String(id).padStart(unpack.zeroPadName, "0") : String(id);
  const base = unpack.keyBaseStrategy === "DEFAULT" ? `${containerKey}-embed/${idText}` : `${unpack.emitKeyBase}${unpack.embeddedIdPrefix}${idText}`;
  if (unpack.suffixStrategy === "EXISTING") return base + suffixFromPath(metadata.get(TIKA_KEYS.RESOURCE_NAME)).toLowerCase();
  if (unpack.suffixStrategy === "DETECTED") {
    const type = metadata.get("Content-Type");
    return base + (type === null ? DEFAULT_EXTENSION : extensionOf(normalizeMediaType(type)));
  }
  return base;
}

/** The last segment of a key: the name of a file in a package. */
const lastSegment = (key: string): string => {
  const at = Math.max(key.lastIndexOf("/"), key.lastIndexOf("\\"));
  return at >= 0 && at < key.length - 1 ? key.slice(at + 1) : key;
};

export interface UnpackInput {
  /** The emit key of the container. */
  readonly emitKey: string;
  /** The fetch key of the container: a package is named after its file name unless `packageName` says otherwise. */
  readonly fetchKey: string;
  /** The container's own bytes, for `includeOriginal`. */
  readonly bytes: Uint8Array;
  /** What the parse made of it, the container first, the embedded documents carrying the bytes that were kept. */
  readonly records: readonly ParseRecord[];
  /** The metadata list as the RMETA emit writes it, as objects: what a REGULAR emit's document carries. */
  readonly objects?: readonly Record<string, RmetaValue>[];
  /** The metadata list as the RMETA emit writes it. */
  readonly rmeta: string;
  readonly unpack: ResolvedUnpack;
  readonly extensionOf: ExtensionOf;
  readonly now: Date;
}

/** The embedded id a record's metadata gives, or null. */
function embeddedIdOf(record: ParseRecord): string | null {
  const text = record.metadata.get(TIKA_KEYS.EMBEDDED_ID);
  return text !== null && /^\d+$/.test(text) ? text : null;
}

/** The documents the engine emits for one UNPACK input. */
export async function unpackDocuments(input: UnpackInput): Promise<EmittedDocument[]> {
  const { emitKey, records, unpack } = input;
  const container = records[0];
  if (unpack.outputFormat === "REGULAR") {
    const documents: EmittedDocument[] = [
      { id: emitKey, mode: "UNPACK", text: input.rmeta, records, ...(input.objects === undefined ? {} : { objects: input.objects }) },
    ];
    // The container is embedded document 0 when asked for; the others are in record order, as they were parsed.
    if (unpack.includeOriginal && container !== undefined) {
      documents.push({ id: embeddedKey(emitKey, 0, container.metadata, unpack, input.extensionOf), mode: "UNPACK", bytes: input.bytes });
    }
    let count = 0;
    for (const record of records) {
      if (record.bytes === undefined) continue;
      const id = embeddedIdOf(record) ?? String(++count);
      documents.push({ id: embeddedKey(emitKey, Number(id), record.metadata, unpack, input.extensionOf), mode: "UNPACK", bytes: record.bytes });
    }
    return documents;
  }

  const rmeta = unpack.includeMetadata ? new TextEncoder().encode(input.rmeta) : null;
  const pkg = buildUnpackPackage({
    records,
    container: unpack.includeOriginal ? input.bytes : null,
    // Tika: the host's name, else the fetch key's file name; blank is no name.
    filename: unpack.packageName ?? lastSegment(input.fetchKey),
    rmeta,
    nameOf: (id, record) => lastSegment(embeddedKey(emitKey, id, record.metadata, unpack, input.extensionOf)),
    now: input.now,
  });
  if (unpack.outputMode === "ZIPPED") {
    const chunks: Buffer[] = [];
    for await (const chunk of zipChunks(pkg)) chunks.push(chunk);
    return [{ id: `${emitKey}-frictionless.zip`, mode: "UNPACK", bytes: Buffer.concat(chunks) }];
  }
  const root = unpack.packageRoot ?? emitKey;
  const prefix = root === "" ? "" : `${root}/`;
  // Tika's order: the unpacked files, then datapackage.json, then rmeta.json.
  const unpacked = pkg.files.filter((file) => file.path.startsWith("unpacked/"));
  const manifest = ["datapackage.json", "rmeta.json"].flatMap((name) => pkg.files.filter((file) => file.path === name));
  return [...unpacked, ...manifest].map((file) => ({ id: `${prefix}${file.path}`, mode: "UNPACK" as const, bytes: file.bytes }));
}
