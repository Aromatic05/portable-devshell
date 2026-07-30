import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
    base: "./",
    plugins: [react()],
    test: {
        environment: "jsdom",
        setupFiles: ["./test/setup.ts"],
    },
});
