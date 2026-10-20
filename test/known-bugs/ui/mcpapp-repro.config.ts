import { resolve } from "node:path";
const workspace = resolve(import.meta.dirname, "../../..");
export default {
    root: workspace,
    define: { __MCPAPP_VERSION__: JSON.stringify("round3-repro") },
    resolve: { alias: {
        vitest: resolve(workspace, "packages/mcpapp/node_modules/vitest/dist/index.js"),
        react: resolve(workspace, "packages/mcpapp/node_modules/react"),
        "@modelcontextprotocol/ext-apps/app-with-deps": resolve(workspace, "packages/mcpapp/node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js"),
    } },
    test: { environment: "jsdom", include: ["test/known-bugs/ui/McpAppBugs.test.tsx"] },
};
