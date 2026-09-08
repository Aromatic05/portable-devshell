import assert from "node:assert/strict";
import test from "node:test";

import {
    parseAgentWorkerTarget,
    renderAgentWorkerTarget
} from "../../src/worker/AgentWorkerTarget.ts";

test("Agent target binds one Worker instance to its remote workspace", () => {
    const target = parseAgentWorkerTarget("worker-instance:/home/user/project");

    assert.equal(target.instance, "worker-instance");
    assert.equal(target.workspace, "/home/user/project");
    assert.equal(renderAgentWorkerTarget(target), "worker-instance:/home/user/project");
});

test("Agent target preserves colons inside the remote workspace", () => {
    const target = parseAgentWorkerTarget("windows-worker:C:\\work\\project");

    assert.equal(target.instance, "windows-worker");
    assert.equal(target.workspace, "C:\\work\\project");
});

test("Agent target rejects malformed instance/workspace pairs", () => {
    for (const value of ["", "worker-only", ":/repo", "worker:", "bad worker:/repo", " worker:/repo"]) {
        assert.throws(() => parseAgentWorkerTarget(value), TypeError);
    }
});
