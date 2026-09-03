import assert from "node:assert/strict";
import test from "node:test";

import { parseDevshellAgentTarget } from "../../src/index.ts";

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
