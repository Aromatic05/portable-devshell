import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(packageRoot, "dist/mcpapp-client.js");
await mkdir(dirname(output), { recursive: true });
await build({
    absWorkingDir: packageRoot,
    entryPoints: ["src/mcpapp/app/client/Browser.ts"],
    outfile: output,
    bundle: true,
    format: "iife",
    globalName: "McpAppClient",
    platform: "browser",
    target: "es2022",
    splitting: false,
});
