import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Record<string, string>;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function hashDirectory(directory: string): string {
  const hash = createHash("sha256");
  if (!existsSync(directory)) return hash.digest("hex");
  const visit = (path: string): void => {
    for (const entry of readdirSync(path).sort()) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) visit(full);
      else hash.update(full.slice(directory.length)).update(readFileSync(full));
    }
  };
  visit(directory);
  return hash.digest("hex");
}

const revision = git(["rev-parse", "HEAD"]);
const packages = readdirSync("packages")
  .filter((name) => existsSync(join("packages", name, "package.json")))
  .sort();

mkdirSync("artifacts/sbom", { recursive: true });
mkdirSync("artifacts/provenance", { recursive: true });

for (const directory of packages) {
  const manifest = JSON.parse(
    readFileSync(join("packages", directory, "package.json"), "utf8"),
  ) as Manifest;
  const digest = hashDirectory(join("packages", directory, "dist"));
  const components = Object.entries(manifest.dependencies ?? {}).map(
    ([name, version]) => ({ type: "library", name, version }),
  );
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "library",
        name: manifest.name,
        version: manifest.version,
      },
    },
    components,
  };
  writeFileSync(
    join("artifacts/sbom", `${directory}.cdx.json`),
    `${JSON.stringify(sbom, null, 2)}\n`,
  );

  const provenance = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: manifest.name,
        digest: { sha256: digest },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://github.com/SpikedPunchVictim/ripstream/build/v1",
        externalParameters: {
          source: {
            uri: git(["config", "--get", "remote.origin.url"]) || "local",
            revision,
          },
        },
        resolvedDependencies: Object.entries(manifest.dependencies ?? {}).map(
          ([name, version]) => ({ name, version }),
        ),
      },
      runDetails: {
        builder: { id: "ripstream-local-build" },
        metadata: { invocationId: `${revision}-${manifest.name}` },
      },
    },
  };
  writeFileSync(
    join("artifacts/provenance", `${directory}.intoto.jsonl`),
    `${JSON.stringify(provenance)}\n`,
  );
}

console.log(`wrote SBOM and provenance for ${packages.length} packages`);
