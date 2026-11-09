import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path of the standard isolation child entry, for `ChildRunnerOptions.childScript`.
 *
 * The entry sits next to this file and has this file's extension: `.ts` when running from source (tests, node
 * type stripping), `.js` from the built package.
 */
export function isolationChildPath(): string {
  const here = fileURLToPath(import.meta.url);
  return fileURLToPath(new URL(`./isolation-child${extname(here)}`, import.meta.url));
}
