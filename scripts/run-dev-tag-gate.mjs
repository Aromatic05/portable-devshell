import { pathToFileURL } from "node:url";

import { runDevelopmentCi } from "./run-development-ci.mjs";

export function runDevTagGate(options = {}) {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    if (platform !== "linux" || arch !== "x64") {
        throw new Error("dev tag push gate requires a Linux x64 host so it can reproduce Linux x64 development CI.");
    }

    const ciOptions = { ...options };
    delete ciOptions.arch;
    return runDevelopmentCi("linux-x64", {
        ...ciOptions,
        platform: "linux",
    });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const result = runDevTagGate();
        if (!result.ok) {
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
