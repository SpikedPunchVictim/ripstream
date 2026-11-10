import { randomUUID } from "node:crypto";
import { metadataKeyDefinition, type RmetaValue, type SearchEmitterSettings } from "@spikedpunch/ripstream-core";
import type { EmittedDocument, Emitter } from "../index.ts";
import { documentObjects } from "../file-system-emitter.ts";

/*
 * Tika's es-emitter and opensearch-emitter (tika-pipes-es and tika-pipes-opensearch 4.2.0). Both build a `_bulk` request, one
 * action line and one document line for each entry of the metadata list, and POST it to `<index url>/_bulk` over plain HTTP;
 * these do the same with `fetch`, so ripstream has no client library of either to carry.
 */

/** The seams a test replaces: the network and the ids Tika draws at random for embedded documents. */
export interface SearchTransport {
  readonly fetchImpl?: typeof fetch;
  readonly randomId?: () => string;
}

/** What `_bulk` answered when it was not a success: the HTTP status, so that a rejected request (429, 5xx) is retried. */
export class SearchError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SearchError";
    this.status = status;
  }
}

type Fields = ReadonlyArray<readonly [string, string]>;

/** An object from fields whose values are JSON already. Two fields of one name are both written, as Tika's generator does. */
const objectOf = (fields: Fields): string => `{${fields.map(([name, json]) => `${JSON.stringify(name)}:${json}`).join(",")}}`;

/** An array or an object with nothing after it: anything else, a string with a closing bracket and more fields, stays a string. */
function isValidJson(value: string): boolean {
  if (value === "" || (value[0] !== "[" && value[0] !== "{")) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** A key whose value is a JSON document (`tk:chunks`) is written as one, so that the index can map its fields. */
const isJsonField = (name: string): boolean => metadataKeyDefinition(name)?.valueType === "JSON";

function metadataFields(entry: Readonly<Record<string, RmetaValue>>): Fields {
  const fields: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(entry)) {
    const values = (Array.isArray(value) ? value : [value]).map(String);
    if (values.length === 1) {
      const only = values[0] ?? "";
      fields.push([name, isJsonField(name) && isValidJson(only) ? only : JSON.stringify(only)]);
    } else {
      fields.push([name, `[${values.map((item) => JSON.stringify(item)).join(",")}]`]);
    }
  }
  return fields;
}

export interface BulkSearchEmitterOptions {
  readonly settings: SearchEmitterSettings;
  readonly transport?: SearchTransport;
}

/** The longest stretch of an error response that goes into a message. */
const MESSAGE_LIMIT = 1000;

const clipped = (value: string): string => (value.length > MESSAGE_LIMIT ? `${value.slice(0, MESSAGE_LIMIT)}… (${value.length - MESSAGE_LIMIT} more characters)` : value);

export class BulkSearchEmitter implements Emitter {
  readonly #settings: SearchEmitterSettings;
  readonly #fetch: typeof fetch;
  readonly #randomId: () => string;
  readonly #label: string;
  readonly #authorization: string | undefined;

  constructor(options: BulkSearchEmitterOptions) {
    const { settings, transport } = options;
    this.#settings = settings;
    this.#fetch = transport?.fetchImpl ?? fetch;
    this.#randomId = transport?.randomId ?? randomUUID;
    this.#label = settings.type;
    this.#authorization =
      settings.apiKey !== undefined
        ? `ApiKey ${settings.apiKey}`
        : settings.userName !== undefined
          ? `Basic ${Buffer.from(`${settings.userName}:${settings.password ?? ""}`, "utf8").toString("base64")}`
          : undefined;
  }

  /** The action line and the document line of one entry, as Tika's InsertMetadataToJsonWriter and UpsertMetadataToJsonWriter write them. */
  #entryLines(id: string, routing: string | undefined, fields: Fields): string {
    const upsert = this.#settings.updateStrategy === "UPSERT";
    const action: Array<readonly [string, string]> = [["_id", JSON.stringify(id)]];
    if (routing !== undefined && routing !== "") action.push(["routing", JSON.stringify(routing)]);
    if (upsert) action.push(["retry_on_conflict", "3"]);
    const body = objectOf(fields);
    return `${objectOf([[upsert ? "update" : "index", objectOf(action)]])}\n${upsert ? objectOf([["doc", body], ["doc_as_upsert", "true"]]) : body}\n`;
  }

  #bulkBody(emitKey: string, list: readonly Readonly<Record<string, RmetaValue>>[]): string {
    const { attachmentStrategy, embeddedFileFieldName } = this.#settings;
    const routing = attachmentStrategy === "PARENT_CHILD" ? emitKey : undefined;
    let body = "";
    list.forEach((entry, index) => {
      const fields = [...metadataFields(entry)];
      if (index === 0) {
        if (attachmentStrategy === "PARENT_CHILD") fields.push(["relation_type", JSON.stringify("container")]);
      } else if (attachmentStrategy === "PARENT_CHILD") {
        fields.push(["relation_type", objectOf([["name", JSON.stringify(embeddedFileFieldName)], ["parent", JSON.stringify(emitKey)]])]);
      } else if (attachmentStrategy === "SEPARATE_DOCUMENTS") {
        fields.push(["parent", JSON.stringify(emitKey)]);
      }
      body += this.#entryLines(index === 0 ? emitKey : `${emitKey}-${this.#randomId()}`, routing, fields);
    });
    return body;
  }

  async emit(document: EmittedDocument): Promise<void> {
    if (document.bytes !== undefined || document.mode === "CONTENT_ONLY") {
      throw new SearchError(`${this.#label} indexes metadata documents: it cannot emit ${document.bytes === undefined ? "the content" : "the bytes"} of ${JSON.stringify(document.id)}`);
    }
    const list = documentObjects(document);
    if (list.length === 0) return;
    const { url, socketTimeoutMillis } = this.#settings;
    const response = await this.#fetch(`${url}/_bulk`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json; charset=utf-8",
        ...(this.#authorization === undefined ? {} : { authorization: this.#authorization }),
      },
      body: this.#bulkBody(document.id, list),
      // The credentials go to the URL the operator set and to no other: a redirect is an error to fix in the settings.
      redirect: "error",
      ...(socketTimeoutMillis === undefined ? {} : { signal: AbortSignal.timeout(socketTimeoutMillis) }),
    });
    const answer = await response.text();
    if (response.status !== 200) throw new SearchError(`${this.#label} _bulk ${response.status}: ${clipped(answer)}`, response.status);
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer);
    } catch {
      throw new SearchError(`${this.#label} _bulk answered 200 with a body that is not JSON: ${clipped(answer)}`);
    }
    // `errors` is what the service sets when any one entry failed; the request as a whole is then 200. Nothing here retries it:
    // the entries that did succeed would be indexed again, and an embedded document's id is drawn anew each time.
    if (typeof parsed === "object" && parsed !== null && (parsed as { errors?: unknown }).errors === true) {
      throw new SearchError(`${this.#label} _bulk reported errors: ${clipped(answer)}`);
    }
  }
}
