import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { rmetaObjects, type RmetaValue } from "@spikedpunch/ripstream-core";
import type { EmittedDocument, Emitter } from "./index.ts";

/*
 * The emitters that write to a directory.
 *
 * FileSystemEmitter is Tika's file-system-emitter (FileSystemEmitter.java in tika-pipes-file-system): the output is
 * basePath/emitKey, a second write to a file is decided by onExists, and a file only exists once it is whole. The shorthand
 * config's `sink` keeps its own layout, FlatFileEmitter, because the ids of the documents it takes (CSV rows, URLs) are
 * not paths.
 */

const gzipped = promisify(gzip);

export type OnExists = "EXCEPTION" | "SKIP" | "REPLACE";
export type Compression = "NONE" | "GZIP";

export const ON_EXISTS_VALUES: readonly OnExists[] = ["EXCEPTION", "SKIP", "REPLACE"];
export const COMPRESSION_VALUES: readonly Compression[] = ["NONE", "GZIP"];

export interface FileSystemEmitterOptions {
  /** Every emit key resolves under this directory and may not leave it. Needed unless `allowAbsolutePaths`. */
  readonly basePath?: string;
  /** Without a `basePath`, an emit key is the path to write, wherever this process may write. Say so explicitly. */
  readonly allowAbsolutePaths?: boolean;
  /** Appended to the emit key, after a dot, of every document that is metadata or content (not of embedded bytes). Default: none. */
  readonly fileExtension?: string;
  /** What to do when the file is already there. Default EXCEPTION, Tika's: the write fails and the file is left as it was. */
  readonly onExists?: OnExists;
  /** Write to a temporary file in the same directory and rename it into place, so no reader sees half a file. Default true. */
  readonly atomicWrites?: boolean;
  /** GZIP compresses what is written and adds `.gz`, but never to embedded bytes. Default NONE. */
  readonly compression?: Compression;
  /** Write JSON the way Jackson's default pretty printer does. Default false. */
  readonly prettyPrint?: boolean;
}

/** Tika's message for onExists EXCEPTION (TIKA-4736): the path, and what to do about it. */
const alreadyExists = (output: string): Error =>
  new Error(
    `Output already exists (onExists=EXCEPTION, not overwritten): ${resolve(output)}. Use an empty output dir, delete the file, or set onExists to REPLACE or SKIP.`,
  );

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** A file system that cannot hard-link says one of these; the publish then checks and renames instead. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

const exists = (path: string): Promise<boolean> =>
  fsp.stat(path).then(
    () => true,
    (error: unknown) => {
      if (codeOf(error) === "ENOENT") return false;
      throw error;
    },
  );

/** The metadata list of a document: an RMETA document's records, or the one document CONCATENATE and NO_PARSE give. */
export function documentObjects(document: EmittedDocument): readonly Record<string, RmetaValue>[] {
  if (document.records !== undefined) return rmetaObjects(document.records);
  if (document.metadata !== undefined) {
    const content = document.text ?? "";
    return [{ ...document.metadata, ...(content.trim() === "" ? {} : { "tk:content": content }) }];
  }
  throw new Error(`nothing to write for ${JSON.stringify(document.id)}: the document has no bytes, content, metadata or records`);
}

/** The metadata list of a document as JSON. */
export function documentJson(document: EmittedDocument, prettyPrint = false): string {
  const list = documentObjects(document);
  return prettyPrint ? jacksonPretty(list) : JSON.stringify(list);
}

/** Tika's FileSystemEmitter: writes what the engine emits as files named by emit key under a base directory. */
export class FileSystemEmitter implements Emitter {
  readonly #basePath: string | undefined;
  readonly #fileExtension: string;
  readonly #onExists: OnExists;
  readonly #atomicWrites: boolean;
  readonly #gzip: boolean;
  readonly #prettyPrint: boolean;

  constructor(options: FileSystemEmitterOptions) {
    const basePath = options.basePath === undefined || options.basePath.trim() === "" ? undefined : options.basePath;
    if (basePath === undefined && options.allowAbsolutePaths !== true) {
      throw new RangeError(
        "'basePath' must be set, or 'allowAbsolutePaths' must be true. Without basePath, clients can write to any file this process has access to. Set 'allowAbsolutePaths: true' to explicitly allow this behavior and accept the security risks.",
      );
    }
    const onExists = options.onExists ?? "EXCEPTION";
    if (!ON_EXISTS_VALUES.includes(onExists)) throw new RangeError(`onExists must be one of ${ON_EXISTS_VALUES.join(", ")}, got ${String(onExists)}`);
    const compression = options.compression ?? "NONE";
    if (!COMPRESSION_VALUES.includes(compression)) throw new RangeError(`compression must be one of ${COMPRESSION_VALUES.join(", ")}, got ${String(compression)}`);
    this.#basePath = basePath;
    this.#fileExtension = options.fileExtension?.trim() ?? "";
    this.#onExists = onExists;
    this.#atomicWrites = options.atomicWrites ?? true;
    this.#gzip = compression === "GZIP";
    this.#prettyPrint = options.prettyPrint ?? false;
  }

  async emit(document: EmittedDocument): Promise<void> {
    // What is written, and whether the name takes the extension and the compression: Tika's metadata emit does,
    // its stream emit does only for CONTENT_ONLY (an unpacked file keeps the name its key gives it).
    let data: Uint8Array;
    let named: boolean;
    if (document.bytes !== undefined) {
      data = document.bytes;
      named = false;
    } else if (document.mode === "CONTENT_ONLY") {
      data = Buffer.from(document.text ?? "", "utf8");
      named = true;
    } else {
      data = Buffer.from(this.#json(document), "utf8");
      named = true;
    }
    let key = document.id;
    if (named) {
      if (this.#fileExtension !== "") key += `.${this.#fileExtension}`;
      if (this.#gzip) {
        key += ".gz";
        data = await gzipped(data);
      }
    }
    const output = this.#locate(key);
    await fsp.mkdir(dirname(output), { recursive: true });
    if (!this.#atomicWrites) {
      await this.#writeInPlace(output, data);
      return;
    }
    const temporary = `${output}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, data, { flag: "wx" });
      await this.#publish(temporary, output);
    } finally {
      await fsp.rm(temporary, { force: true });
    }
  }

  #json(document: EmittedDocument): string {
    return documentJson(document, this.#prettyPrint);
  }

  #locate(key: string): string {
    if (this.#basePath === undefined) return key;
    const base = resolve(this.#basePath);
    const output = resolve(base, key);
    const rel = relative(base, output);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`path traversal?! ${output}`);
    return output;
  }

  async #writeInPlace(output: string, data: Uint8Array): Promise<void> {
    try {
      // EXCEPTION and SKIP never write over a file; a file that appeared since the check is the other side's.
      await fsp.writeFile(output, data, { flag: this.#onExists === "REPLACE" ? "w" : "wx" });
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      if (this.#onExists === "EXCEPTION") throw alreadyExists(output);
    }
  }

  /** Puts the finished temporary file at `output` in one step, and for EXCEPTION and SKIP never over a file that is there. */
  async #publish(temporary: string, output: string): Promise<void> {
    if (this.#onExists === "REPLACE") {
      await fsp.rename(temporary, output);
      return;
    }
    try {
      // A hard link is created or refused in one step, which a check followed by a rename is not.
      await fsp.link(temporary, output);
      return;
    } catch (error) {
      const code = codeOf(error);
      if (code === "EEXIST") return this.#alreadyThere(output);
      if (code === undefined || !NO_HARD_LINKS.has(code)) throw error;
    }
    if (await exists(output)) return this.#alreadyThere(output);
    await fsp.rename(temporary, output);
  }

  #alreadyThere(output: string): void {
    if (this.#onExists === "EXCEPTION") throw alreadyExists(output);
  }
}

/**
 * JSON as Jackson's default pretty printer writes it, which Tika's `prettyPrint` uses: `"key" : value`, two spaces a
 * level, an array on one line with its objects opened in place (`[ {` ... `}, {` ... `} ]`), `{ }` and `[ ]` when empty.
 * Only an object starts a new indentation level, as Jackson counts it. No newline at the end.
 */
export function jacksonPretty(value: unknown, level = 0): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? "[ ]" : `[ ${value.map((item) => jacksonPretty(item, level)).join(", ")} ]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{ }";
    const inner = "  ".repeat(level + 1);
    const lines = entries.map(([key, item]) => `${inner}${JSON.stringify(key)} : ${jacksonPretty(item, level + 1)}`);
    return `{\n${lines.join(",\n")}\n${"  ".repeat(level)}}`;
  }
  return JSON.stringify(value);
}

/**
 * The shorthand config's `sink`: one flat file per document in a directory, `.bin` for bytes and `.txt` for text, a
 * second write to a name overwrites it. Ids are not paths here (CSV rows, URLs), so an id that has characters a file
 * name should not is sanitized and given a short hash of the raw id, so distinct ids never share a file.
 */
export class FlatFileEmitter implements Emitter {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async emit(document: EmittedDocument): Promise<void> {
    await fsp.mkdir(this.#directory, { recursive: true });
    const safe = document.id.replace(/[^A-Za-z0-9._-]+/g, "_");
    const name =
      safe === document.id
        ? safe || "document"
        : `${safe || "document"}-${createHash("sha1").update(document.id).digest("hex").slice(0, 8)}`;
    if (document.bytes !== undefined) {
      await fsp.writeFile(join(this.#directory, `${name}.bin`), document.bytes);
    } else if (document.text !== undefined) {
      await fsp.writeFile(join(this.#directory, `${name}.txt`), document.text);
    }
  }
}
