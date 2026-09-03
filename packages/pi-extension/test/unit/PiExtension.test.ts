import assert from "node:assert/strict";
import test from "node:test";

import {
    parseDevshellAgentTarget,
    resolveToolSessionOpenInput
} from "../../src/index.ts";

test("Pi devshell target parser preserves remote workspace syntax", () => {
    assert.deepEqual(
        parseDevshellAgentTarget("worker-a:/srv/project"),
        { instance: "worker-a", workspace: "/srv/project" }
    );
    assert.deepEqual(
        parseDevshellAgentTarget("windows-worker:C:\\repo"),
        { instance: "windows-worker", workspace: "C:\\repo" }
    );
});

test("Pi devshell target parser rejects ambiguous bindings", () => {
    for (const value of ["", " worker:/repo", "worker", ":/repo", "bad name:/repo", "worker:"]) {
        assert.throws(() => parseDevshellAgentTarget(value));
    }
});

test("Pi devshell extension leaves unique instance selection to Control", () => {
    assert.deepEqual(
        resolveToolSessionOpenInput({ cwd: "/repo", environment: {} }),
        { workspace: "/repo" }
    );
    assert.deepEqual(
        resolveToolSessionOpenInput({ cwd: "/ignored", environment: {}, target: "worker-a:/srv/project" }),
        { instance: "worker-a", workspace: "/srv/project" }
    );
});
