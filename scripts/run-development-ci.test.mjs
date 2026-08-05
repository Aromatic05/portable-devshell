import assert from "node:assert/strict";
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
