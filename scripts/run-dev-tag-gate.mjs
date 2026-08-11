import { pathToFileURL } from "node:url";

import { runCiSteps } from "./run-development-ci.mjs";

export function runDevTagGate(options = {}) {
    const runOptions = { ...options };
    delete runOptions.arch;
    delete runOptions.platform;
    return runCiSteps(
        [
            {
                args: ["./scripts/version-state.mjs", "check-development"],
                command: process.execPath,
                name: "Development version",
            },
        ],
        runOptions,
    );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const result = runDevTagGate();
    if (!result.ok) {
        process.exitCode = 1;
    }
}
