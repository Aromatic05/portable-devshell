import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDevTagGate } from "./run-dev-tag-gate.mjs";
import {
    createDevelopmentCiSteps,
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

test("Windows development CI keeps build validation but omits runtime tests", () => {
    const directory = mkdtempSync(join(tmpdir(), "devshell-ci-plan-"));
    const pnpmCli = join(directory, "pnpm.cjs");
    writeFileSync(pnpmCli, "");
    const previous = process.env.PORTABLE_DEVSHELL_PNPM_CLI;
    process.env.PORTABLE_DEVSHELL_PNPM_CLI = pnpmCli;
    try {
        const names = createDevelopmentCiSteps("windows-x64", "win32").map((step) => step.name);
        assert.deepEqual(names, [
            "Lint",
            "Build",
            "Typecheck",
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

test("local dev tag gate is exactly the Linux x64 development CI gate", () => {
    const invoked = [];
    const result = runDevTagGate({
        arch: "x64",
        execute(step) {
            invoked.push({ args: step.args, command: step.command, name: step.name });
            return { status: step.name === "Worker daemon smoke" ? 23 : 0 };
        },
        log() {},
        platform: "linux",
    });

    assert.deepEqual(
        invoked,
        createDevelopmentCiSteps("linux-x64", "linux").map((step) => ({
            args: step.args,
            command: step.command,
            name: step.name,
        })),
    );
    assert.deepEqual(result.failures, [{ name: "Worker daemon smoke", status: 23 }]);
});

test("local dev tag gate refuses hosts that cannot reproduce Linux x64 CI", () => {
    assert.throws(
        () => runDevTagGate({ arch: "arm64", execute() { throw new Error("must not execute"); }, platform: "linux" }),
        /Linux x64/u,
    );
});
