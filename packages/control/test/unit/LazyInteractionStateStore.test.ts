import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { ContextMessageState } from "../../src/instance/context/ContextMessageState.ts";
import { ContextMessageStore } from "../../src/instance/context/ContextMessageStore.ts";
import { GoalState } from "../../src/instance/goal/GoalState.ts";
import { GoalStore } from "../../src/instance/goal/GoalStore.ts";
import { TodoState } from "../../src/instance/todo/TodoState.ts";
import { TodoStore } from "../../src/instance/todo/TodoStore.ts";
import { WaitState } from "../../src/instance/wait/WaitState.ts";
import { WaitStore } from "../../src/instance/wait/WaitStore.ts";

test("interaction state stores defer persisted state loading until first access", async () => {
    const root = await createTestTempDirectory("lazy-interaction-state-");
    const files = {
        context: join(root, "context-messages.json"),
        goal: join(root, "goals.json"),
        todo: join(root, "todo.json"),
        wait: join(root, "waits.json"),
    };
    await Promise.all(Object.values(files).map(async (path) => await writeFile(path, "not-json\n", "utf8")));

    const context = new ContextMessageStore({
        filePath: files.context,
        instanceName: "alpha",
        state: new ContextMessageState(),
    });
    const goal = new GoalStore({ filePath: files.goal, instanceName: "alpha", state: new GoalState() });
    const todo = new TodoStore({ filePath: files.todo, instanceName: "alpha", state: new TodoState("alpha") });
    const wait = new WaitStore({ filePath: files.wait, instanceName: "alpha", state: new WaitState() });

    assert.throws(() => context.read(), /Context message state for alpha is invalid/u);
    assert.throws(() => goal.read(), /Goal state for alpha is invalid/u);
    assert.throws(() => todo.read(), /Todo state for alpha is invalid/u);
    assert.throws(() => wait.read(), /Wait state for alpha is invalid/u);
});
