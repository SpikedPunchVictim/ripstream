import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface CorpusSource {
  readonly kind: "generated" | "file";
  readonly generator?: string;
  /** Path relative to the corpus root, for kind "file". */
  readonly path?: string;
}

export interface CorpusEntry {
  readonly id: string;
  readonly mediaType: string;
  readonly source: CorpusSource;
  readonly sha256: string;
  readonly license: string;
  readonly notes?: string;
}

export interface CorpusManifest {
  readonly version: 1;
  readonly entries: readonly CorpusEntry[];
}

export interface CorpusItem extends CorpusEntry {
  readonly bytes: Uint8Array;
}

const GENERATORS: Record<string, () => Uint8Array> = {
  "text-plain": () =>
    new TextEncoder().encode(
      "The quick brown fox jumps over the lazy dog.\nSecond line with unicode: café.\n",
    ),
  "text-csv": () =>
    new TextEncoder().encode(
      'name,age,city\nAda,36,London\nGrace,45,"New York, NY"\n',
    ),
  "application-xml": () =>
    new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n<document><title>Corpus</title><body>Hello XML</body></document>\n',
    ),
  "text-html": () =>
    new TextEncoder().encode(
      "<!doctype html><html><head><title>Corpus Page</title></head><body><p>Hello <b>HTML</b></p><script>bad()</script></body></html>",
    ),
  "application-rtf": () =>
    new TextEncoder().encode(
      "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Corpus RTF\\par}",
    ),
  "xml-truncated": () =>
    new TextEncoder().encode("<root><child>unterminated"),
  "utf8-invalid": () => new Uint8Array([0x41, 0xff, 0xfe, 0x42, 0x00, 0x43]),
  "xml-deep": () => {
    const depth = 200;
    return new TextEncoder().encode(
      `${"<n>".repeat(depth)}value${"</n>".repeat(depth)}`,
    );
  },
  "message-rfc822": () =>
    new TextEncoder().encode(
      "From: Ada <ada@example.com>\r\nTo: Grace <grace@example.com>\r\nSubject: Corpus Mail\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello mail\r\n",
    ),
};

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function loadManifest(json: string): CorpusManifest {
  const value = JSON.parse(json) as unknown;
  validateManifest(value);
  return value;
}

export function validateManifest(value: unknown): asserts value is CorpusManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Corpus manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1) throw new Error("Unsupported corpus manifest version");
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("Corpus manifest needs entries");
  }
  const ids = new Set<string>();
  for (const [index, raw] of manifest.entries.entries()) {
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error(`entries[${index}].id is required`);
    }
    if (ids.has(entry.id)) throw new Error(`duplicate corpus id: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.mediaType !== "string" || entry.mediaType.length === 0) {
      throw new Error(`entries[${index}].mediaType is required`);
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`entries[${index}].sha256 is invalid`);
    }
    if (typeof entry.license !== "string" || entry.license.length === 0) {
      throw new Error(`entries[${index}].license is required`);
    }
    const source = entry.source as Record<string, unknown> | undefined;
    if (source === undefined || (source.kind !== "generated" && source.kind !== "file")) {
      throw new Error(`entries[${index}].source.kind must be generated or file`);
    }
    if (source.kind === "generated" && typeof source.generator !== "string") {
      throw new Error(`entries[${index}].source.generator is required`);
    }
    if (source.kind === "file" && typeof source.path !== "string") {
      throw new Error(`entries[${index}].source.path is required`);
    }
  }
}

export function loadCorpus(
  manifest: CorpusManifest,
  root: string,
): CorpusItem[] {
  return manifest.entries.map((entry) => {
    let bytes: Uint8Array;
    if (entry.source.kind === "generated") {
      const generator = GENERATORS[entry.source.generator ?? ""];
      if (generator === undefined) {
        throw new Error(`Unknown corpus generator: ${entry.source.generator}`);
      }
      bytes = generator();
    } else {
      bytes = new Uint8Array(readFileSync(resolve(root, entry.source.path ?? "")));
    }
    const digest = sha256(bytes);
    if (digest !== entry.sha256) {
      throw new Error(
        `Corpus checksum mismatch for ${entry.id}: expected ${entry.sha256}, got ${digest}`,
      );
    }
    return { ...entry, bytes };
  });
}

export function verifyCorpus(manifest: CorpusManifest, root: string): string[] {
  try {
    loadCorpus(manifest, root);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export { GENERATORS };
