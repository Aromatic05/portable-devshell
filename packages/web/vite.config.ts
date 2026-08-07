import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
    base: "./",
    plugins: [react()],
    resolve: {
        alias: {
            "@portable-devshell/shared/browser": resolve(import.meta.dirname, "../shared/src/browser.ts"),
            "@portable-devshell/shared": resolve(import.meta.dirname, "../shared/src/index.ts"),
        },
    },
    test: {
        environment: "jsdom",
        setupFiles: ["./test/setup.ts"],
    },
});
