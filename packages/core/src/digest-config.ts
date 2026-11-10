import { DIGEST_ALGORITHMS, DIGEST_ENCODINGS, digestKey, type DigestAlgorithm, type DigestDef, type DigestEncoding, type DigestSettings } from "./digest.ts";

/*
 * The digester factories of a Tika `parse-context` section (tika-parser-digest-commons 4.2.0: CommonsDigesterFactory,
 * BouncyCastleDigesterFactory). They take the same settings and differ in the algorithms they have: Commons does not
 * have the SHA3 ones. Tika reads its configuration with Jackson, which refuses a name it does not know and takes an
 * enum's name in any case (`sha256`, `Base32`), so this does too.
 */

export const DIGESTER_FACTORIES = ["commons-digester-factory", "bouncy-castle-digester-factory"] as const;
export type DigesterFactoryName = (typeof DIGESTER_FACTORIES)[number];

const SHA3: readonly DigestAlgorithm[] = ["SHA3_256", "SHA3_384", "SHA3_512"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function enumValue<T extends string>(value: unknown, names: readonly T[]): T | undefined {
  return typeof value === "string" ? names.find((name) => name === value.toUpperCase()) : undefined;
}

export function parseDigesterFactory(factory: DigesterFactoryName, raw: unknown): { settings?: DigestSettings; issues: string[] } {
  const issues: string[] = [];
  const at = `parse-context ${factory}`;
  if (!isObject(raw)) return { issues: [`${at} must be an object`] };

  for (const key of Object.keys(raw)) {
    if (key !== "digests" && key !== "skipContainerDocumentDigest") {
      issues.push(`${at}: unknown setting ${JSON.stringify(key)} (it reads digests and skipContainerDocumentDigest)`);
    }
  }

  let skipContainerDocumentDigest = false;
  if (raw.skipContainerDocumentDigest !== undefined) {
    if (typeof raw.skipContainerDocumentDigest === "boolean") skipContainerDocumentDigest = raw.skipContainerDocumentDigest;
    else issues.push(`${at}: skipContainerDocumentDigest must be a boolean`);
  }

  // Tika's factory is MD5 in hex until it is told otherwise.
  let digests: DigestDef[] = [{ algorithm: "MD5", encoding: "HEX" }];
  if (raw.digests !== undefined) {
    if (!Array.isArray(raw.digests)) {
      issues.push(`${at}: digests must be an array of {algorithm, encoding}`);
    } else {
      digests = [];
      raw.digests.forEach((entry: unknown, index) => {
        const where = `${at}: digests[${index}]`;
        if (!isObject(entry)) {
          issues.push(`${where} must be an object with an algorithm`);
          return;
        }
        for (const key of Object.keys(entry)) {
          if (key !== "algorithm" && key !== "encoding") issues.push(`${where}: unknown setting ${JSON.stringify(key)} (it reads algorithm and encoding)`);
        }
        const algorithm = enumValue(entry.algorithm, DIGEST_ALGORITHMS);
        if (algorithm === undefined) {
          issues.push(
            entry.algorithm === undefined || entry.algorithm === null
              ? `${where}: algorithm is required (${DIGEST_ALGORITHMS.join(", ")})`
              : `${where}: algorithm ${JSON.stringify(entry.algorithm)} is not one of ${DIGEST_ALGORITHMS.join(", ")} (the name in the configuration, not the key's: SHA256, not SHA-256)`,
          );
        } else if (factory === "commons-digester-factory" && SHA3.includes(algorithm)) {
          issues.push(`${where}: ${algorithm} is not an algorithm of ${factory}, as Tika's CommonsDigester refuses it; use bouncy-castle-digester-factory`);
        }
        let encoding: DigestEncoding | undefined = "HEX";
        if (entry.encoding !== undefined && entry.encoding !== null) {
          encoding = enumValue(entry.encoding, DIGEST_ENCODINGS);
          if (encoding === undefined) issues.push(`${where}: encoding ${JSON.stringify(entry.encoding)} is not one of ${DIGEST_ENCODINGS.join(", ")}`);
        }
        if (algorithm !== undefined && encoding !== undefined) digests.push({ algorithm, encoding });
      });
      // Two entries that name the same key write the same value to it: one is kept.
      digests = [...new Map(digests.map((def) => [digestKey(def), def])).values()];
    }
  }

  return issues.length > 0 ? { issues } : { settings: { digests, skipContainerDocumentDigest }, issues };
}
