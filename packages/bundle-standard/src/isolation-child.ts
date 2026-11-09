import { runChildMain } from "@spikedpunch/ripstream-isolation-node";
import { createRipstream } from "@spikedpunch/ripstream-parsers";

/**
 * The standard isolation child: the entry file a ChildRunner spawns (find it with `isolationChildPath()` from
 * "@spikedpunch/ripstream-bundle-standard/isolation"). It parses ONE document with the standard pipeline in this
 * process and answers over fd 3. Importing it runs it, so nothing else imports it.
 *
 * `pdfInline`: the child already is the isolation boundary (heap cap, RSS kill, process-group kill, ulimit), so
 * the PDF parser runs on the main thread here instead of in a worker_thread. A worker would also add a second
 * address space that the parent's per-child memory accounting does not see.
 */
await runChildMain({ ripstream: createRipstream({ pdfInline: true }) });
