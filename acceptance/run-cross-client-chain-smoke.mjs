#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoRoot, sourceLoader } from "./AcceptanceSupport.mjs";

// Run source transports with exactly the workspace loader used by the real CLI.
const result = spawnSync(process.execPath, [
    "--import", "tsx", "--import", pathToFileURL(sourceLoader).href,
    fileURLToPath(new URL("./chains/CrossClientChain.mjs", import.meta.url)),
    ...process.argv.slice(2),
], { cwd: repoRoot, env: process.env, stdio: "inherit", timeout: 600_000 });
if (result.error) process.stderr.write(`${result.error.stack}\n`);
process.exitCode = result.status ?? 1;
