/*
 * The `unpack-config` component of a Tika `parse-context` section (tika-pipes-core 4.2.0: UnpackConfig). It says what
 * pipes' UNPACK mode emits: by default (FRICTIONLESS, ZIPPED) one zip, `<emitKey>-frictionless.zip`, of `datapackage.json`,
 * `rmeta.json` and `unpacked/<file>`; with `outputFormat: "REGULAR"`, each embedded document's bytes under its own key.
 *
 * Every key here is optional and is absent from the settings when the configuration leaves it out, so the engine's
 * defaults (Tika's) apply. A key ripstream cannot honor is refused by name with the reason.
 */

export const UNPACK_OUTPUT_FORMATS = ["FRICTIONLESS", "REGULAR"] as const;
export const UNPACK_OUTPUT_MODES = ["ZIPPED", "DIRECTORY"] as const;
export const UNPACK_SUFFIX_STRATEGIES = ["NONE", "EXISTING", "DETECTED"] as const;
export const UNPACK_KEY_BASE_STRATEGIES = ["DEFAULT", "CUSTOM"] as const;

export interface UnpackSettings {
  /** FRICTIONLESS (Tika's default): a Frictionless data package. REGULAR: each embedded document's bytes under its own key. */
  readonly outputFormat?: (typeof UNPACK_OUTPUT_FORMATS)[number];
  /** FRICTIONLESS only. ZIPPED (default): one zip at `<emitKey>-frictionless.zip`. DIRECTORY: its files, under `packageRoot`. */
  readonly outputMode?: (typeof UNPACK_OUTPUT_MODES)[number];
  /** What follows an embedded document's id in its name: NONE (default), the EXISTING name's suffix, or the DETECTED type's. */
  readonly suffixStrategy?: (typeof UNPACK_SUFFIX_STRATEGIES)[number];
  /** Pads the id with zeros to this many digits. Default 0: none. */
  readonly zeroPadName?: number;
  /** CUSTOM key base only: what comes between `emitKeyBase` and the id. Default `-`. */
  readonly embeddedIdPrefix?: string;
  /** DEFAULT (default): `<emitKey>-embed/<id>`. CUSTOM: `<emitKeyBase><embeddedIdPrefix><id>`. */
  readonly keyBaseStrategy?: (typeof UNPACK_KEY_BASE_STRATEGIES)[number];
  readonly emitKeyBase?: string;
  /** Adds the container itself as embedded document 0. Default false. */
  readonly includeOriginal?: boolean;
  /** FRICTIONLESS: whether the package has `rmeta.json`. Default true. */
  readonly includeMetadata?: boolean;
  /** FRICTIONLESS, DIRECTORY: the emit key prefix of the package. Default the container's emit key; empty is the emitter's root. */
  readonly packageRoot?: string;
  /** FRICTIONLESS: the package's `name`. Default the fetch key's file name; blank leaves the name out. */
  readonly packageName?: string;
  /** The most bytes of embedded documents kept from one input. */
  readonly maxUnpackBytes?: number;
}

const REFUSED: Readonly<Record<string, string>> = {
  emitter:
    "ripstream emits the package and the files through the tuple's own emitter; Tika's setting names another emitter for them",
  zipEmbeddedFiles: "ripstream's REGULAR output is each document emitted on its own; Tika's flag zips them with sidecars into `<emitKey>-embedded.zip`",
  emptyPackage: "ripstream always writes the package, as Tika does by default (WRITE); SKIP is for tika-server's /unpack, which answers 204",
  includeMetadataInZip: "Tika deprecated it in 4.1 (removal in 5.0): use includeMetadata",
  includeFullMetadata: "Tika deprecated it in 4.1 (removal in 5.0): use includeMetadata",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An enum by its name, as Tika's `parse` reads it: any case. */
function oneOf<T extends string>(value: unknown, names: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  return names.find((name) => name === value.toUpperCase());
}

/** Reads an `unpack-config` object. The caller's object is read once per key and a copy is returned. */
export function parseUnpackConfig(value: unknown): { settings: UnpackSettings; issues: string[] } {
  const issues: string[] = [];
  const settings: { -readonly [Key in keyof UnpackSettings]: UnpackSettings[Key] } = {};
  const where = "parse-context unpack-config";
  if (!isObject(value)) return { settings, issues: [`${where} must be an object`] };

  for (const [key, raw] of Object.entries(value)) {
    const refusal = REFUSED[key];
    if (refusal !== undefined) {
      issues.push(`${where}: ${key} is not supported: ${refusal}`);
      continue;
    }
    switch (key) {
      case "outputFormat":
      case "outputMode":
      case "suffixStrategy":
      case "keyBaseStrategy": {
        const names =
          key === "outputFormat"
            ? UNPACK_OUTPUT_FORMATS
            : key === "outputMode"
              ? UNPACK_OUTPUT_MODES
              : key === "suffixStrategy"
                ? UNPACK_SUFFIX_STRATEGIES
                : UNPACK_KEY_BASE_STRATEGIES;
        const name = oneOf(raw, names);
        if (name === undefined) issues.push(`${where}: ${key} must be one of ${names.join(", ")}`);
        else (settings as Record<string, unknown>)[key] = name;
        break;
      }
      case "zeroPadName":
        if (typeof raw !== "number" || !Number.isSafeInteger(raw) || Object.is(raw, -0) || raw < 0 || raw > 64) {
          issues.push(`${where}: zeroPadName must be an integer from 0 to 64`);
        } else settings.zeroPadName = raw;
        break;
      case "maxUnpackBytes":
        if (raw === -1) {
          issues.push(`${where}: maxUnpackBytes -1 (no limit) is not available: ripstream holds the embedded bytes in memory, so give a limit of 0 or more`);
        } else if (typeof raw !== "number" || !Number.isSafeInteger(raw) || Object.is(raw, -0) || raw < 0) {
          issues.push(`${where}: maxUnpackBytes must be an integer, 0 or more`);
        } else settings.maxUnpackBytes = raw;
        break;
      case "includeOriginal":
      case "includeMetadata":
        if (typeof raw !== "boolean") issues.push(`${where}: ${key} must be a boolean`);
        else settings[key] = raw;
        break;
      case "embeddedIdPrefix":
      case "emitKeyBase":
      case "packageRoot":
      case "packageName":
        if (typeof raw !== "string" || raw.includes("\u0000")) issues.push(`${where}: ${key} must be a string without a NUL byte`);
        else settings[key] = raw;
        break;
      default:
        issues.push(`${where}: unknown setting ${JSON.stringify(key)}`);
    }
  }
  return { settings, issues };
}
