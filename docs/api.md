# Public API and semver policy

`api-report.json` is the frozen surface: exported names per public package entry point.
`pnpm api:check` fails when the report is stale; regeneration (`pnpm api:report`) is a reviewed commit.

- **Major**: removing/renaming an export, narrowing a parameter type, adding a required member.
- **Minor**: adding exports or optional members, widening accepted inputs.
- **Patch**: implementation fixes only.

Public types must not expose `any`; use `unknown` plus a parser/type guard. New exports require a test and
an entry in the report. Type-only exports are part of the surface.
