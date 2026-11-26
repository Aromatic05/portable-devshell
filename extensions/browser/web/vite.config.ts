import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
    root: import.meta.dirname,
    base: "./",
    resolve: {
        alias: { "@portable-devshell/shared": resolve(import.meta.dirname, "../../../packages/shared/src/index.ts") },
    },
    build: { outDir: resolve(import.meta.dirname, "../dist/web"), emptyOutDir: true },
});
