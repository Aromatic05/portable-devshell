# Beta Known-Bug Reproductions

This directory contains deliberately **failing** tests for independently reproduced implementation defects. They are **not** part of the regular `pnpm test:packages`, `pnpm test:scripts` or Cargo discovery. A nonzero exit is expected **until the implementation is fixed**; do not change the assertions simply to make the tests green.

For the eight confirmed non-UI defects, run from the repository root:

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/mcp/test/RegisterWorkspacePackages.mjs --test test/known-bugs/*.test.ts
```

This invokes 9 failing scenarios: two foreign instance TOML filenames, one post-commit cleanup failure, two Extension lifecycle races, one Stream admission race, one OAuth refresh-token rotation race, and two Reentry claim-ownership races.

For component-boundary UI findings (real rendered components with stubbed Host/domain connections):

```bash
node packages/web/node_modules/vitest/vitest.mjs run --config test/known-bugs/ui/web-repro.config.ts
node packages/mcpapp/node_modules/vitest/vitest.mjs run --config test/known-bugs/ui/mcpapp-repro.config.ts
```

These contain 4 Web and 4 MCP App expected-failing cases. They do not establish real ChatGPT Host or production data-path failure. Two speculative Web Config navigation cases were explicitly removed from the retained reproducible set after parent remount behavior disproved the initial hypothesis.

When fixing a bug, run its reproduction first. Once it passes, move it into the owning package's normal regression suite and update `docs/development/beta-bug-findings.md`. Avoid adding `skip`/`todo` markers to hide an open defect.

