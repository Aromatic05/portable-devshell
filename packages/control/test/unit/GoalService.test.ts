import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { GoalService } from "../../src/instance/goal/GoalService.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("GoalService stopAll terminalizes every live Goal while preserving completed history", async () => {
    const root = await createTestTempDirectory("goal-stop-all");
    const events: string[] = [];
    const service = new GoalService({
        appendEvent: async (type) => { events.push(type); },
        filePath: join(root, "goals.json"),
        instanceName: "alpha",
    });
    await service.manage("ctx-active", {
        action: "start",
        objective: "Active goal",
        steps: [{ id: "active", text: "Continue" }],
    });
    await service.manage("ctx-blocked", {
        action: "start",
        objective: "Blocked goal",
        steps: [{ id: "blocked", text: "Wait" }],
    });
    await service.manage("ctx-blocked", { action: "block", note: "Need input" });
    await service.manage("ctx-completed", {
        action: "start",
        objective: "Completed goal",
        steps: [{ id: "done", status: "completed", text: "Done" }],
    });

    const stopped = await service.stopAll();

    assert.deepEqual(stopped.map((goal) => goal.status), ["stopped", "stopped"]);
    assert.equal((await service.read("ctx-active"))?.status, "stopped");
    assert.equal((await service.read("ctx-blocked"))?.status, "stopped");
    assert.equal((await service.read("ctx-completed"))?.status, "completed");
    assert.equal(events.filter((type) => type === "goal.updated").length >= 2, true);
});
