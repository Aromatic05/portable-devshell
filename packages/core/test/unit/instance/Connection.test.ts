import assert from "node:assert/strict";
import test from "node:test";

import { Instance } from "../../../src/instance/model/Instance.ts";

function createInstance(events: string[]): Instance {
    return new Instance({
        config: { name: "worker-a" } as never,
        eventLog: { async flush() {} } as never,
        state: {
            async close() {},
            async prepareRetirement() {
                events.push("prepare");
            },
            async retire() {
                events.push("retire");
            },
        } as never,
        subscriptions: { close() {} } as never,
        worker: {} as never,
    });
}

test("instance retirement drains each lease before retiring its generation", async () => {
    const events: string[] = [];
    const current = createInstance(events);
    const mcp = current.lifecycle.acquireLease();
    const agent = current.lifecycle.acquireLease();

    assert.equal(mcp.instance, current);
    assert.equal(agent.instance, current);
    const retirement = current.retire();
    await Promise.resolve();
    assert.deepEqual(events, ["prepare"]);

    mcp.release();
    mcp.release();
    await Promise.resolve();
    assert.deepEqual(events, ["prepare"]);

    agent.release();
    await retirement;
    assert.deepEqual(events, ["prepare", "retire"]);
    assert.equal(current.lifecycle.retired, true);
});
