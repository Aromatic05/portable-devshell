import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentToolSessionInstance } from "../../src/composition/runtime/ControlRuntimeAgent.js";

test("agent tool sessions prefer the unique enabled local instance", () => {
    assert.equal(resolveAgentToolSessionInstance([
        { enabled: true, name: "remote-a", provider: "reverse" },
        { enabled: true, name: "local-a", provider: "local" },
        { enabled: true, name: "remote-b", provider: "ssh" }
    ]), "local-a");
});

test("agent tool sessions fall back to the only enabled instance", () => {
    assert.equal(resolveAgentToolSessionInstance([
        { enabled: false, name: "local-disabled", provider: "local" },
        { enabled: true, name: "remote-a", provider: "reverse" }
    ]), "remote-a");
});

test("agent tool sessions require an explicit target when selection is ambiguous", () => {
    assert.throws(
        () => resolveAgentToolSessionInstance([
            { enabled: true, name: "remote-a", provider: "reverse" },
            { enabled: true, name: "remote-b", provider: "ssh" }
        ]),
        /Multiple devshell instances are configured without one unique local instance/
    );
});
