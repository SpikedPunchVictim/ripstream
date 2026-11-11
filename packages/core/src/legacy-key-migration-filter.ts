import {
  METADATA_MIGRATION_DROPPED,
  METADATA_MIGRATION_ROWS,
  type MetadataMigrationRow,
} from "./generated/metadata-migration.ts";
import { MetadataFilterBase } from "./metadata-filter.ts";
import type { Metadata } from "./metadata.ts";

/** `V4_TO_V3` rewrites 4.x keys to their 3.x spellings (what a consumer pinned to 3.x reads); `V3_TO_V4` the other way. */
export type LegacyKeyMigrationDirection = "V4_TO_V3" | "V3_TO_V4";

export interface LegacyKeyMigrationOptions {
  /** Default `V4_TO_V3`. */
  readonly direction?: LegacyKeyMigrationDirection;
  /**
   * The table to migrate by in place of the one Tika ships. Tika reads its table from a classpath resource named in its
   * `table` setting; there is no classpath here, so the rows themselves are given.
   */
  readonly rows?: readonly MetadataMigrationRow[];
}

type KeyRule = (name: string) => string | null;

// 4.x digest keys name the algorithm as the JCA does; 3.x used the enum name. MD2 and MD5 are the same in both.
const DIGEST_ALGORITHMS_V4_TO_V3: ReadonlyMap<string, string> = new Map([
  ["SHA-1", "SHA1"],
  ["SHA-256", "SHA256"],
  ["SHA-384", "SHA384"],
  ["SHA-512", "SHA512"],
  ["SHA3-256", "SHA3_256"],
  ["SHA3-384", "SHA3_384"],
  ["SHA3-512", "SHA3_512"],
]);
const V4_DIGEST = "tk:digest:";
const V3_DIGEST = "X-TIKA:digest:";

// [4.x prefix, 3.x prefix]: the rest of the key, which a document or a tool chose, carries through as it is.
const PREFIX_SWAPS_FIRST: ReadonlyArray<readonly [string, string]> = [
  ["ner:", "NER_"],
  ["envi:", "envi."],
  ["ogg:streams-", "streams-"],
  ["iwork:", "iworks:"],
  ["dif:DIF-", "DIF-"],
  ["mdb-prop:", "MDB_PROP:"],
  ["mdb-user-prop:", "MDB_USER_PROP:"],
  ["mdb-summary-prop:", "MDB_SUMMARY_PROP:"],
  ["message:raw-header:", "Message:Raw-Header:"],
  ["rtf:pict:", "rtf_pict:"],
  ["icc:", "ICC:"],
  ["mbox:", "MboxParser-"],
];

// Families whose 3.x keys had no prefix at all. Nothing marks a bare 3.x key as one of them, so these apply on the way out
// only. A key with a row of its own (hdf:file-type-description, the fixed gdal: keys, html:scriptSrc) is found by that row
// first, so only the open remainder of a family reaches the strip.
const EGRESS_STRIPS: readonly string[] = ["hdf:", "netcdf:", "gdal:", "isatab:", "mp4:", "network:", "audio:", "html:", "img:"];

// One step straight to the 3.x spelling, not a chain through the spelling in between.
const PREFIX_SWAPS_LAST: ReadonlyArray<readonly [string, string]> = [
  ["iso19115:keywords:", "Keywords "],
  ["iso19115:keywords-type:", "KeywordsType "],
  ["iso19115:thesaurus-name-title:", "ThesaurusNameTitle "],
  ["iso19115:thesaurus-name-alternative-title:", "ThesaurusNameAlternativeTitle "],
];

// GeoParser's alternate locations: the 3.x key upper-cased the word and had no `alt-`, and the index is open-ended.
const GEOTOPIC_V4 = /^geotopic:alt-(name|longitude|latitude)(\d+)$/;
const GEOTOPIC_V3 = /^Optional_(NAME|LONGITUDE|LATITUDE)(\d+)$/;

function prefixSwap(egress: boolean, v4Prefix: string, v3Prefix: string): KeyRule {
  const from = egress ? v4Prefix : v3Prefix;
  const to = egress ? v3Prefix : v4Prefix;
  return (name) => (name.startsWith(from) ? to + name.slice(from.length) : null);
}

function egressStrip(egress: boolean, v4Prefix: string): KeyRule {
  if (!egress) return () => null;
  return (name) => (name.startsWith(v4Prefix) ? name.slice(v4Prefix.length) : null);
}

function geotopicAlternateLocation(egress: boolean): KeyRule {
  if (egress) {
    return (name) => {
      const match = GEOTOPIC_V4.exec(name);
      return match === null ? null : `Optional_${match[1]!.toUpperCase()}${match[2]}`;
    };
  }
  return (name) => {
    const match = GEOTOPIC_V3.exec(name);
    return match === null ? null : `geotopic:alt-${match[1]!.toLowerCase()}${match[2]}`;
  };
}

/** `tk:digest:<algorithm>[:<encoding>]` and `X-TIKA:digest:<algorithm>[:<encoding>]`: the algorithm is renamed, the encoding kept. */
function digest(egress: boolean): KeyRule {
  const from = egress ? V4_DIGEST : V3_DIGEST;
  const to = egress ? V3_DIGEST : V4_DIGEST;
  const algorithms = new Map<string, string>();
  for (const [v4, v3] of DIGEST_ALGORITHMS_V4_TO_V3) algorithms.set(egress ? v4 : v3, egress ? v3 : v4);
  return (name) => {
    if (!name.startsWith(from)) return null;
    const rest = name.slice(from.length);
    const colon = rest.indexOf(":");
    const algorithm = colon < 0 ? rest : rest.slice(0, colon);
    const encoding = colon < 0 ? "" : rest.slice(colon);
    return to + (algorithms.get(algorithm) ?? algorithm) + encoding;
  };
}

function prefixRules(egress: boolean): readonly KeyRule[] {
  return [
    digest(egress),
    ...PREFIX_SWAPS_FIRST.map(([v4, v3]) => prefixSwap(egress, v4, v3)),
    ...EGRESS_STRIPS.map((prefix) => egressStrip(egress, prefix)),
    ...PREFIX_SWAPS_LAST.map(([v4, v3]) => prefixSwap(egress, v4, v3)),
    geotopicAlternateLocation(egress),
  ];
}

function checkRow(row: MetadataMigrationRow, index: number): void {
  for (const side of ["v3", "v4"] as const) {
    const key = row[side];
    if (typeof key !== "string" || key === "") {
      throw new RangeError(`Migration row ${index}: '${side}' must be a key name, not ${JSON.stringify(key)}`);
    }
  }
}

/**
 * Rewrites 4.x metadata keys to the spellings Tika 3.x used, or the other way round, for a consumer that still reads one
 * set (Tika's `LegacyKeyMigrationFilter`). Three things do it, in this order for each key: the table of renamed keys that
 * Tika ships (`ripstream`'s copy is generated from Tika's own file), then rules for the families a table cannot list
 * (digests, the `ner:` and `envi:` style prefixes, GeoParser's alternate locations), and a key neither names is left as
 * it is. A key 3.x spelled with no prefix is renamed on the way out only. Values keep their order and are added to those
 * the target key already has.
 */
export class LegacyKeyMigrationFilter extends MetadataFilterBase {
  readonly #renames = new Map<string, string>();
  readonly #drops = new Set<string>();
  readonly #rules: readonly KeyRule[];

  constructor(options: LegacyKeyMigrationOptions = {}) {
    super();
    const direction = options.direction ?? "V4_TO_V3";
    if (direction !== "V4_TO_V3" && direction !== "V3_TO_V4") {
      throw new RangeError(`Unknown direction ${JSON.stringify(direction)}: it is V4_TO_V3 or V3_TO_V4`);
    }
    const egress = direction === "V4_TO_V3";
    const rows = options.rows ?? METADATA_MIGRATION_ROWS;
    rows.forEach((row, index) => {
      checkRow(row, index);
      const dropped = row.v4 === METADATA_MIGRATION_DROPPED;
      if (egress) {
        if (!dropped) this.#renames.set(row.v4, row.v3);
      } else if (row.egressOnly !== true) {
        if (dropped) this.#drops.add(row.v3);
        else this.#renames.set(row.v3, row.v4);
      }
    });
    this.#rules = prefixRules(egress);
  }

  protected override filterOne(metadata: Metadata): void {
    for (const name of metadata.names()) {
      if (this.#drops.has(name)) {
        metadata.remove(name);
        continue;
      }
      const target = this.#renames.get(name) ?? this.#byRule(name);
      if (target !== null && target !== name) {
        const values = [...metadata.getAll(name)];
        metadata.remove(name);
        for (const value of values) metadata.add(target, value);
      }
    }
  }

  #byRule(name: string): string | null {
    for (const rule of this.#rules) {
      const target = rule(name);
      if (target !== null) return target;
    }
    return null;
  }
}
