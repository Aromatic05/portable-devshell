import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDevTagGate } from "./run-dev-tag-gate.mjs";
import {
    createCommonCiSteps,
    createDevelopmentCiSteps,
    createPlatformContractCiSteps,
    createTargetCiSteps,
    runCiSteps,
    runDevelopmentCi,
} from "./run-development-ci.mjs";

test("development CI runs every step before reporting aggregate failure", () => {
    const invoked = [];
    const result = runCiSteps(
        [
            { args: [], command: "first", name: "first" },
            { args: [], command: "second", name: "second" },
            { args: [], command: "third", name: "third" },
        ],
        {
            execute(step) {
                invoked.push(step.name);
                return { status: step.name === "second" ? 7 : 0 };
            },
            log() {},
        },
    );

    assert.deepEqual(invoked, ["first", "second", "third"]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, [{ name: "second", status: 7 }]);
});

test("development CI continues after an executor throws", () => {
    const invoked = [];
    const result = runCiSteps(
        [{ name: "first" }, { name: "second" }, { name: "third" }],
        {
            execute(step) {
                invoked.push(step.name);
                if (step.name === "second") {
                    throw new Error("boom");
                }
                return { status: 0 };
            },
            log() {},
        },
    );

    assert.deepEqual(invoked, ["first", "second", "third"]);
    assert.deepEqual(result.failures, [{ name: "second", status: 1 }]);
});

test("common CI owns source correctness without rebuilding release assets", () => {
    const names = createCommonCiSteps("linux").map((step) => step.name);
    assert.deepEqual(names, [
        "Script tests",
        "Lint",
        "Build",
        "Typecheck",
        "Rust workspace tests",
        "Worker tmux contract tests",
        "Prepare test Worker",
        "Package tests",
    ]);
    assert.equal(names.includes("Build native Worker"), false);
    assert.equal(names.includes("Package native application"), false);
});

test("Unix target CI proves the native deliverable without rerunning common correctness", () => {
    const names = createTargetCiSteps("darwin-x64", "darwin").map((step) => step.name);
    assert.deepEqual(names, [
        "Build",
        "Build native Worker",
        "Worker daemon smoke",
        "Reverse worker PTY smoke",
        "Client and local instance smoke",
        "Package native application",
        "Application package smoke",
        "Unix release installer smoke",
    ]);
    for (const commonOnly of ["Lint", "Typecheck", "Rust workspace tests", "Package tests"]) {
        assert.equal(names.includes(commonOnly), false);
    }
});

test("macOS platform contract retains OS-sensitive package Rust and tmux behavior on one architecture", () => {
    const names = createPlatformContractCiSteps("darwin").map((step) => step.name);
    assert.deepEqual(names, [
        "Rust workspace tests",
        "Worker tmux contract tests",
        "Prepare test Worker",
        "Package tests",
    ]);
});

test("Linux x64 target CI runs final integration without repeating unit gates", () => {
    const steps = createTargetCiSteps("linux-x64", "linux");
    const names = steps.map((step) => step.name);
    assert.equal(names.at(-1), "Final integration");
    assert.equal(names.includes("Final acceptance"), false);
    const integration = steps.at(-1);
    assert.equal(integration.command, "bash");
    assert.deepEqual(integration.args.slice(0, 1), ["-lc"]);
    assert.match(integration.args[1], /run-final-acceptance\.mjs --integration-only/u);
    assert.equal(integration.env.PORTABLE_DEVSHELL_TEST_WORKER_PATH, "ci-artifacts/devshell-worker-linux-x64");
});

test("Windows target CI keeps native build validation but omits runtime and common tests", () => {
    const directory = mkdtempSync(join(tmpdir(), "devshell-ci-plan-"));
    const pnpmCli = join(directory, "pnpm.cjs");
    writeFileSync(pnpmCli, "");
    const previous = process.env.PORTABLE_DEVSHELL_PNPM_CLI;
    process.env.PORTABLE_DEVSHELL_PNPM_CLI = pnpmCli;
    try {
        const names = createTargetCiSteps("windows-x64", "win32").map((step) => step.name);
        assert.deepEqual(names, [
            "Build",
            "Build native Worker",
            "Package native application",
        ]);
    } finally {
        if (previous === undefined) {
            delete process.env.PORTABLE_DEVSHELL_PNPM_CLI;
        } else {
            process.env.PORTABLE_DEVSHELL_PNPM_CLI = previous;
        }
        rmSync(directory, { force: true, recursive: true });
    }
});

test("development CI entrypoint executes the canonical target plan", () => {
    const invoked = [];
    const result = runDevelopmentCi("linux-x64", {
        execute(step) {
            invoked.push({ args: step.args, command: step.command, name: step.name });
            return { status: 0 };
        },
        log() {},
        platform: "linux",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
        invoked,
        createDevelopmentCiSteps("linux-x64", "linux").map((step) => ({
            args: step.args,
            command: step.command,
            name: step.name,
        })),
    );
});

test("local dev tag gate is a quick preflight rather than a second full CI run", () => {
    const invoked = [];
    const result = runDevTagGate({
        execute(step) {
            invoked.push({ args: step.args, command: step.command, name: step.name });
            return { status: step.name === "Development version" ? 23 : 0 };
        },
        log() {},
        platform: "linux",
    });

    assert.deepEqual(invoked.map((step) => step.name), ["Development version"]);
    assert.deepEqual(result.failures, [{ name: "Development version", status: 23 }]);
});
