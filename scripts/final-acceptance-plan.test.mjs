import assert from "node:assert/strict";
import test from "node:test";

import { createIntegrationSteps } from "../acceptance/run-final-acceptance.mjs";

test("final integration includes the persistent-task long handoff smoke", () => {
    const names = createIntegrationSteps({ env: {} }).map((step) => step.name);
    assert.deepEqual(names, [
        "Resolve prepared Worker",
        "Real Worker smoke",
        "MCP smoke",
        "Long tmux handoff smoke",
        "Web browser smoke",
    ]);
});
