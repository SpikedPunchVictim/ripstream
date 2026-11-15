import { RipstreamConfig } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { serveParses } from "./parse-worker-main.ts";

// The entry of a parse pool worker (see parse-pool.ts): a standard ripstream, built as the parent would build it.
await serveParses((spec) =>
  createRipstream({
    ...(spec.sections === undefined ? {} : { config: new RipstreamConfig(spec.sections) }),
    ...(spec.limits === undefined ? {} : { limits: spec.limits }),
    ...(spec.digest === undefined ? {} : { digest: spec.digest }),
  }),
);
