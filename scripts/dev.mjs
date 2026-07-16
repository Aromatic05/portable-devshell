import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPackageBinFile, normalizeCliArguments, readPackageBinPath } from "./application-layout.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
let cliEntry;
try {
    cliEntry = (await assertPackageBinFile(
        await readPackageBinPath(resolve(repositoryRoot, "packages", "cli"), "devshell")
    )).absolutePath;
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\nrun pnpm build first\n`);
    process.exit(1);
}

const child = spawn(process.execPath, [cliEntry, ...normalizeCliArguments(process.argv.slice(2))], {
    env: process.env,
    stdio: "inherit"
});

child.on("exit", (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }

    process.exit(code ?? 0);
});
