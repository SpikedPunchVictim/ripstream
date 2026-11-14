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
const expected: Record<string, readonly string[]> = {
  text: ["alpha", "beta", "gamma", "delta"],
  html: ["hello", "world"],
  xml: ["title", "text"],
};
interface Measurement {
  iterations: number;
  opsPerSecond: number;
  score: number;
  medianMs: number;
  peakRssMb: number;
}
const results: Record<string, Measurement> = {};

for (const [name, bytes] of Object.entries(fixtures)) {
  for (let index = 0; index < 5; index++) await ripstream.parseToString(bytes);
  const iterations = 50;
  const started = performance.now();
  let recalled = 0;
  let peakRss = 0;
  const times: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const before = performance.now();
    const text = (await ripstream.parseToString(bytes)).toLowerCase();
    times.push(performance.now() - before);
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    recalled += expected[name]!.filter((token) => text.includes(token)).length / expected[name]!.length;
  }
  const seconds = (performance.now() - started) / 1000;
  times.sort((a, b) => a - b);
  results[name] = {
    iterations,
    opsPerSecond: Number((iterations / seconds).toFixed(2)),
    score: Number((recalled / iterations).toFixed(4)),
    medianMs: Number((times[Math.floor(times.length / 2)] ?? 0).toFixed(3)),
    peakRssMb: Number((peakRss / 1024 / 1024).toFixed(1)),
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
