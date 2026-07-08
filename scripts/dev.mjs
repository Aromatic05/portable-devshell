import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const cliEntry = resolve("packages/cli/dist/cli/CliMain.js");

try {
    accessSync(cliEntry, constants.R_OK);
} catch {
    process.stderr.write(`missing built cli entry: ${cliEntry}\nrun pnpm build first\n`);
    process.exit(1);
}

const child = spawn(process.execPath, [cliEntry, ...process.argv.slice(2)], {
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
