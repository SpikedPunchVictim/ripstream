import { main } from "./main.js";

/*
 * The command line's entry body: what `bin/ripstream.js` runs, from `dist` or from the bundle (docs/cli-startup.md).
 * It exports nothing; the library entry is `main.ts`.
 */

// A reader that closes the pipe early (`ripstream parse big.txt | head -c 20`) is not a crash: stop, quietly.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

process.exitCode = await main(process.argv.slice(2));
