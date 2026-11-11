import { randomUUID } from "node:crypto";
import type { RmetaValue, SolrConnectionSettings, SolrEmitterSettings, SolrIteratorSettings } from "@spikedpunch/ripstream-core";
import type { EmittedDocument, Emitter } from "../index.ts";
import { documentObjects } from "../file-system-emitter.ts";
import type { FetchEmitTuple, PipesIterator } from "../tuple.ts";
import { SolrClient } from "./client.ts";

/*
 * Tika's solr-emitter and solr-pipes-iterator (tika-pipes-solr 4.2.0), over `SolrClient`. Tika uses SolrJ; these send the
 * same documents to Solr's JSON update handler and the same cursor query to `/select` with `fetch`, so ripstream has no
 * Solr dependency. Only `solrUrls` is read: SolrCloud through ZooKeeper needs a ZooKeeper client.
 */

/** The seams a test replaces: the network and the ids Tika draws at random for embedded documents. */
export interface SolrTransport {
  readonly fetchImpl?: typeof fetch;
  readonly randomId?: () => string;
}

export function solrClientFor(connection: SolrConnectionSettings, transport: SolrTransport = {}): SolrClient {
  return new SolrClient(connection, transport.fetchImpl === undefined ? {} : { fetchImpl: transport.fetchImpl });
}

/** Sets a field, as a data property, so that a field named `__proto__` is one too and a later value replaces an earlier. */
function setField(doc: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(doc, name, { value, enumerable: true, writable: true, configurable: true });
}

export interface SolrEmitterOptions {
  readonly settings: SolrEmitterSettings;
  readonly transport?: SolrTransport;
}

/**
 * Tika's SolrEmitter. The emit key is the value of `idField`; the metadata list is one document, or under PARENT_CHILD
 * the container with its embedded documents as child documents of `embeddedFileFieldName`, or under SEPARATE_DOCUMENTS
 * one document each, with the ids `emitKey-<uuid>`. A field of one value is a plain value and of several an array; under
 * an update strategy each is `{"set": value}` and the container has `_version_` 1 (the document must exist) or -1 (it
 * must not). One request is sent for a document: ripstream's emitters get one document at a time.
 */
export class SolrEmitter implements Emitter {
  readonly #settings: SolrEmitterSettings;
  readonly #client: SolrClient;
  readonly #randomId: () => string;

  constructor(options: SolrEmitterOptions) {
    this.#settings = options.settings;
    this.#client = solrClientFor(options.settings.solr, options.transport);
    this.#randomId = options.transport?.randomId ?? randomUUID;
  }

  async emit(document: EmittedDocument): Promise<void> {
    if (document.bytes !== undefined || document.mode === "CONTENT_ONLY") {
      throw new Error(`solr-emitter indexes metadata documents: it cannot emit ${document.bytes === undefined ? "the content" : "the bytes"} of ${JSON.stringify(document.id)}`);
    }
    const list = documentObjects(document);
    // Tika warns about an empty list and returns.
    if (list.length === 0) return;
    await this.#client.update(this.#documents(document.id, list), { commitWithin: this.#settings.commitWithin });
  }

  #documents(emitKey: string, list: readonly Readonly<Record<string, RmetaValue>>[]): Array<Record<string, unknown>> {
    const { idField, updateStrategy, attachmentStrategy, embeddedFileFieldName } = this.#settings;
    const [container, ...embedded] = list;
    const root: Record<string, unknown> = {};
    setField(root, idField, emitKey);
    if (updateStrategy === "UPDATE_MUST_EXIST") setField(root, "_version_", 1);
    else if (updateStrategy === "UPDATE_MUST_NOT_EXIST") setField(root, "_version_", -1);
    this.#addMetadata(root, container ?? {});
    if (embedded.length === 0) return [root];
    const children = embedded.map((entry) => {
      const child: Record<string, unknown> = {};
      setField(child, idField, `${emitKey}-${this.#randomId()}`);
      this.#addMetadata(child, entry);
      return child;
    });
    if (attachmentStrategy === "PARENT_CHILD") {
      setField(root, embeddedFileFieldName, children);
      return [root];
    }
    return [root, ...children];
  }

  #addMetadata(doc: Record<string, unknown>, entry: Readonly<Record<string, RmetaValue>>): void {
    for (const [name, value] of Object.entries(entry)) {
      const values = (Array.isArray(value) ? value : [value]).map(String);
      if (values.length === 0) continue;
      const field = values.length === 1 ? values[0] : values;
      setField(doc, name, this.#settings.updateStrategy === "ADD" ? field : { set: field });
    }
  }
}

export interface SolrPipesIteratorOptions {
  readonly settings: SolrIteratorSettings;
  readonly transport?: SolrTransport;
}

/**
 * Tika's SolrPipesIterator: `q=*:*` sorted by `parsingIdField asc, id asc`, with the `filters` as `fq`, read a cursor
 * (`cursorMark`) at a time of `rows` documents until Solr gives the cursor back as it was sent. Each document is a tuple
 * whose id, fetch key and emit key are the string in its `idField`. The fields that are asked for besides that one
 * (Tika asks for them and then does not use them) are asked for here too. Where Tika logs a failure of Solr and ends the
 * enumeration as if it were complete, this throws.
 */
export class SolrPipesIterator implements PipesIterator {
  readonly #settings: SolrIteratorSettings;
  readonly #client: SolrClient;

  constructor(options: SolrPipesIteratorOptions) {
    this.#settings = options.settings;
    this.#client = solrClientFor(options.settings.solr, options.transport);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<FetchEmitTuple> {
    const { idField, parsingIdField, failCountField, sizeFieldName, additionalFields, filters, rows, fetcherId, emitterId } = this.#settings;
    const fields = [...new Set(["id", idField, parsingIdField, failCountField, sizeFieldName, ...additionalFields])];
    let cursorMark = "*";
    for (;;) {
      const page = await this.#client.select([
        ["q", "*:*"],
        ["rows", String(rows)],
        ["fl", fields.join(",")],
        ["sort", `${parsingIdField} asc,id asc`],
        ...filters.map((filter): readonly [string, string] => ["fq", filter]),
        ["cursorMark", cursorMark],
      ]);
      for (const doc of page.docs) {
        const key = doc[idField];
        if (typeof key !== "string") throw new Error(`Solr document ${JSON.stringify(doc.id)} has no string in its ${idField} field`);
        yield { id: key, fetcher: fetcherId, fetchKey: key, emitter: emitterId, emitKey: key };
      }
      if (page.nextCursorMark === undefined) throw new Error("Solr select answered with no nextCursorMark");
      if (page.nextCursorMark === cursorMark) return;
      cursorMark = page.nextCursorMark;
    }
  }
}
