# Bundle budget

`bundle-budget.json` caps the `dist` bytes of every package (and their total); `pnpm run bundle:check` fails when one is
over, and CI runs it after `pnpm build` (tikajs-qrky).

The first budgets were set with the initial port and were never adjusted as parsers were completed, so at HEAD every
larger package was over by 10-35%. They were raised to the measured size plus roughly ten percent, not removed: the
check still catches a package that doubles. The total cap is the sum of the per-package caps.

When a package outgrows its cap for a real feature, raise that cap and the total in the same commit as the feature, and
say why in the commit message. If a package needs much more than the headroom, consider splitting it (for example
`parser-media` into audio/video and image, or `parsers` into registry and individual format modules) rather than raising
the cap. Never raise a cap just to pass CI without a feature that explains it.
