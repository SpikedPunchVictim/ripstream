#!/usr/bin/env node
import { main } from "../dist/main.js";

// A reader that closes the pipe early (`ripstream parse big.txt | head -c 20`) is not a crash: stop, quietly.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

process.exitCode = await main(process.argv.slice(2));
