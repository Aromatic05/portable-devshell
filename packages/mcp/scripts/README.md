# Workspace browser asset

`node scripts/build-workspace-client.mjs` builds `dist/workspace-client.js` directly from the client TypeScript modules, without requiring the package's Node source build. `pnpm --filter @portable-devshell/mcp test` runs it before loading Resource or tests.

Before running another package's Workspace browser tests, run `pnpm --filter @portable-devshell/mcp exec node scripts/build-workspace-client.mjs` so Resource loads a current bundle. Resource deliberately fails when the asset is missing; it never uses a runtime fallback. The package build runs TypeScript first, then produces the same browser asset.
