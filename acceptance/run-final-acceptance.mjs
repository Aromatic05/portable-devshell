import { pathToFileURL } from "node:url";

import { runCiSteps } from "../scripts/run-development-ci.mjs";
import { resolvePreparedWorker, runCommand } from "./AcceptanceSupport.mjs";

export function runFinalAcceptance() {
    let env = { ...process.env };
    const steps = [
        {
            name: "Build packages",
            run: () => runCommand("pnpm", ["build"], { inherit: true }),
        },
        {
            name: "Typecheck packages",
            run: () => runCommand("pnpm", ["typecheck"], { inherit: true }),
        },
        {
            name: "Build Rust workspace",
            run: () => runCommand("cargo", ["build", "--locked", "--workspace"], { inherit: true }),
        },
        {
            name: "Resolve prepared Worker",
            run() {
                env = {
                    ...process.env,
                    PORTABLE_DEVSHELL_TEST_WORKER_PATH: resolvePreparedWorker(),
                };
            },
        },
        {
            name: "Package tests",
            run: () => runCommand("pnpm", ["test"], { env, inherit: true }),
        },
        {
            name: "Rust workspace tests",
            run: () => runCommand("cargo", ["test", "--locked", "--workspace"], { inherit: true }),
        },
        {
            name: "tmux Worker contracts",
            run() {
                if (process.platform !== "win32") {
                    runCommand("pnpm", ["test:worker:tmux"], { env, inherit: true });
                }
            },
        },
        {
            name: "Real Worker smoke",
            run: () => runCommand(
                process.execPath,
                ["acceptance/run-real-worker-smoke.mjs"],
                { env, inherit: true },
            ),
        },
        {
            name: "MCP smoke",
            run: () => runCommand(
                process.execPath,
                ["acceptance/run-mcp-smoke.mjs"],
                { env, inherit: true },
            ),
        },
        {
            name: "Web browser smoke",
            run: () => runCommand(
                process.execPath,
                ["acceptance/run-web-browser-smoke.mjs"],
                { env, inherit: true },
            ),
        },
    ];
    return runCiSteps(steps, {
        execute(step) {
            step.run();
            return { status: 0 };
        },
    });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const result = runFinalAcceptance();
    if (!result.ok) {
        process.exitCode = 1;
    }
}
