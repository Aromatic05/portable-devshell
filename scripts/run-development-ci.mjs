import { spawnSync } from "node:child_process";
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

    if (platform === "win32") {
        // PowerShell is obscure to script reliably, and ConPTY terminal behavior remains unstable
        // even when the PTY child is Git Bash. We cannot currently write Windows runtime tests
        // with enough determinism and proof value to make them a release gate. Keep static checks,
        // native Worker compilation, and application packaging as the Windows release criteria.
        return [
            pnpmStep("Lint", ["lint"]),
            pnpmStep("Build", ["build"]),
            pnpmStep("Typecheck", ["typecheck"]),
            pnpmStep("Build native Worker", ["build:worker", target, "--output-dir", "./ci-artifacts"]),
            pnpmStep("Package native application", ["package:app", "--", "--target", target, "--output-dir", "./ci-artifacts"]),
        ];
    }

    const steps = [
        pnpmStep("Script tests", ["test:scripts"]),
        pnpmStep("Lint", ["lint"]),
        pnpmStep("Build", ["build"]),
        pnpmStep("Typecheck", ["typecheck"]),
        { args: ["test", "--locked", "--workspace"], command: "cargo", name: "Rust workspace tests" },
        pnpmStep("Worker tmux contract tests", ["test:worker:tmux"]),
        pnpmStep("Prepare test Worker", ["test:prepare"]),
        pnpmStep("Package tests", ["test"]),
        pnpmStep("Build native Worker", ["build:worker", target, "--output-dir", "./ci-artifacts"]),
        { args: ["./scripts/smoke-worker.mjs", worker], command: process.execPath, name: "Worker daemon smoke" },
        { args: ["./scripts/smoke-reverse-worker.mjs", worker], command: process.execPath, name: "Reverse worker PTY smoke" },
        { args: ["./scripts/smoke-client.mjs", worker], command: process.execPath, name: "Client and local instance smoke" },
        pnpmStep("Package native application", ["package:app", "--", "--target", target, "--output-dir", "./ci-artifacts"]),
        pnpmStep("Application package smoke", ["smoke:package", "--", application]),
    ];
    steps.push(pnpmStep("Unix release installer smoke", ["smoke:install-release", "--", application]));
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

export function runDevelopmentCi(target, options = {}) {
    const { platform = process.platform, ...runOptions } = options;
    return runCiSteps(createDevelopmentCiSteps(target, platform), runOptions);
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
    const result = runDevelopmentCi(process.argv[2]);
    if (!result.ok) {
        process.exitCode = 1;
    }
}
