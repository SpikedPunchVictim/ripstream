import { runChildMain } from "@spikedpunch/ripstream-isolation-node";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { blockPdfjsCanvas } from "./block-pdfjs-canvas.ts";

/**
 * The standard isolation child: the entry file a ChildRunner spawns (find it with `isolationChildPath()` from
 * "@spikedpunch/ripstream-bundle-standard/isolation"). It parses ONE document with the standard pipeline in this
 * process and answers over fd 3. Importing it runs it, so nothing else imports it.
 *
 * The PDF parser always runs pdf.js on the calling thread, which here is this child's main thread. The child
 * process is the containment (heap cap, RSS kill, process-group kill, ulimit); there is no nested worker_thread
 * whose memory the parent's per-child accounting would not see.
 *
 * pdf.js is imported on the first PDF, after this module has run, so the canvas block below is in place before it
 * looks for `@napi-rs/canvas` (see block-pdfjs-canvas.ts for why the child does not load it).
 */
blockPdfjsCanvas();
await runChildMain({ ripstream: createRipstream() });
