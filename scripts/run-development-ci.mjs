import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePnpmCommand } from "./PnpmCommand.mjs";

export function runCiSteps(steps, options = {}) {
    const execute = options.execute ?? executeCiStep;
    const log = options.log ?? console.log;
    const failures = [];

    for (const step of steps) {
        log(`\n===== ${step.name} =====`);
        let result;
        try {
            result = execute(step);
        } catch (error) {
            log(error instanceof Error ? (error.stack ?? error.message) : String(error));
            result = { error, status: 1 };
        }
        const status = Number.isInteger(result?.status) ? result.status : 1;
        if (status !== 0) {
            failures.push({ name: step.name, status });
            log(`FAILED: ${step.name} (exit ${status})`);
        } else {
            log(`PASSED: ${step.name}`);
        }
    }

    log("\n===== CI SUMMARY =====");
    if (failures.length === 0) {
        log("All development CI steps passed.");
        return { failures, ok: true };
    }
    for (const failure of failures) {
        log(`FAILED: ${failure.name} (exit ${failure.status})`);
    }
    return { failures, ok: false };
}

export function createDevelopmentCiSteps(target, platform = process.platform) {
    if (typeof target !== "string" || target.length === 0) {
        throw new Error("A native target is required.");
    }
    const pnpm = resolvePnpmCommand({ platform });
    const pnpmStep = (name, args) => ({
        args: [...pnpm.args, ...args],
        command: pnpm.command,
        name,
    });
    const worker = join(
        "ci-artifacts",
        `devshell-worker-${target}${platform === "win32" ? ".exe" : ""}`,
    );
    const application = join("ci-artifacts", `portable-devshell-app-${target}.tar.gz`);
    const scriptTests = readdirSync(new URL(".", import.meta.url))
        .filter((name) => name.endsWith(".test.mjs"))
        .sort()
        .map((name) => `./scripts/${name}`);
    const steps = [
        { args: ["--test", ...scriptTests], command: process.execPath, name: "Script tests" },
        pnpmStep("Lint", ["lint"]),
        pnpmStep("Build", ["build"]),
        pnpmStep("Typecheck", ["typecheck"]),
        { args: ["test", "--locked", "--workspace"], command: "cargo", name: "Rust workspace tests" },
        pnpmStep("Package tests", ["test"]),
        { args: ["./scripts/smoke-pty.mjs"], command: process.execPath, name: "PTY smoke" },
        pnpmStep("Build native Worker", ["build:worker", target, "--output-dir", "./ci-artifacts"]),
        { args: ["./scripts/smoke-worker.mjs", worker], command: process.execPath, name: "Worker daemon smoke" },
        { args: ["./scripts/smoke-client.mjs", worker], command: process.execPath, name: "Client and local instance smoke" },
        pnpmStep("Package native application", ["package:app", "--", "--target", target, "--output-dir", "./ci-artifacts"]),
        pnpmStep("Application package smoke", ["smoke:package", "--", application]),
    ];
    if (platform === "win32") {
        steps.push({
            args: ["./scripts/smoke-install-release-windows.mjs", application],
            command: process.execPath,
            name: "Windows release installer smoke",
        });
    } else {
        steps.push(pnpmStep("Unix release installer smoke", ["smoke:install-release", "--", application]));
    }
    if (target === "linux-x64") {
        steps.push({
            args: [
                "-lc",
                "set -o pipefail; bash acceptance/run-final-acceptance.sh 2>&1 | tee acceptance.log",
            ],
            command: "bash",
            name: "Final acceptance",
        });
    }
    return steps;
}

function executeCiStep(step) {
    const result = spawnSync(step.command, step.args, {
        env: process.env,
        shell: false,
        stdio: "inherit",
    });
    if (result.error !== undefined) {
        console.error(result.error);
        return { status: 1 };
    }
    return { status: result.status ?? 1 };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const result = runCiSteps(createDevelopmentCiSteps(process.argv[2]));
    if (!result.ok) {
        process.exitCode = 1;
    }
}
