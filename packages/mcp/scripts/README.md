# MCP App browser asset

`node scripts/build-mcpapp-client.mjs` builds `dist/mcpapp-client.js` directly from the client TypeScript modules, without requiring the package's Node source build. `pnpm --filter @portable-devshell/mcp test` runs it before loading Resource or tests.

Before running another package's MCP App browser tests, run `pnpm --filter @portable-devshell/mcp exec node scripts/build-mcpapp-client.mjs` so Resource loads a current bundle. Resource deliberately fails when the asset is missing; it never uses a runtime fallback. The package build runs TypeScript first, then produces the same browser asset.
