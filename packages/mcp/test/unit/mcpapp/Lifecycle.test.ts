import assert from "node:assert/strict";
import test from "node:test";
import { McpAppRuntime } from "../../../src/mcpapp/index.ts";

test("terminal Context cleanup retries failed Receipt revocation without Control owning a queue", async () => {
    const app = new McpAppRuntime({});
    await app.initialize();
    const token = await app.leases.issue("demo", "ctx-retired");
    await app.actions.prepareOnce("ctx-retired", "demo", {
        actionId: "receipt-retired", itemId: "task-one", instance: "demo", operation: "goal-pause", targetId: "task-one",
    });
    const originalRevoke = app.actions.revokeContext.bind(app.actions);
    let attempts = 0;
    app.actions.revokeContext = async (ctxId) => {
        attempts++;
        if (attempts === 1) throw new Error("simulated persistent receipt storage failure");
        await originalRevoke(ctxId);
    };
    const initialWarn = console.warn;
    console.warn = () => undefined;
    try {
        app.presence.open("demo", "ctx-retired");
        app.onContextTerminated("ctx-retired");
        assert.equal(app.presence.has("demo", "ctx-retired"), false);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(attempts, 1);
        assert.ok(await app.actions.get("receipt-retired"));
        assert.equal(await app.leases.verify("demo", "ctx-retired", token), false);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.ok(attempts >= 2, "the App Domain must retry without another Control event");
        assert.equal(await app.actions.get("receipt-retired"), undefined);
        await app.flushContextCleanup();
    } finally {
        console.warn = initialWarn;
        await app.close();
    }
});
