# Quality floors

`benchmarks/floors.json` is the committed guardrail for the format cohorts of `packages/parsers/scripts/benchmark.ts`
(tikajs-3qub). CI runs the benchmark, then `pnpm run floors:check`; a cohort fails when

- its parse-quality `score` is below `minScore` (expected tokens the parser must recall),
- its throughput is below `minOpsPerSecond`,
- its median parse time is above `maxMedianMs`, or
- its peak RSS is above `maxPeakRssMb`.

The measured values go to `artifacts/benchmark.json`. Add a cohort by adding its fixture and expected tokens to the
benchmark and a floor with the same name to the JSON.

## Re-baselining on purpose

Floors are changed in the same commit as the change that earns it, reviewed like code:

1. Run `pnpm bench` on a quiet machine and read `artifacts/benchmark.json`.
2. Change the floor (normally upward for throughput, downward only for latency/RSS) in the same commit as the parser
   change that justifies it.
3. Say why in the commit message.

Never lower `minScore` or raise `maxMedianMs`/`maxPeakRssMb` just to make a red build green: that hides the regression
the floor exists to catch. The floors are deliberately far from the measured values so CI runner noise does not trip
them; a tripped floor means an order-of-magnitude change, not a few percent.
