import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
    base: "./",
    plugins: [react()],
    define: { __MCPAPP_VERSION__: JSON.stringify(root.version) },
    build: {
        manifest: true,
        rolldownOptions: {
            input: {
                workspace: fileURLToPath(new URL("./index.html", import.meta.url)),
                toolcall: fileURLToPath(new URL("./toolcall.html", import.meta.url)),
            },
        },
    },
    test: { environment: "jsdom" },
});
