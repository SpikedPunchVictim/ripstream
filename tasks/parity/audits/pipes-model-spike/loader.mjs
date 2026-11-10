// Runs the real loader (core loadConfig) over every JSON in Tika 4.2.0's source tree that has a pipes section. (tikajs-68os.6.2)
// fidelity.mjs simulated the loader to decide what to build; this measures what was built.
// Run: TIKA_SRC=/path/to/tika-4.2.0 node loader.mjs [docs]     ("docs" = only the documented examples)
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.TIKA_SRC;
if (ROOT === undefined) throw new Error("set TIKA_SRC to the unpacked tika-4.2.0 source tree");
const { loadConfig, RipstreamConfigError } = await import(new URL("../../../../packages/core/dist/index.js", import.meta.url).href);

const PIPES_KEYS = ["fetchers", "emitters", "pipes-iterator", "pipes-reporters", "pipes"];
const seen = new Set();
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    const real = realpathSync(path);
    if (statSync(real).isDirectory()) walk(path);
    else if (name.endsWith(".json") && !seen.has(real)) {
      seen.add(real);
      files.push({ path, documented: path.includes(join("docs", "modules")) && name.startsWith("pipes-") });
    }
  }
})(ROOT);

const onlyDocs = process.argv[2] === "docs";
let total = 0;
let loaded = 0;
let withNotices = 0;
const blocking = {};
for (const { path, documented } of files) {
  if (onlyDocs && !documented) continue;
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    continue; // a template with placeholders
  }
  if (json === null || typeof json !== "object" || !PIPES_KEYS.some((key) => key in json)) continue;
  total++;
  try {
    const config = loadConfig(json);
    loaded++;
    if (config.notices.length > 0) withNotices++;
  } catch (error) {
    if (!(error instanceof RipstreamConfigError)) throw error;
    // Count each configuration once under every reason it is refused for, with the file name and values taken out.
    for (const reason of new Set(error.issues.map((issue) => issue.replace(/^(\S+?)\.[^.\s]+\.(\S+ is not an? )/, "$1.<id>.$2").replace(/".*?"/g, '"…"').slice(0, 90)))) {
      blocking[reason] = (blocking[reason] ?? 0) + 1;
    }
  }
}
console.log(`${onlyDocs ? "documented examples" : "all configs with a pipes section"}: ${total}`);
console.log(`  load: ${loaded} (${withNotices} with a notice that a setting changes nothing)`);
console.log(`  refused: ${total - loaded}; reasons, by configurations affected:`);
for (const [reason, count] of Object.entries(blocking).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`    ${String(count).padStart(3)}  ${reason}`);
