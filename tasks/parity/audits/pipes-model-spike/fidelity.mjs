// How much of Tika 4.2.0's own pipes configuration could a loader for a chosen subset load? (tikajs-68os.6.2)
// Throwaway spike, evidence in tasks/parity/audits/pipes-model-spike.md.
// Run: TIKA_SRC=/path/to/tika-4.2.0 node fidelity.mjs [docs]     ("docs" = only the documented examples)
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.TIKA_SRC;
if (ROOT === undefined) throw new Error("set TIKA_SRC to the unpacked tika-4.2.0 source tree");

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
      const documented = path.includes(`${join("docs", "modules")}`) && name.startsWith("pipes-");
      files.push({ path, documented });
    }
  }
})(ROOT);

const onlyDocs = process.argv[2] === "docs";
// What the subset loads: the root sections ripstream applies, plus the pipes sections of the chosen scope.
const ROOT_OK = new Set(["parsers", "detectors", "parse-context", "server", ...PIPES_KEYS]);
const TYPE_OK = {
  fetchers: new Set(["file-system-fetcher", "http-fetcher"]),
  emitters: new Set(["file-system-emitter"]),
  "pipes-iterator": new Set(["file-system-pipes-iterator"]),
  "pipes-reporters": new Set(["file-system-jsonl-reporter", "logging-reporter", "file-system-reporter"]),
};
const PIPES_KEYS_OK = new Set(["parseMode", "onParseException", "numClients", "queueSize"]);
const INERT_ROOT = new Set(["plugin-roots"]);
const INERT_PIPES = new Set(["forkedJvmArgs", "javaPath", "useSharedServer", "heartbeatIntervalMillis", "socketTimeoutMillis", "startupTimeoutMillis"]);
const EMIT_KNOBS = new Set(["emitStrategy", "emitIntermediateResults", "emitWithinMillis", "numEmitters", "emitMaxEstimatedBytes"]);

let total = 0;
let strictTypes = 0;
let strictKeys = 0;
let inert = 0;
let emit = 0;
const blocking = {};
for (const { path, documented } of files) {
  if (onlyDocs && !documented) continue;
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    continue; // a template with placeholders
  }
  if (json === null || typeof json !== "object" || !PIPES_KEYS.some((k) => k in json)) continue;
  total++;
  const rootWhy = Object.keys(json).filter((k) => !ROOT_OK.has(k)).map((k) => `root:${k}`);
  const typeWhy = [];
  for (const [section, ok] of Object.entries(TYPE_OK)) {
    const value = json[section];
    if (value === undefined) continue;
    const types = section === "pipes-iterator" || section === "pipes-reporters"
      ? Object.keys(value)
      : Object.values(value).flatMap((body) => (body !== null && typeof body === "object" ? Object.keys(body) : []));
    for (const type of types) if (!ok.has(type)) typeWhy.push(`${section}:${type}`);
  }
  const keyWhy = Object.keys(json.pipes ?? {}).filter((k) => !PIPES_KEYS_OK.has(k)).map((k) => `pipes.${k}`);
  const all = [...rootWhy, ...typeWhy, ...keyWhy];
  if (rootWhy.length + typeWhy.length === 0) strictTypes++;
  if (all.length === 0) strictKeys++;
  const afterInert = all.filter((w) => !(w.startsWith("root:") && INERT_ROOT.has(w.slice(5))) && !(w.startsWith("pipes.") && INERT_PIPES.has(w.slice(6))));
  if (afterInert.length === 0) inert++;
  const afterEmit = afterInert.filter((w) => !(w.startsWith("pipes.") && EMIT_KNOBS.has(w.slice(6))));
  if (afterEmit.length === 0) emit++;
  for (const w of new Set(afterEmit)) blocking[w] = (blocking[w] ?? 0) + 1;
}
console.log(`Tika pipes configs (${onlyDocs ? "documented examples" : "every json in the source tree"}): ${total}`);
console.log(`  component types and root sections in the subset:                       ${strictTypes}/${total}`);
console.log(`  ... and every \`pipes\` key mapped:                                      ${strictKeys}/${total}`);
console.log(`  ... and plugin-roots / JVM process knobs tolerated (they change nothing here): ${inert}/${total}`);
console.log(`  ... and emit batching knobs accepted (no process boundary to tune):    ${emit}/${total}`);
console.log("what still blocks:", JSON.stringify(Object.entries(blocking).sort((a, b) => b[1] - a[1]).slice(0, 14)));
