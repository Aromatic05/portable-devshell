# MCP App client ownership and legacy retirement

## Current production path

- `packages/mcpapp/src/` is the React MCP App. Its Vite manifest is read by `packages/mcp/src/mcpapp/app/Resource.ts`.
- `packages/mcp/src/mcpapp/Extension.ts` returns `mcpAppHtmlForPublicBaseUrl()` and serves the React assets via `McpAppRoute`.
- `mcpAppLegacyResourceUris` are **resource URI aliases that resolve to the current React HTML**. They are not a request to execute the obsolete TypeScript client. Preserve these independently of the old bundle's eventual removal.

## Test-only compatibility path

- `packages/mcp/src/mcpapp/app/client/` is the former TypeScript browser client.
- `packages/mcp/scripts/build-mcpapp-client.mjs` generates `dist/mcpapp-client.js` for `packages/mcp/src/mcpapp/app/Legacy.ts`.
- `packages/mcp/src/testing.ts` exports `mcpAppHtml` from `Legacy.ts` for existing fixtures. `packages/mcp/test/unit/McpAppClient.test.ts` and `packages/control/test/integration/McpAppBrowser.test.ts` exercise the legacy client.
- The package `build` and `test` scripts currently generate this test-only bundle. It is not the production MCP App served by `McpExtension`.

## Required retirement conditions

1. Move the legacy browser interaction assertions to React tests (or explicitly retire obsolete assertions). Keep covering Context switches, authorization revocation, Action Receipt, Reentry, Watch, browser-host remount and errors.
2. Replace remaining `mcpAppHtml` fixture uses in MCP/Control tests with production React assets or supported test fixtures.
3. Remove `Legacy.ts`, the `app/client/` implementation, its private tests and the `mcpAppHtml` testing export together, then remove `build-mcpapp-client.mjs` from the package scripts and verify a clean build from scratch.
4. Retain the published `ui://` resource aliases separately until compatibility policy explicitly permits changing them. The alias lifetime is not coupled to the test client bundle.
5. Run MCP, React MCP App and Control Web/Chromium integration tests before completing the removal. Do not delete the legacy client merely to reduce file count while tests still rely on its behavior.
