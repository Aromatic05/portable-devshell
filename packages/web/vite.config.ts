import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({ resolve: { alias: { "@portable-devshell/shared": new URL("./src/shared-browser.ts", import.meta.url).pathname } }, plugins: [react()], test: { environment: "jsdom", setupFiles: ["./test/setup.ts"] } });
