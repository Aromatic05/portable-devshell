import assert from "node:assert/strict";
import test from "node:test";

import { createIntegrationSteps } from "../acceptance/run-final-acceptance.mjs";

test("Linux final integration includes the real long tmux handoff smoke", () => {
    const names = createIntegrationSteps({ env: {} }, "linux").map((step) => step.name);
    assert.deepEqual(names, [
        "Resolve prepared Worker",
        "Real Worker smoke",
        "MCP smoke",
        "Long tmux handoff smoke",
        "Web browser smoke",
    ]);
});

test("Windows final integration omits the tmux-only long handoff smoke", () => {
    const names = createIntegrationSteps({ env: {} }, "win32").map((step) => step.name);
    assert.equal(names.includes("Long tmux handoff smoke"), false);
});
