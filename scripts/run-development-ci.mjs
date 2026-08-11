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

function createPnpmStepFactory(platform) {
    const pnpm = resolvePnpmCommand({ platform });
    return (name, args) => ({
        args: [...pnpm.args, ...args],
        command: pnpm.command,
        name,
    });
}

export function createCommonCiSteps(platform = process.platform) {
    const pnpmStep = createPnpmStepFactory(platform);
    return [
        pnpmStep("Script tests", ["test:scripts"]),
        pnpmStep("Lint", ["lint"]),
        pnpmStep("Build", ["build"]),
        pnpmStep("Typecheck", ["typecheck"]),
        { args: ["test", "--locked", "--workspace"], command: "cargo", name: "Rust workspace tests" },
        pnpmStep("Worker tmux contract tests", ["test:worker:tmux"]),
        pnpmStep("Prepare test Worker", ["test:prepare"]),
        pnpmStep("Package tests", ["test:packages"]),
    ];
}

export function createPlatformContractCiSteps(platform = process.platform) {
    if (platform === "win32") {
        throw new Error("Platform contract CI requires a Unix host.");
    }
    const pnpmStep = createPnpmStepFactory(platform);
    return [
        { args: ["test", "--locked", "--workspace"], command: "cargo", name: "Rust workspace tests" },
        pnpmStep("Worker tmux contract tests", ["test:worker:tmux"]),
        pnpmStep("Prepare test Worker", ["test:prepare"]),
        pnpmStep("Package tests", ["test:packages"]),
    ];
}

export function createTargetCiSteps(target, platform = process.platform) {
    if (typeof target !== "string" || target.length === 0) {
        throw new Error("A native target is required.");
    }
    const pnpmStep = createPnpmStepFactory(platform);
    const worker = join(
        "ci-artifacts",
        `devshell-worker-${target}${platform === "win32" ? ".exe" : ""}`,
    );
    const application = join("ci-artifacts", `portable-devshell-app-${target}.tar.gz`);
    const steps = [
        pnpmStep("Build", ["build"]),
        pnpmStep("Build native Worker", ["build:worker", target, "--output-dir", "./ci-artifacts"]),
    ];

    if (platform === "win32") {
        // Windows runtime behavior remains outside the release gate because PowerShell/ConPTY
        // interaction is not deterministic enough to provide a useful runtime proof. The target
        // job still builds the complete JS application and the native Worker on both Windows
        // architectures, then packages the exact release asset.
        steps.push(
            pnpmStep("Package native application", ["package:app", "--", "--target", target, "--output-dir", "./ci-artifacts"]),
        );
        return steps;
    }

    steps.push(
        { args: ["./scripts/smoke-worker.mjs", worker], command: process.execPath, name: "Worker daemon smoke" },
        { args: ["./scripts/smoke-reverse-worker.mjs", worker], command: process.execPath, name: "Reverse worker PTY smoke" },
        { args: ["./scripts/smoke-client.mjs", worker], command: process.execPath, name: "Client and local instance smoke" },
        pnpmStep("Package native application", ["package:app", "--", "--target", target, "--output-dir", "./ci-artifacts"]),
        pnpmStep("Application package smoke", ["smoke:package", "--", application]),
        pnpmStep("Unix release installer smoke", ["smoke:install-release", "--", application]),
    );

    if (target === "linux-x64") {
        steps.push({
            args: [
                "-lc",
                "set -o pipefail; node acceptance/run-final-acceptance.mjs --integration-only 2>&1 | tee acceptance.log",
            ],
            command: "bash",
            env: {
                PORTABLE_DEVSHELL_TEST_WORKER_PATH: worker,
            },
            name: "Final integration",
        });
    }
    return steps;
}

export function createDevelopmentCiSteps(target, platform = process.platform) {
    const targetSteps = createTargetCiSteps(target, platform);
    if (platform === "win32") {
        const pnpmStep = createPnpmStepFactory(platform);
        return [
            pnpmStep("Lint", ["lint"]),
            pnpmStep("Typecheck", ["typecheck"]),
            ...targetSteps,
        ];
    }
    return [...createCommonCiSteps(platform), ...targetSteps];
}

export function runCommonCi(options = {}) {
    const { platform = process.platform, ...runOptions } = options;
    return runCiSteps(createCommonCiSteps(platform), runOptions);
}

export function runPlatformContractCi(options = {}) {
    const { platform = process.platform, ...runOptions } = options;
    return runCiSteps(createPlatformContractCiSteps(platform), runOptions);
}

export function runTargetCi(target, options = {}) {
    const { platform = process.platform, ...runOptions } = options;
    return runCiSteps(createTargetCiSteps(target, platform), runOptions);
}

export function runDevelopmentCi(target, options = {}) {
    const { platform = process.platform, ...runOptions } = options;
    return runCiSteps(createDevelopmentCiSteps(target, platform), runOptions);
}

function executeCiStep(step) {
    const result = spawnSync(step.command, step.args, {
        env: step.env === undefined ? process.env : { ...process.env, ...step.env },
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
    const [mode, target] = process.argv.slice(2);
    let result;
    if (mode === "--common") {
        result = runCommonCi();
    } else if (mode === "--platform-contract") {
        result = runPlatformContractCi();
    } else if (mode === "--target") {
        result = runTargetCi(target);
    } else {
        result = runDevelopmentCi(mode);
    }
    if (!result.ok) {
        process.exitCode = 1;
    }
}
