import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { GoalState } from "../../../../src/task/goal/storage/State.ts";
import { GoalStore } from "../../../../src/task/goal/storage/index.ts";
import { WaitService } from "../../../../src/task/wait/index.ts";

test("GoalStore defers loading while WaitService validates on creation", async () => {
    const root = await createTestTempDirectory("lazy-interaction-state-");
    const files = {
        goal: join(root, "goals.json"),
        wait: join(root, "waits.json"),
    };
    await Promise.all(
        Object.values(files).map(
            async (path) => await writeFile(path, "not-json\n", "utf8"),
        ),
    );

    const goal = new GoalStore({
        filePath: files.goal,
        instanceName: "alpha",
        state: new GoalState(),
    });
    assert.throws(
        () =>
            new WaitService({
                appendEvent: async () => undefined,
                filePath: files.wait,
                invoke: { invoke: async () => ({}) },
            }),
        /not valid JSON/u,
    );

    assert.throws(() => goal.read(), /Goal state for alpha is invalid/u);
});
