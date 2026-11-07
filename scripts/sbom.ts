import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

interface LicenseGroup {
  readonly license: string;
  readonly name: string;
  readonly versions: readonly string[];
}

const raw = execFileSync("pnpm", ["licenses", "list", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const groups = Object.values(JSON.parse(raw) as Record<string, LicenseGroup[]>).flat();
const components = new Map<string, { name: string; version: string; license: string }>();
for (const group of groups) {
  for (const version of group.versions) {
    components.set(`${group.name}@${version}`, {
      name: group.name,
      version,
      license: group.license,
    });
  }
}
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: { tools: { components: [{ type: "application", name: "ripstream-sbom" }] } },
  components: [...components.values()]
    .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
    .map((component) => ({
      type: "library",
      name: component.name,
      version: component.version,
      licenses: [{ license: { id: component.license } }],
    })),
};
writeFileSync("sbom.cdx.json", `${JSON.stringify(bom, null, 2)}\n`);
console.log(`wrote sbom.cdx.json with ${bom.components.length} components`);
