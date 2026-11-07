import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRipstream } from "../src/index.ts";

const fixtures = {
  text: new TextEncoder().encode("alpha beta gamma delta\n".repeat(200)),
  html: new TextEncoder().encode(
    "<html><body>" + "<p>Hello <b>world</b></p>".repeat(200) + "</body></html>",
  ),
  xml: new TextEncoder().encode(
    '<doc xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>x</dc:title>' +
      "<p>text</p>".repeat(200) +
      "</doc>",
  ),
};

const ripstream = createRipstream();
const results: Record<string, { iterations: number; opsPerSecond: number }> = {};

for (const [name, bytes] of Object.entries(fixtures)) {
  for (let index = 0; index < 5; index++) await ripstream.parseToString(bytes);
  const iterations = 50;
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    await ripstream.parseToString(bytes);
  }
  const seconds = (performance.now() - started) / 1000;
  results[name] = {
    iterations,
    opsPerSecond: Number((iterations / seconds).toFixed(2)),
  };
}

mkdirSync("../../artifacts", { recursive: true });
writeFileSync("../../artifacts/benchmark.json", `${JSON.stringify(results, null, 2)}\n`);

if (process.argv.includes("--check")) {
  const baselinePath = "../../benchmarks/baseline.json";
  if (!existsSync(baselinePath)) {
    console.error("Missing benchmarks/baseline.json");
    process.exitCode = 1;
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as typeof results;
    const problems: string[] = [];
    for (const [name, current] of Object.entries(results)) {
      const expected = baseline[name]?.opsPerSecond ?? 0;
      if (expected > 0 && current.opsPerSecond < expected * 0.5) {
        problems.push(
          `${name}: ${current.opsPerSecond} ops/s < 50% of baseline ${expected}`,
        );
      }
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      process.exitCode = 1;
    } else {
      console.log("benchmark gate passed");
    }
  }
}
console.log(JSON.stringify(results));
