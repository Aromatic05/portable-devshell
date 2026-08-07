import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDevelopmentCiSteps, runCiSteps } from "./run-development-ci.mjs";

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

test("development CI passes explicit script test paths without shell glob expansion", () => {
    const step = createDevelopmentCiSteps("linux-arm64", "linux")
        .find((candidate) => candidate.name === "Script tests");

    assert.ok(step);
    assert.equal(step.args.includes("./scripts/*.test.mjs"), false);
    assert.equal(step.args.some((argument) => argument.endsWith(".test.mjs")), true);
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


test("development CI validates reverse PTY with the built native worker", () => {
    const directory = mkdtempSync(join(tmpdir(), "pds-pnpm-cli-"));
    const pnpmCli = join(directory, "pnpm.cjs");
    writeFileSync(pnpmCli, "", "utf8");
    const previous = process.env.PORTABLE_DEVSHELL_PNPM_CLI;
    process.env.PORTABLE_DEVSHELL_PNPM_CLI = pnpmCli;
    try {
        const steps = createDevelopmentCiSteps("windows-x64", "win32");
        const buildIndex = steps.findIndex((step) => step.name === "Build native Worker");
        const reverseIndex = steps.findIndex((step) => step.name === "Reverse worker PTY smoke");
        const packageIndex = steps.findIndex((step) => step.name === "Package native application");

        assert.ok(buildIndex >= 0);
        assert.ok(reverseIndex > buildIndex);
        assert.ok(packageIndex > reverseIndex);
        assert.match(steps[reverseIndex].args.at(-1), /devshell-worker-windows-x64\.exe$/u);
    } finally {
        if (previous === undefined) delete process.env.PORTABLE_DEVSHELL_PNPM_CLI;
        else process.env.PORTABLE_DEVSHELL_PNPM_CLI = previous;
        rmSync(directory, { force: true, recursive: true });
    }
});
