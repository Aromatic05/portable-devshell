# MCP App browser assets

The production MCP App is the React application at `packages/mcpapp/src/`. It is built by Vite and its manifest is installed into `dist/mcpapp` by `scripts/install-mcpapp-assets.mjs`. `mcpAppHtmlForPublicBaseUrl()` serves these assets.

`node scripts/build-mcpapp-client.mjs` separately builds `dist/mcpapp-client.js` from the deprecated TypeScript client under `src/mcpapp/app/client/`. This is **test-only compatibility** for `src/mcpapp/app/Legacy.ts` and fixtures imported through `@portable-devshell/mcp/testing`. It is not the deployed React MCP App.

The package `build` and `test` scripts still generate this bundle because existing MCP/Control browser fixtures require it. The explicit removal prerequisites are recorded in `packages/mcp/docs/mcpapp-legacy.md`.
