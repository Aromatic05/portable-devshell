# MCP App production browser assets

The sole MCP App browser implementation is the React application in `packages/mcpapp/src/`. Its Vite output is installed into `packages/mcp/dist/mcpapp/` via `scripts/install-mcpapp-assets.mjs`. The MCP App HTTP route exposes those assets and `mcpAppHtmlForPublicBaseUrl()` references them.

`pnpm --filter @portable-devshell/mcp build` compiles the MCP package and installs the React assets; `pnpm --filter @portable-devshell/mcp test` builds the React app, installs the assets, and runs MCP tests. The MCP package does not build or bundle another browser client.
